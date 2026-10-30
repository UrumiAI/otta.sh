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

/**
 * The key fallback's limit (#598 review). A redemption is claimed BEFORE its order
 * insert, so a call that dies in between leaves it bound to the key alone — and the
 * shopper can then drop or swap the coupon and place again under the SAME key. The
 * order that persists under the key never applied the stranded coupon, so it holds
 * none of its use: the redemption is dead and the sweep must free it. Otherwise a
 * paid order leaks the use forever, and a coupon-less one never reaches the
 * expiry's `releaseByOrder` at all.
 */
async function strandThenPlace(couponCode?: string): Promise<{ h: OrderHarness; order: Order }> {
	const h = makeOrderHarness();
	await h.seedPhysical({ productId: "p1", sku: "SKU-1", priceCents: 1000, title: "W", onHand: 10 });
	for (const [id, code] of [
		["cpn", "SAVE5"],
		["cpn-other", "OTHER5"],
	] as const) {
		await h.couponStore.create({
			id,
			code,
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
	}
	const key = idempotencyKey("k-strand");
	// Call 1 redeemed SAVE5 under the key, then its isolate died before the insert.
	const stranded = await h.couponStore.redeem({
		couponId: "cpn",
		orderId: orderId("o-never-inserted"),
		idempotencyKey: key,
		createdAt: h.clock.now().toISOString(),
	});
	expect(stranded.ok).toBe(true);
	const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
	const placed = await createOrderFromCart(h.createDeps, {
		cartId,
		idempotencyKey: key,
		buyerRef: "b@example.com",
		paymentMethod: "stripe",
		...(couponCode !== undefined ? { couponCode } : {}),
	});
	if (!placed.ok) throw new Error(placed.reason);
	expect(placed.order.totals.appliedCouponCode).toBe(couponCode ?? null);
	return { h, order: placed.order };
}

test("the orphan sweep frees a redemption whose key's order applied no coupon (#598 review)", async () => {
	const { h } = await strandThenPlace();
	h.clock.advance(10 * 60 * 1000);
	const released = await reconcileCouponRedemptions(
		{ couponStore: h.couponStore, orderStore: h.orderStore, clock: h.clock },
		{ graceMs: 5 * 60 * 1000 },
	);
	expect(released).toBe(1);
	expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(0);
});

test("the orphan sweep frees a redemption whose key's order applied a DIFFERENT coupon, and keeps that one (#598 review)", async () => {
	const { h } = await strandThenPlace("OTHER5");
	h.clock.advance(10 * 60 * 1000);
	const released = await reconcileCouponRedemptions(
		{ couponStore: h.couponStore, orderStore: h.orderStore, clock: h.clock },
		{ graceMs: 5 * 60 * 1000 },
	);
	expect(released).toBe(1);
	expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(0);
	expect((await h.couponStore.findById("cpn-other"))?.usesCount).toBe(1);
});

/**
 * Issue #627. A double-clicked Place on a coupon at its cap: call 1 has taken the
 * LAST use and is still in flight (held before its order insert), so call 2's
 * idempotency short-circuit finds no order and its quote sees `usesCount ===
 * maxUses`. That use is call 2's own checkout's, so call 2 must resolve the way call
 * 1 does — never `COUPON_EXHAUSTED`. A different key at that moment is still
 * refused: the cap holds.
 */
test("a same-key checkout quoting while the first holds the coupon's last use is not refused COUPON_EXHAUSTED (#627)", async () => {
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
		idempotencyKey: idempotencyKey("k-double-click"),
		buyerRef: "b@example.com",
		paymentMethod: "stripe" as const,
		couponCode: "SAVE5",
	};

	// Call 1 is held at its insert — AFTER its redeem took the last use.
	let releaseFirst!: () => void;
	const firstHeld = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let reachedInsert!: () => void;
	const firstAtInsert = new Promise<void>((resolve) => {
		reachedInsert = resolve;
	});
	let calls = 0;
	const insert = h.orderStore.createFromCart.bind(h.orderStore);
	h.orderStore.createFromCart = async (input) => {
		if (++calls === 1) {
			reachedInsert();
			await firstHeld;
		}
		return await insert(input);
	};
	const first = createOrderFromCart(h.createDeps, command);
	await firstAtInsert;
	expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);

	// A different shopper's checkout now is refused: the last use is taken.
	const otherCart = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
	const other = await createOrderFromCart(h.createDeps, {
		...command,
		cartId: otherCart,
		idempotencyKey: idempotencyKey("k-other-shopper"),
	});
	expect(other).toEqual({ ok: false, reason: "COUPON_EXHAUSTED" });

	// The double click, while call 1 is still in flight: the same checkout.
	const second = await createOrderFromCart(h.createDeps, command);
	releaseFirst();
	const firstResult = await first;
	if (!second.ok) throw new Error(`the same-key call was refused ${second.reason}`);
	if (!firstResult.ok) throw new Error(`the first call was refused ${firstResult.reason}`);
	expect(second.order.id).toBe(firstResult.order.id);
	expect(second.order.totals.discount).toBe(500);
	// One use, for the one order.
	expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
	expect(await h.couponStore.listRedemptionsCreatedBefore(FAR_FUTURE)).toHaveLength(1);
});

