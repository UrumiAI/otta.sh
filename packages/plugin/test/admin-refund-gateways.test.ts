/**
 * Admin refunds reach a payment gateway (issue #303).
 *
 * `InProcessAdminOrdersClient` used to hard-code an EMPTY gateway map, so every
 * refund — including a manual, off-platform one — answered `409
 * REFUND_GATEWAY_UNAVAILABLE` and a merchant could record no refund at all. The
 * admin composition root now resolves the gateways exactly as the commerce one
 * does (`resolvePaymentGateways`), and these cases pin the three outcomes that
 * matter, over a REAL document store:
 *
 *  - a configured Stripe deployment moves money: ONE `POST /v1/refunds`, carrying
 *    the refund's idempotency key as Stripe's native `Idempotency-Key`, and a
 *    replay of the same key makes NO second call;
 *  - a non-refundable gateway (x402) still RECORDS a manual refund;
 *  - an unconfigured deployment stays fail-closed: `409
 *    REFUND_GATEWAY_UNAVAILABLE`, and nothing reaches the network.
 *
 * The Stripe side is a RECORDING fake transport on `ctx.http.fetch` — the same
 * seam the live gateway uses — answering the two calls a refund makes (the
 * pre-flight read of the PaymentIntent's latest charge, then the create).
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	type PaymentMethod,
} from "@otta-sh/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import { makeAdminClients } from "../src/admin/make-admin-clients.js";
import { STRIPE_SECRET_KEY_KEY, STRIPE_WEBHOOK_SECRET_KEY } from "../src/payment-secrets.js";
import { wireX402Gateway } from "../src/payments/x402-wiring.js";
import type { PluginContext } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const TOTAL_CENTS = 1500;

interface RecordedCall {
	method: string;
	url: string;
	idempotencyKey: string | null;
	body: string | null;
}

/**
 * A fake Stripe that records every call and answers the two a refund makes. It
 * tracks `amount_refunded` itself, so the gateway's pre-flight sees the money
 * the previous refund moved — the same view the real API would give.
 */
function fakeStripe(): { fetch: PluginContext["http"]["fetch"]; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let refunded = 0;
	let seq = 0;
	return {
		calls,
		async fetch(url, init) {
			const method = init?.method ?? "GET";
			const headers = new Headers(init?.headers);
			const body = typeof init?.body === "string" ? init.body : null;
			calls.push({ method, url, idempotencyKey: headers.get("idempotency-key"), body });
			const path = new URL(url).pathname;
			if (method === "GET" && path.startsWith("/v1/payment_intents/")) {
				return Response.json({
					id: path.split("/").at(-1),
					latest_charge: {
						amount_refunded: refunded,
						amount_captured: TOTAL_CENTS,
						currency: "usd",
					},
				});
			}
			if (method === "POST" && path === "/v1/refunds") {
				const amount = Number(new URLSearchParams(body ?? "").get("amount"));
				refunded += amount;
				seq += 1;
				return Response.json({ id: `re_test_${String(seq)}`, amount, currency: "usd" });
			}
			return Response.json({ error: { code: "unexpected_call" } }, { status: 400 });
		},
	};
}

let harness: InProcessCommerceHarness;
let seq = 0;

beforeAll(async () => {
	harness = await makeInProcessCommerce();
});

afterAll(async () => {
	await harness?.close();
});

beforeEach(async () => {
	await harness.reset();
	// `reset()` empties the document store, not kv — and the secrets live in kv.
	await harness.ctx.kv.delete(STRIPE_SECRET_KEY_KEY);
	await harness.ctx.kv.delete(STRIPE_WEBHOOK_SECRET_KEY);
});

