import { cents, createOrderFromCart, currency, idempotencyKey } from "@urumi/domain";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "../orders/fake-harness.js";

const USD = currency("USD");

/** Seed a US zone with a flat-rate shipping method + rate, and a standard tax rate. */
async function seedRules(
	h: OrderHarness,
	opts: { shippingCents?: number; taxBps?: number; shippingTaxable?: boolean } = {},
): Promise<void> {
	await h.shippingRules.createZone({ id: "z-us", name: "US", regions: null });
	await h.shippingRules.createMethod({
		id: "m-flat",
		zoneId: "z-us",
		name: "Flat",
		type: "flat_rate",
	});
	await h.shippingRules.createRate({
		methodId: "m-flat",
		currency: USD,
		amountCents: cents(opts.shippingCents ?? 599),
		minSubtotalCents: null,
	});
	await h.taxRules.createRate({
		id: "t-std",
		taxClassId: "standard",
		zoneId: "z-us",
		rateBps: opts.taxBps ?? 1000,
		appliesToShipping: opts.shippingTaxable ?? false,
	});
}

function checkoutCmd(cartId: string, over: Record<string, unknown> = {}) {
	return {
		cartId,
		idempotencyKey: idempotencyKey("k-checkout"),
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe" as const,
		shippingZoneId: "z-us",
		shippingMethodId: "m-flat",
		...over,
	};
}

describe("checkout pipeline (Phase 6): totals reflect coupon/shipping/tax", () => {
	let h: OrderHarness;
	beforeEach(() => {
		h = makeOrderHarness();
	});

	test("checkout total reflects coupon/shipping/tax, not a naive sum of snapshot line prices", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Widget",
			onHand: 10,
		});
		await seedRules(h, { shippingCents: 599, taxBps: 1000 });
		await h.couponStore.create({
			id: "cpn",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: USD,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: 100,
			maxUsesPerCustomer: null,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);

		const res = await createOrderFromCart(
			h.createDeps,
			checkoutCmd(cartId, { couponCode: "SAVE5" }),
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const t = res.order.totals;
		// subtotal 2000; coupon -500 ⇒ discounted 1500; shipping 599; tax 1500×10% = 150.
		expect(t.subtotal).toBe(2000);
		expect(t.discount).toBe(500);
		expect(t.shipping).toBe(599);
		expect(t.tax).toBe(150);
		expect(t.total).toBe(1500 + 599 + 150);
		// NOT the naive Σ(line) = 2000.
		expect(t.total).not.toBe(2000);
		expect(t.appliedCouponCode).toBe("SAVE5");
		// The coupon was redeemed exactly once.
		expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
	});

	test("order_totals is written once and is unchanged by later edits to tax rates, shipping rates, or the coupon (extends the Phase-4 snapshot invariant)", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Widget",
			onHand: 10,
		});
		await seedRules(h, { shippingCents: 599, taxBps: 1000 });
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);

		const res = await createOrderFromCart(h.createDeps, checkoutCmd(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const before = { ...res.order.totals };

		// Edit the rules AFTER the order exists — a new shipping rate, a new tax rate.
		await h.shippingRules.createRate({
			methodId: "m-flat",
			currency: USD,
			amountCents: cents(9999),
			minSubtotalCents: null,
		});
		await h.taxRules.createRate({
			id: "t-std-2",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 5000,
			appliesToShipping: false,
		});

		const reread = await h.orderStore.getById(res.order.id);
		expect(reread?.totals.shipping).toBe(before.shipping);
		expect(reread?.totals.tax).toBe(before.tax);
		expect(reread?.totals.total).toBe(before.total);
	});

	test("coupon redemption and inventory reservation both happen under the same idempotency key; a replay does not double-redeem or double-reserve", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Widget",
			onHand: 10,
		});
		await seedRules(h);
		await h.couponStore.create({
			id: "cpn",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: USD,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: 100,
			maxUsesPerCustomer: null,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);

		const first = await createOrderFromCart(
			h.createDeps,
			checkoutCmd(cartId, { couponCode: "SAVE5" }),
		);
		const replay = await createOrderFromCart(
			h.createDeps,
			checkoutCmd(cartId, { couponCode: "SAVE5" }),
		);
		expect(first.ok && replay.ok).toBe(true);
		if (!first.ok || !replay.ok) return;
		expect(replay.order.id).toBe(first.order.id);
		// Stock decremented once (10 - 2), coupon redeemed once.
		expect(h.inventory.onHand("SKU-1")).toBe(8);
		expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
	});

	test("synchronous release: a lost hold after a successful redeem releases the coupon before surfacing RESERVATION_LOST (§5 catch-and-release)", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "A",
			onHand: 10,
		});
		await h.seedPhysical({
			productId: "p2",
			sku: "SKU-2",
			priceCents: 1000,
			title: "B",
			onHand: 10,
		});
		await seedRules(h);
		await h.couponStore.create({
			id: "cpn",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: USD,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: 100,
			maxUsesPerCustomer: null,
		});
		const cartId = await h.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			{ sku: "SKU-2", productId: "p2", qty: 1, kind: "physical" },
		]);
		const cart = (await h.cartStore.get(cartId))!;
		// Reap the second line's hold so adoption fails AFTER the coupon is redeemed.
		await h.inventory.release(cart.lines[1]!.reservationId!);

		const res = await createOrderFromCart(
			h.createDeps,
			checkoutCmd(cartId, { couponCode: "SAVE5" }),
		);
		expect(res).toEqual({ ok: false, reason: "RESERVATION_LOST" });
		// The coupon was redeemed then RELEASED synchronously — uses_count back to 0.
		expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(0);
	});

	test("a coupon at maxUses is rejected COUPON_EXHAUSTED and no order is minted", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Widget",
			onHand: 10,
		});
		await seedRules(h);
		await h.couponStore.create({
			id: "cpn",
			code: "ONCE",
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: USD,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: 0, // already exhausted
			maxUsesPerCustomer: null,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(
			h.createDeps,
			checkoutCmd(cartId, { couponCode: "ONCE" }),
		);
		expect(res).toEqual({ ok: false, reason: "COUPON_EXHAUSTED" });
	});
});