/**
 * #627 review. The same-key duplicate let past the soft check only REPLAYS call 1's
 * redemption. If its own insert then throws (a transient storage error), it must
 * not release that redemption: the use is call 1's, and call 1's order still lands
 * discounted. Releasing it would hand the last use of a single-use coupon to
 * another shopper as well.
 */
test("a same-key duplicate that replayed the held use and then throws does not release it (#627 review)", async () => {
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
		idempotencyKey: idempotencyKey("k-double-click"),
		buyerRef: "b@example.com",
		paymentMethod: "stripe" as const,
		couponCode: "SAVE5",
	};

	let releaseFirst!: () => void;
	const firstHeld = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let reachedInsert!: () => void;
	const firstAtInsert = new Promise<void>((resolve) => {
		reachedInsert = resolve;
	});
	let calls = 0;
	const insert = h.orderStore.createFromCart.bind(h.orderStore);
	h.orderStore.createFromCart = async (input) => {
		const mine = ++calls;
		if (mine === 1) {
			reachedInsert();
			await firstHeld;
		}
		if (mine === 2) throw new Error("transient storage error");
		return await insert(input);
	};
	const first = createOrderFromCart(h.createDeps, command);
	await firstAtInsert;

	// The double click replays call 1's redemption, then its insert throws.
	await expect(createOrderFromCart(h.createDeps, command)).rejects.toThrow(
		"transient storage error",
	);
	expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
	// Still taken: another shopper is refused.
	const otherCart = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
	const other = await createOrderFromCart(h.createDeps, {
		...command,
		cartId: otherCart,
		idempotencyKey: idempotencyKey("k-other-shopper"),
	});
	expect(other).toEqual({ ok: false, reason: "COUPON_EXHAUSTED" });

	releaseFirst();
	const a = await first;
	if (!a.ok) throw new Error(`the first call was refused ${a.reason}`);
	expect(a.order.totals.discount).toBe(500);
	expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
	expect(await h.couponStore.listRedemptionsCreatedBefore(FAR_FUTURE)).toHaveLength(1);
});

test("a failing holdsUseUnderKey read keeps the typed COUPON_EXHAUSTED refusal (#627 review)", async () => {
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
	const taken = await h.couponStore.redeem({
		couponId: "cpn",
		orderId: orderId("o-other"),
		idempotencyKey: idempotencyKey("k-other"),
		createdAt: h.clock.now().toISOString(),
	});
	expect(taken.ok).toBe(true);
	h.couponStore.holdsUseUnderKey = async () => {
		throw new Error("storage unavailable");
	};
	{
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey("k-mine"),
			buyerRef: "b@example.com",
			paymentMethod: "stripe",
			couponCode: "SAVE5",
		});
		expect(res).toEqual({ ok: false, reason: "COUPON_EXHAUSTED" });
		expect(h.logger.entries).toHaveLength(1);
		expect(h.logger.entries[0]).toMatchObject({
			level: "warn",
			fields: { error: { name: "Error", message: "storage unavailable" } },
		});
	}
});
