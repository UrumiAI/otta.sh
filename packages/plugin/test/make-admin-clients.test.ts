/**
 * `makeAdminClients` — the admin composition root — wires the SAME payment
 * gateways `makeCommerceClient` does into the admin orders client (issue #303).
 *
 * Before this, the admin orders client was built with no gateways at all, so
 * every refund from the console — a Stripe refund and a manual, off-platform one
 * alike — answered `409 REFUND_GATEWAY_UNAVAILABLE`, while checkout on the same
 * deployment was taking live Stripe payments.
 *
 * WHAT IS REAL HERE. The document store is the real one (in-memory SQLite, the
 * host's migrations) and the gateway is the real `StripePaymentGateway`, armed
 * from kv by `stripeGatewayFromCtx` exactly as in production. The only stand-in
 * is Stripe itself: `ctx.http.fetch` is a recording fake that answers the two
 * requests a refund makes (the pre-flight read and `POST /v1/refunds`). That the
 * requests go through `ctx.http` and nowhere else is the sandbox rule, and it is
 * what this fake observes. The same path is driven inside workerd, against a
 * Stripe API stub, in `orders-actions.sandbox.test.ts`.
 */
import { orderId as toOrderId } from "@otta-sh/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { makeAdminClients } from "../src/admin/make-admin-clients.js";
import { STRIPE_SECRET_KEY_KEY, STRIPE_WEBHOOK_SECRET_KEY } from "../src/payment-secrets.js";
import type { PluginContext } from "../src/types.js";
import { sharedTierSeeders } from "./helpers/commerce-tier-arrange.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

interface RecordedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
}

/** A kv the test can seed, over the harness's own. */
function withKv(ctx: PluginContext, seed: Record<string, string>): PluginContext {
	const store = new Map<string, unknown>(Object.entries(seed));
	return {
		...ctx,
		kv: {
			async get<T>(key: string): Promise<T | null> {
				return store.has(key) ? (store.get(key) as T) : null;
			},
			async set(key: string, value: unknown): Promise<void> {
				store.set(key, value);
			},
			async delete(key: string): Promise<boolean> {
				return store.delete(key);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...store].map(([key, value]) => ({ key, value }));
			},
		},
	};
}