/** A paid order with one SUCCEEDED capture of the whole total. */
async function seedCapturedOrder(paymentMethod: PaymentMethod): Promise<string> {
	seq += 1;
	const id = `rg-order-${String(seq)}`;
	const { orderStore } = harness.stores;
	await orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`rg-create-${String(seq)}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: `rg-${String(seq)}@example.test`,
		paymentMethod,
		lines: [
			{
				productId: toProductId(`rg-prod-${String(seq)}`),
				sku: toSku(`RG-SKU-${String(seq)}`),
				title: "Linen apron",
				unitPrice: cents(TOTAL_CENTS),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(TOTAL_CENTS), total: cents(TOTAL_CENTS), currency: currency("USD") },
	});
	await orderStore.markPaid(toOrderId(id));
	await orderStore.recordPayment({
		orderId: toOrderId(id),
		gateway: paymentMethod,
		providerRef: `pi_test_${String(seq)}`,
		amount: cents(TOTAL_CENTS),
		currency: currency("USD"),
		status: "succeeded",
	});
	return id;
}

/** The harness's context with its own kv, and `http` swapped for `fetch`. */
function ctxWith(fetch: PluginContext["http"]["fetch"]): PluginContext {
	return { ...harness.ctx, http: { fetch } };
}

const REFUND = { amountCents: 500, currency: "USD", refundedBy: "ops@example.test" };

describe("admin refunds through makeAdminClients", () => {
	test("a configured Stripe refund makes exactly ONE POST /v1/refunds carrying the key, and a replay makes none", async () => {
		await harness.ctx.kv.set(STRIPE_SECRET_KEY_KEY, "sk_test_refunds");
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, "whsec_refunds");
		const stripe = fakeStripe();
		const { orders } = await makeAdminClients(ctxWith(stripe.fetch));
		const id = await seedCapturedOrder("stripe");

		// The panel is honest about the capability before anything moves.
		expect(await orders.getRefunds(id)).toMatchObject({ refundable: true, remainingCents: 1500 });

		const first = await orders.refundOrder(id, REFUND, { idempotencyKey: "rg-refund-1" });
		expect(first).toEqual({ ok: true, recorded: true, duplicate: false, fullyRefunded: false });

		const creates = stripe.calls.filter((c) => c.method === "POST");
		expect(creates).toHaveLength(1);
		expect(creates[0]).toMatchObject({
			url: "https://api.stripe.com/v1/refunds",
			idempotencyKey: "rg-refund-1",
		});
		expect(new URLSearchParams(creates[0]?.body ?? "").get("amount")).toBe("500");

		// THE REPLAY: same key, same refund — the ledger answers it, the provider is
		// not asked again.
		const callsBefore = stripe.calls.length;
		const replay = await orders.refundOrder(id, REFUND, { idempotencyKey: "rg-refund-1" });
		expect(replay).toEqual({ ok: true, recorded: false, duplicate: true, fullyRefunded: false });
		expect(stripe.calls).toHaveLength(callsBefore);

		expect(await orders.getRefunds(id)).toMatchObject({
			refundedTotalCents: 500,
			remainingCents: 1000,
		});
		expect((await orders.getRefunds(id))?.refunds).toHaveLength(1);
	});

	test("an unconfigured deployment stays FAIL-CLOSED: 409 REFUND_GATEWAY_UNAVAILABLE, and no request", async () => {
		const stripe = fakeStripe();
		const { orders } = await makeAdminClients(ctxWith(stripe.fetch));
		const id = await seedCapturedOrder("stripe");

		expect(await orders.getRefunds(id)).toMatchObject({ refundable: false });
		expect(await orders.refundOrder(id, REFUND, { idempotencyKey: "rg-refund-off" })).toEqual({
			ok: false,
			status: 409,
			reason: "REFUND_GATEWAY_UNAVAILABLE",
		});
		expect(stripe.calls).toEqual([]);
		expect((await orders.getRefunds(id))?.refunds).toEqual([]);
	});
});

describe("a manual (off-platform) refund", () => {
	test("is RECORDED against a non-refundable gateway, with no provider call", async () => {
		const stripe = fakeStripe();
		const x402 = wireX402Gateway({
			fetch: stripe.fetch,
			facilitatorUrl: "https://facilitator.example.test",
			payTo: "0x1111111111111111111111111111111111111111",
		});
		expect(x402?.refundable).toBe(false);
		const orders = new InProcessAdminOrdersClient(harness.ctx, {
			gateways: x402 === undefined ? {} : { x402 },
		});
		const id = await seedCapturedOrder("x402");

		expect(await orders.getRefunds(id)).toMatchObject({ refundable: false, remainingCents: 1500 });
		expect(await orders.refundOrder(id, REFUND, { idempotencyKey: "rg-manual-1" })).toEqual({
			ok: true,
			recorded: true,
			duplicate: false,
			fullyRefunded: false,
		});
		const summary = await orders.getRefunds(id);
		expect(summary?.refunds).toHaveLength(1);
		expect(summary?.refunds[0]).toMatchObject({ kind: "manual", amountCents: 500 });
		expect(stripe.calls).toEqual([]);
	});
});
