/**
 * Issue #382, review round 3: whether an order's payment carries a Stripe
 * Customer is decided by the ORDER — the `addressRequired` its checkout was
 * placed under, frozen in the creating insert — never re-read from the cached
 * account country when an intent is (re)created. So when the record of the first
 * intent is lost (`recordPaymentIntent` is best-effort) and the country moves
 * before the replay, the replay still sends Stripe the byte-identical request it
 * already holds under the checkout key — in both directions.
 *
 * Real document store (in-process harness) and the REAL Stripe gateway, over a
 * stub `fetch` that plays Stripe's native idempotency: a same-key request with
 * different parameters is a 400 `idempotency_error`, exactly as live.
 */
import { StripePaymentGateway } from "@otta-sh/payments-stripe";
import { EmdashOrderStore } from "@otta-sh/store-emdash";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

interface Call {
	path: string;
	key: string;
	body: string;
}

let india = false;
const calls: Call[] = [];
const held = new Map<string, { body: string; reply: unknown }>();
let n = 0;

const stubFetch = (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
	const path = new URL(String(target)).pathname;
	const key = new Headers(init?.headers).get("idempotency-key") ?? "";
	const body = typeof init?.body === "string" ? init.body : "";
	calls.push({ path, key, body });
	const previous = held.get(key);
	if (previous !== undefined) {
		return previous.body === body
			? new Response(JSON.stringify(previous.reply), { status: 200 })
			: new Response(JSON.stringify({ error: { type: "idempotency_error" } }), { status: 400 });
	}
	n += 1;
	const reply =
		path === "/v1/customers"
			? { id: `cus_${String(n)}` }
			: { id: `pi_${String(n)}`, client_secret: `pi_${String(n)}_secret` };
	held.set(key, { body, reply });
	return new Response(JSON.stringify(reply), { status: 200 });
}) as unknown as typeof fetch;

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	india = false;
	calls.length = 0;
	held.clear();
	if (harness === undefined) {
		harness = await makeInProcessCommerce({
			gateways: {
				stripe: new StripePaymentGateway({
					webhookSecret: "whsec_test",
					secretKey: "sk_test_51Snapshot",
					fetch: stubFetch,
					customerRequired: async () => india,
				}),
			},
			resolveAddressRequired: async () => india,
		});
	} else await harness.reset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.close();
});

let seq = 0;
async function digitalCart(): Promise<string> {
	seq += 1;
	const productId = `prod-snap-${String(seq)}`;
	const sku = `SKU-SNAP-${String(seq)}`;
	await harness.client.upsertProductCommerce(
		productId,
		{ sku, title: "Ebook", price: { amount: 1200, currency: "USD" }, productKind: "digital" },
		`seed-${productId}`,
	);
	await harness.client.activateProductCommerce(
		productId,
		`publish-${productId}`,
		"2026-01-01T00:00:00.000Z",
	);
	const { cartId } = await harness.client.createCart("USD");
	const added = await harness.client.addCartLine(cartId, sku, productId, 1, `add-${productId}`);
	if (!added.ok) throw new Error(added.reason);
	return cartId;
}

const ADDRESS = {
	name: "Asha Rao",
	line1: "12 Park Street",
	city: "Kolkata",
	postalCode: "700016",
	country: "IN",
};

function place(cartId: string, withAddress: boolean) {
	return harness.client.createOrder(
		{
			cartId,
			paymentMethod: "stripe",
			buyerRef: "asha@example.test",
			...(withAddress ? { shippingAddress: ADDRESS } : {}),
		},
		`checkout:${cartId}`,
	);
}

/** Lose the record of the next intent — the best-effort write fails. */
function loseTheIntentRecord() {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(EmdashOrderStore.prototype, "recordPaymentIntent").mockRejectedValueOnce(
		new Error("compare-and-set budget exhausted"),
	);
}

const intents = () => calls.filter((c) => c.path === "/v1/payment_intents");

describe("the intent record is lost, then the country moves — the replay is still byte-identical", () => {
	test("placed under no requirement (US), the country becomes IN: the replay sends no Customer and is accepted", async () => {
		const cartId = await digitalCart();
		loseTheIntentRecord();
		const first = await place(cartId, true);
		expect(first.ok).toBe(true);

		india = true; // the merchant opened Settings: the account is now known to be in India
		const replay = await place(cartId, false);
		expect(replay.ok, JSON.stringify(replay)).toBe(true);
		expect(calls.map((c) => c.path)).toEqual(["/v1/payment_intents", "/v1/payment_intents"]);
		expect(intents()[1]!.body).toBe(intents()[0]!.body);
	});

	test("placed under the requirement (IN), the country reads unknown: the replay names the same Customer and is accepted", async () => {
		india = true;
		const cartId = await digitalCart();
		loseTheIntentRecord();
		const first = await place(cartId, true);
		expect(first.ok).toBe(true);
		expect(intents()[0]!.body).toContain("customer=cus_");

		india = false; // a kv blip, or the key saved again while Stripe was unreachable
		const replay = await place(cartId, false);
		expect(replay.ok, JSON.stringify(replay)).toBe(true);
		expect(intents()).toHaveLength(2);
		expect(intents()[1]!.body).toBe(intents()[0]!.body);
	});

	test("the resume path behaves the same", async () => {
		const cartId = await digitalCart();
		loseTheIntentRecord();
		const first = await place(cartId, true);
		if (!first.ok) throw new Error(first.reason);
		india = true;
		const resumed = await harness.client.resumeOrderPayment(first.order.id, { cartId });
		expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
		expect(intents()[1]!.body).toBe(intents()[0]!.body);
	});
});
