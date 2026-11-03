/**
 * ADR-0044 at the commerce client: what `createOrder` hands the domain for cash on
 * delivery, and what `resumeOrderPayment` refuses.
 *
 *  - The offline block carries the merchant's live policy (the toggle and both
 *    caps, from the `resolveOfflinePolicy` the composition root wires to kv) and
 *    the client's network key HASHED (hex SHA-256): the address is never stored.
 *  - The toggle is checked only for a FRESH placement, so a same-key replay after
 *    COD was switched off still answers the order it placed (review finding 11).
 *  - A policy that cannot be read is COD off, never a thrown checkout.
 *  - An offline order is never resumable for payment: refused up front, before any
 *    replay reaches a gateway.
 *
 * Real document store (in-process harness); the cod gateway is the real one,
 * wrapped to count its intents.
 */
import type { CreateIntentInput, PaymentIntentHandle } from "@urumi.ai/otta-domain";
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import { CashOnDeliveryGateway } from "@urumi.ai/otta-payments-cod";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { OfflinePolicy } from "../src/payments/cash-on-delivery.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

class CountingCodGateway extends CashOnDeliveryGateway {
	intents = 0;
	override async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
		this.intents += 1;
		return await super.createIntent(input);
	}
}

let policy: OfflinePolicy | Error;
let gateway: CountingCodGateway;
let harness: InProcessCommerceHarness;

beforeEach(async () => {
	policy = { enabled: true, maxOpenPerBuyer: 3, maxOpenPerClient: 3 };
	if (harness === undefined) {
		gateway = new CountingCodGateway();
		harness = await makeInProcessCommerce({
			gateways: { cod: gateway },
			resolveOfflinePolicy: async () => {
				if (policy instanceof Error) throw policy;
				return policy;
			},
		});
	} else await harness.reset();
	gateway.intents = 0;
});

afterAll(async () => {
	await harness?.close();
});

let seq = 0;
async function physicalCart(): Promise<string> {
	seq += 1;
	const productId = `prod-cod-${String(seq)}`;
	const sku = `SKU-COD-${String(seq)}`;
	await harness.client.upsertProductCommerce(
		productId,
		{
			sku,
			title: "Mug",
			price: { amount: 1200, currency: "USD" },
			productKind: "physical",
			initialOnHand: 5,
		},
		`seed-${productId}`,
	);
	await harness.client.activateProductCommerce(
		productId,
		`publish-${productId}`,
		"2026-01-01T00:00:00.000Z",
	);
	const { cartId } = await harness.client.createCart("USD");
	const added = await harness.client.addCartLine(cartId, sku, productId, 1, `add-${productId}`);
	if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
	return cartId;
}

const ADDRESS = {
	name: "Asha Rao",
	line1: "12 Park Street",
	city: "Springfield",
	postalCode: "62701",
	country: "US",
	region: "IL",
	phone: "+1 217 555 0100",
};

const CLIENT_KEY = "203.0.113.7";

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function placeCod(
	cartId: string,
	overrides: { buyerRef?: string; clientKey?: string | null } = {},
) {
	const clientKey = overrides.clientKey === undefined ? CLIENT_KEY : overrides.clientKey;
	return harness.client.createOrder(
		{
			cartId,
			paymentMethod: "cod",
			buyerRef: overrides.buyerRef ?? "asha@example.test",
			shippingAddress: ADDRESS,
			...(clientKey !== null ? { clientKey } : {}),
		},
		`checkout:${cartId}`,
	);
}

