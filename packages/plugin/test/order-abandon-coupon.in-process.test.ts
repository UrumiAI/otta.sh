/**
 * "Start a new cart" and the abandoned order's coupon use (issue #596) — the
 * cases the commerce-client contract cannot express. The core behaviour (the use
 * goes back, the replacement cart redeems it, a replay frees nothing else) is the
 * contract's; these two need the stores underneath the port:
 *
 *  - the CRASH WINDOW: the abandon's cancel landed and its release did not. The
 *    site retries the abandon (a failed one claims nothing), and that replay finds
 *    the order already cancelled — it must still give the use back, or nothing
 *    ever will;
 *  - an ADMIN cancel keeps the use, exactly as before: a replay of "Start a new
 *    cart" on an order the operator cancelled is not the abandon's to undo.
 *
 * In-process over a real document store (no mocks).
 */
import {
	cancelOrder,
	cents,
	currency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
} from "@urumi.ai/otta-domain";
import { FakePaymentGateway } from "@urumi.ai/otta-domain/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	harness = await makeInProcessCommerce({
		gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
	});
});
afterEach(async () => {
	await harness.close();
});

/** One pending order placed with the one-use coupon `ONCE`. */
async function placeWithCoupon(): Promise<{ cartId: string; orderId: string }> {
	const { client, stores } = harness;
	await stores.couponStore.create({
		id: "c-once",
		code: "ONCE",
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: currency("USD"),
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: 1,
		maxUsesPerCustomer: null,
	});
	await client.upsertProductCommerce(
		"prod-once",
		{
			sku: "SKU-ONCE",
			title: "Once",
			price: { amount: 2000, currency: "USD" },
			initialOnHand: 3,
		},
		"seed-once",
	);
	await client.activateProductCommerce(
		"prod-once",
		"seed-once-publish",
		"2026-01-01T00:00:00.000Z",
	);
	const { cartId } = await client.createCart("USD");
	const added = await client.addCartLine(cartId, "SKU-ONCE", "prod-once", 1, "add-once");
	if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
	const placed = await client.createOrder(
		{ cartId, paymentMethod: "stripe", buyerRef: "once@example.test", couponCode: "ONCE" },
		`checkout:${cartId}`,
	);
	if (!placed.ok) throw new Error(`checkout failed: ${placed.reason}`);
	return { cartId, orderId: placed.order.id };
}

async function usesCount(): Promise<number | undefined> {
	return (await harness.stores.couponStore.findById("c-once"))?.usesCount;
}

describe("abandonCartOrder — the abandoned order's coupon use (#596)", () => {
	test("a replay after a cancel that landed without its release still gives the use back", async () => {
		const { cartId, orderId } = await placeWithCoupon();
		expect(await usesCount()).toBe(1);
		// The abandon's own cancel — same command, same key — and then the crash:
		// the release never ran.
		const cancelled = await cancelOrder(
			{ orderStore: harness.stores.orderStore },
			{
				orderId: toOrderId(orderId),
				reason: "customer_request",
				detail: "Started a new cart",
				cancelledBy: "shopper",
				idempotencyKey: toIdempotencyKey(`shopper:new-cart:${orderId}`),
			},
		);
		expect(cancelled.ok && cancelled.cancelled).toBe(true);
		expect(await usesCount()).toBe(1);

		expect(await harness.client.abandonCartOrder(cartId)).toEqual({
			ok: true,
			cancelled: false,
			orderId,
		});
		expect(await usesCount()).toBe(0);
	});

	test("an order the ADMIN cancelled keeps its coupon use — the abandon only undoes its own cancel", async () => {
		const { cartId, orderId } = await placeWithCoupon();
		const cancelled = await cancelOrder(
			{ orderStore: harness.stores.orderStore },
			{
				orderId: toOrderId(orderId),
				reason: "customer_request",
				detail: "Buyer phoned in",
				cancelledBy: "admin",
				idempotencyKey: toIdempotencyKey(`admin-cancel:${orderId}`),
			},
		);
		expect(cancelled.ok && cancelled.cancelled).toBe(true);

		expect(await harness.client.abandonCartOrder(cartId)).toEqual({
			ok: true,
			cancelled: false,
			orderId,
		});
		expect(await usesCount()).toBe(1);
	});
});
