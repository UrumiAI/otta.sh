import {
	cents,
	createOrderFromCart,
	currency,
	expireOrders,
	idempotencyKey,
	orderId,
	reconcileCouponRedemptions,
	type Order,
} from "@urumi.ai/otta-domain";
import { expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

const FAR_FUTURE = "9999-12-31T00:00:00.000Z";

/**
 * Issue #598. The storefront's checkout key is fixed per cart, so a double-clicked
 * Place (or a crash-then-retry) runs two same-key calls. Each mints its own order
 * id, but the coupon redemption is keyed on `(coupon, key)`: the second call
 * REPLAYS the first's redemption, which names the first call's order id — and the
 * order row, deduped on the same key, can land under the SECOND call's id. The
 * redemption then names an order that never existed while a real, discounted order
 * holds its use. Nothing may treat that use as orphaned, and the order's own
 * release (expiry) must still find it.
 */
async function doublePlace(): Promise<{ h: OrderHarness; persisted: Order }> {
	const h = makeOrderHarness();
	await h.seedPhysical({ productId: "p1", sku: "SKU-1", priceCents: 1000, title: "W", onHand: 10 });
	await h.couponStore.create({
		id: "cpn",
		code: "SAVE5",
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
	const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
	const command = {
		cartId,
		idempotencyKey: idempotencyKey("k-double-place"),
		buyerRef: "b@example.com",
		paymentMethod: "stripe" as const,
		couponCode: "SAVE5",
	};

	// Call A redeems first (binding the redemption to A's id), then is held at its
	// insert until call B — which replayed A's redemption — has inserted its own.
	let releaseA!: () => void;
	const aGate = new Promise<void>((resolve) => {
		releaseA = resolve;
	});
	let calls = 0;
	const insert = h.orderStore.createFromCart.bind(h.orderStore);
	h.orderStore.createFromCart = async (input) => {
		const mine = ++calls;
		if (mine === 1) await aGate;
		const out = await insert(input);
		if (mine === 2) releaseA();
		return out;
	};
	const [a, b] = await Promise.all([
		createOrderFromCart(h.createDeps, command),
		createOrderFromCart(h.createDeps, command),
	]);
	if (!a.ok || !b.ok) throw new Error("both same-key calls must succeed");
	expect(a.order.id).toBe(b.order.id);
	expect(b.order.totals.discount).toBe(500);
	// The interleaving really happened: the one redemption names an id that was
	// never persisted.
	const [redemption] = await h.couponStore.listRedemptionsCreatedBefore(FAR_FUTURE);
	expect(redemption?.orderId).not.toBe(b.order.id);
	expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
	return { h, persisted: b.order };
}

test("the orphan sweep leaves the use a same-key replay's persisted order holds (#598)", async () => {
	const { h } = await doublePlace();

	// Past the grace window, but before the order's hold lapses: the crash-recovery
	// sweep must see the order that holds the redemption's key.
	h.clock.advance(14 * 60 * 1000);
	const released = await reconcileCouponRedemptions(
		{ couponStore: h.couponStore, orderStore: h.orderStore, clock: h.clock },
		{ graceMs: 5 * 60 * 1000 },
	);
	expect(released).toBe(0);
	expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
	// Single-use, and still used: a second shopper is refused.
	const second = await h.couponStore.redeem({
		couponId: "cpn",
		orderId: orderId("o-second-shopper"),
		idempotencyKey: idempotencyKey("k-second-shopper"),
		createdAt: h.clock.now().toISOString(),
	});
	expect(second).toMatchObject({ ok: false, reason: "COUPON_EXHAUSTED" });
});

test("expiring a same-key replay's persisted order frees the coupon use it holds (#598)", async () => {
	const { h, persisted } = await doublePlace();
	h.clock.advance(60 * 60 * 1000);
	expect(await expireOrders(h.expireDeps)).toBe(1);
	expect((await h.orderStore.getById(persisted.id))?.state).toBe("expired");
	expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(0);
	expect(await h.couponStore.listRedemptionsCreatedBefore(FAR_FUTURE)).toEqual([]);
});