describe("createOrder with cash on delivery", () => {
	test("places an awaiting_payment order with an offline action, stored under the HASH of the client key", async () => {
		const placed = await placeCod(await physicalCart());
		expect(placed).toMatchObject({
			ok: true,
			order: { state: "awaiting_payment", settlement: "offline" },
			intent: { clientAction: { kind: "offline" } },
		});
		const hashed = await sha256Hex(CLIENT_KEY);
		expect(hashed).toMatch(/^[0-9a-f]{64}$/);
		// Counted under the hash, and not under the raw address.
		expect(
			await harness.stores.orderStore.countOpenOfflineOrders({
				buyerRef: "nobody@example.test",
				clientKey: hashed,
			}),
		).toEqual({ byBuyer: 0, byClient: 1 });
		expect(
			await harness.stores.orderStore.countOpenOfflineOrders({
				buyerRef: "nobody@example.test",
				clientKey: CLIENT_KEY,
			}),
		).toEqual({ byBuyer: 0, byClient: 0 });
	});

	test("with no client key (the site's per-IP limit did not run) it is PAYMENT_METHOD_UNAVAILABLE", async () => {
		expect(await placeCod(await physicalCart(), { clientKey: null })).toEqual({
			ok: false,
			reason: "PAYMENT_METHOD_UNAVAILABLE",
		});
	});

	test("switched off, a fresh placement is refused — but a same-key replay of an order placed while on still answers it", async () => {
		const cartId = await physicalCart();
		const first = await placeCod(cartId);
		if (!first.ok) throw new Error(first.reason);
		policy = { enabled: false, maxOpenPerBuyer: 3, maxOpenPerClient: 3 };
		expect(await placeCod(await physicalCart())).toEqual({
			ok: false,
			reason: "PAYMENT_METHOD_UNAVAILABLE",
		});
		const replay = await placeCod(cartId);
		expect(replay).toMatchObject({ ok: true, order: { id: first.order.id } });
	});

	test("the caps are the policy's: a buyer at their cap is OFFLINE_ORDER_LIMIT, and 0 means no cap", async () => {
		policy = { enabled: true, maxOpenPerBuyer: 1, maxOpenPerClient: 0 };
		expect((await placeCod(await physicalCart())).ok).toBe(true);
		expect(await placeCod(await physicalCart(), { clientKey: "198.51.100.1" })).toEqual({
			ok: false,
			reason: "OFFLINE_ORDER_LIMIT",
		});
		policy = { enabled: true, maxOpenPerBuyer: 0, maxOpenPerClient: 1 };
		// No buyer cap now; the same client network is at its cap of one.
		expect(await placeCod(await physicalCart(), { buyerRef: "other@example.test" })).toEqual({
			ok: false,
			reason: "OFFLINE_ORDER_LIMIT",
		});
		policy = { enabled: true, maxOpenPerBuyer: 0, maxOpenPerClient: 0 };
		expect((await placeCod(await physicalCart())).ok).toBe(true);
	});

	test("a policy that cannot be read is COD off: refused, logged, never thrown", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		policy = new Error("kv down");
		try {
			expect(await placeCod(await physicalCart())).toEqual({
				ok: false,
				reason: "PAYMENT_METHOD_UNAVAILABLE",
			});
			expect(errors).toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});

	test("a card checkout never asks for the offline policy", async () => {
		let asked = 0;
		const own = await makeInProcessCommerce({
			resolveOfflinePolicy: async () => {
				asked += 1;
				return { enabled: true, maxOpenPerBuyer: 3, maxOpenPerClient: 3 };
			},
		});
		try {
			const { cartId } = await own.client.createCart("USD");
			// Whatever card checkout answers on this gateway-less store (it throws:
			// no stripe gateway), it got there without the COD policy.
			await own.client
				.createOrder(
					{ cartId, paymentMethod: "stripe", buyerRef: "a@example.test" },
					`checkout:${cartId}`,
				)
				.catch(() => undefined);
			expect(asked).toBe(0);
		} finally {
			await own.close();
		}
	});

	test.each([
		["a blank one", "   "],
		["one over 128 characters", "k".repeat(129)],
	])(
		"a client key that is %s is a programmer error, thrown before anything is read",
		async (_label, clientKey) => {
			await expect(placeCod(await physicalCart(), { clientKey })).rejects.toThrow(/clientKey/);
		},
	);
});

describe("resumeOrderPayment and an offline order", () => {
	test("an awaiting_payment COD order is ORDER_NOT_PAYABLE", async () => {
		const cartId = await physicalCart();
		const placed = await placeCod(cartId);
		if (!placed.ok) throw new Error(placed.reason);
		const intentsBefore = gateway.intents;
		expect(await harness.client.resumeOrderPayment(placed.order.id, { cartId })).toEqual({
			ok: false,
			reason: "ORDER_NOT_PAYABLE",
		});
		expect(gateway.intents).toBe(intentsBefore);
	});

	test("even a still-PENDING offline order (a placement that died before its flip) is refused up front, before any replay", async () => {
		const cartId = await physicalCart();
		const orderId = "order-cod-crash-window";
		await harness.stores.orderStore.createFromCart({
			orderId: toOrderId(orderId),
			cartId,
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey(`checkout:${cartId}`),
			holdExpiresAt: "2099-01-01T00:00:00.000Z",
			buyerRef: "asha@example.test",
			paymentMethod: "cod",
			lines: [
				{
					productId: toProductId("prod-crash"),
					sku: toSku("SKU-CRASH"),
					title: "Mug",
					unitPrice: cents(1200),
					currency: toCurrency("USD"),
					quantity: 1,
					fulfillmentKind: "physical",
					reservationId: null,
				},
			],
			totals: { subtotal: cents(1200), total: cents(1200), currency: toCurrency("USD") },
		});
		expect(await harness.client.resumeOrderPayment(orderId, { cartId })).toEqual({
			ok: false,
			reason: "ORDER_NOT_PAYABLE",
		});
		expect(gateway.intents).toBe(0);
	});
});