describe("makeAdminClients wires the payment gateways into admin refunds", () => {
	let harness: InProcessCommerceHarness;
	let requests: RecordedRequest[];
	/** Stripe's view of the one PaymentIntent every order here is paid with. */
	let amountRefunded: number;
	let seq = 0;

	/** A recording Stripe: the pre-flight read answers the live refunded/captured
	 *  view, and `POST /v1/refunds` answers a refund and moves `amount_refunded`. */
	function stripeHttp(): PluginContext["http"] {
		return {
			async fetch(url: string, init?: RequestInit): Promise<Response> {
				const headers: Record<string, string> = {};
				new Headers(init?.headers).forEach((value, name) => {
					headers[name] = value;
				});
				const body = typeof init?.body === "string" ? init.body : "";
				requests.push({ method: init?.method ?? "GET", url, headers, body });
				if (url.startsWith("https://api.stripe.com/v1/payment_intents/")) {
					return Response.json({
						id: "pi",
						latest_charge: {
							amount_refunded: amountRefunded,
							amount_captured: 1500,
							currency: "usd",
						},
					});
				}
				if (url === "https://api.stripe.com/v1/refunds" && init?.method === "POST") {
					const amount = Number(new URLSearchParams(body).get("amount"));
					amountRefunded += amount;
					return Response.json({
						id: `re_${String(requests.length)}`,
						amount,
						currency: "usd",
						status: "succeeded",
					});
				}
				return Response.json({ error: { message: "unexpected" } }, { status: 404 });
			},
		};
	}

	async function seedPaidOrder(): Promise<string> {
		seq += 1;
		const id = `mac-o-${String(seq)}`;
		await sharedTierSeeders({
			orderStore: harness.stores.orderStore,
			addressStore: harness.stores.addressStore,
			sessionStore: harness.stores.sessionStore,
			shippingRules: harness.stores.shippingRules,
			couponStore: harness.stores.couponStore,
			taxRules: harness.stores.taxRules,
		}).order({
			orderId: id,
			buyerRef: `${id}@example.test`,
			captured: { amountCents: 1500, providerRef: `pi_${id.replaceAll("-", "_")}` },
		});
		return id;
	}

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
	}, 120_000);
	beforeEach(() => {
		requests = [];
		amountRefunded = 0;
	});
	afterAll(async () => {
		await harness.close();
	});

	test("with Stripe configured, a console refund goes to Stripe over ctx.http ONCE, carrying its idempotency key", async () => {
		const ctx = withKv(
			{ ...harness.ctx, http: stripeHttp() },
			{ [STRIPE_SECRET_KEY_KEY]: "sk_test_MAC", [STRIPE_WEBHOOK_SECRET_KEY]: "whsec_MAC" },
		);
		const { orders } = await makeAdminClients(ctx);
		const id = await seedPaidOrder();
		const providerRef = `pi_${id.replaceAll("-", "_")}`;

		expect(await orders.getRefunds(id)).toMatchObject({ refundable: true, remainingCents: 1500 });
		expect(
			await orders.refundOrder(
				id,
				{ amountCents: 500, currency: "USD", refundedBy: "ops@example.test" },
				{ idempotencyKey: `${id}-r1` },
			),
		).toEqual({ ok: true, recorded: true, duplicate: false, fullyRefunded: false });

		const posts = requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(1);
		expect(posts[0]?.url).toBe("https://api.stripe.com/v1/refunds");
		expect(posts[0]?.headers["idempotency-key"]).toBe(`${id}-r1`);
		expect(Object.fromEntries(new URLSearchParams(posts[0]?.body))).toEqual({
			payment_intent: providerRef,
			amount: "500",
		});
		const [row] = (await orders.getRefunds(id))?.refunds ?? [];
		expect(row).toMatchObject({ kind: "gateway", gateway: "stripe", amountCents: 500 });
		expect(row?.refundRef).toMatch(/^re_/);

		// THE REPLAY: the same key answers from the ledger, and Stripe is not asked
		// again — no second POST, and not even a second pre-flight read.
		const before = requests.length;
		expect(
			await orders.refundOrder(
				id,
				{ amountCents: 500, currency: "USD", refundedBy: "ops@example.test" },
				{ idempotencyKey: `${id}-r1` },
			),
		).toEqual({ ok: true, recorded: false, duplicate: true, fullyRefunded: false });
		expect(requests.length).toBe(before);
	});

	test("with NO Stripe secrets, refunds stay fail-closed: 409 REFUND_GATEWAY_UNAVAILABLE and no egress", async () => {
		const ctx = withKv({ ...harness.ctx, http: stripeHttp() }, {});
		const { orders } = await makeAdminClients(ctx);
		const id = await seedPaidOrder();

		expect(await orders.getRefunds(id)).toMatchObject({ refundable: false });
		expect(
			await orders.refundOrder(
				id,
				{ amountCents: 500, currency: "USD", refundedBy: "ops@example.test" },
				{ idempotencyKey: `${id}-r1` },
			),
		).toEqual({ ok: false, status: 409, reason: "REFUND_GATEWAY_UNAVAILABLE" });
		expect(requests).toEqual([]);
		expect(await harness.stores.orderStore.listRefunds(toOrderId(id))).toEqual([]);
	});

	test("a ceiling refusal never reaches Stripe", async () => {
		const ctx = withKv(
			{ ...harness.ctx, http: stripeHttp() },
			{ [STRIPE_SECRET_KEY_KEY]: "sk_test_MAC", [STRIPE_WEBHOOK_SECRET_KEY]: "whsec_MAC" },
		);
		const { orders } = await makeAdminClients(ctx);
		const id = await seedPaidOrder();
		expect(
			await orders.refundOrder(
				id,
				{ amountCents: 1501, currency: "USD", refundedBy: "ops@example.test" },
				{ idempotencyKey: `${id}-r1` },
			),
		).toEqual({ ok: false, status: 409, reason: "REFUND_EXCEEDS_TOTAL" });
		expect(requests).toEqual([]);
	});
});
