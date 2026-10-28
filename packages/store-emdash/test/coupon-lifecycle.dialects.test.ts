/**
 * The coupon lifecycle, driven end to end through the real checkout use-cases —
 * ported from the SQL adapter's suite of the same name, case for case.
 *
 * Nothing here calls `redeem` or `release` directly: the coupon is consumed by
 * `createOrderFromCart` and freed by `expireOrders` — and deliberately NOT by a
 * declined payment, which keeps the order payable (ADR-0022) — over the real cart,
 * inventory and order documents. That is the point
 * of the file — the symmetry with inventory is a property of the USE-CASES, and it has
 * to survive the coupon's counter living in a different document from the order that
 * consumed it.
 *
 * The wiring is the order harness with its in-memory coupon fake SWAPPED for the real
 * `EmdashCouponStore`, over the same storage and the same clock. Everything else the
 * checkout needs stays as the order suites have it.
 */
import {
	cents,
	createOrderFromCart,
	currency,
	expireOrders,
	idempotencyKey,
	reconcileCouponRedemptions,
	settleOrder,
	type CreateOrderDeps,
	type ExpireOrdersDeps,
	type SettleDeps,
} from "@urumi.ai/otta-domain";
import { expect, test } from "vitest";
import {
	collectionOf,
	ORDER_KEYS_COLLECTION,
	ORDERS_COLLECTION,
	type OrderDoc,
	type OrderKeyDoc,
} from "../src/index.js";
import { COUPON_LIFECYCLE_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness, type CouponHarness } from "./coupon-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	failCall,
	InjectedCrashError,
	isClaimWrite,
	withCollection,
} from "./helpers/fault-injection.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";

const USD = currency("USD");

interface Fixture {
	orders: OrderHarness;
	coupons: CouponHarness;
	createDeps: CreateOrderDeps;
	settleDeps: SettleDeps;
	expireDeps: ExpireOrdersDeps;
}

function cmd(cartId: string) {
	return {
		cartId,
		idempotencyKey: idempotencyKey("k-checkout"),
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe" as const,
		couponCode: "SAVE5",
	};
}

/** A gate one step waits on and another opens. */
function opening(): { promise: Promise<void>; open: () => void } {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/**
 * `target` with some methods replaced, for ONE call's dependency bundle. Every other
 * method is the target's own, bound to it (the stores keep `#private` state, which a
 * method called on a copy could not reach).
 */
function overriding<T extends object>(target: T, overrides: Partial<T>): T {
	return new Proxy(target, {
		get(t, key) {
			if (Object.hasOwn(overrides, key)) return overrides[key as keyof T];
			const value: unknown = Reflect.get(t, key, t);
			return typeof value === "function" ? value.bind(t) : value;
		},
	});
}

describeEachDialect("coupon lifecycle", (ctx) => {
	const bound = ctx.useStorage(COUPON_LIFECYCLE_LAYOUT);

	/** The order harness, with the REAL coupon store in every dependency bundle. */
	function fixture(): Fixture {
		const orders = makeOrderHarness(bound.storage);
		const coupons = makeCouponHarness(bound.storage, { clock: orders.clock });
		return {
			orders,
			coupons,
			createDeps: { ...orders.createDeps, couponStore: coupons.store },
			settleDeps: orders.settleDeps,
			expireDeps: { ...orders.expireDeps, couponStore: coupons.store },
		};
	}

	async function checkout(fx: Fixture) {
		await fx.orders.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "Widget",
			onHand: 5,
		});
		await fx.coupons.store.create({
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
			maxUses: 5,
			maxUsesPerCustomer: null,
		});
		const cartId = await fx.orders.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
		]);
		const res = await createOrderFromCart(fx.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(1);
		return res.order;
	}

	test("after a durable order EXPIRES, usesCount returns to its pre-redemption value", async () => {
		const fx = fixture();
		const order = await checkout(fx);
		// Advance past the checkout TTL and run the expiry sweep.
		fx.orders.advance(16 * 60 * 1000);
		expect(await expireOrders(fx.expireDeps)).toBe(1);
		expect((await fx.orders.store.getById(order.id))?.state).toBe("expired");
		// Symmetric with the inventory release: the coupon is freed, and the record that
		// held the use is gone rather than tombstoned.
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(0);
		expect(await fx.coupons.redemptions.count({ couponId: "cpn", holdsUse: "yes" })).toBe(0);
	});

	test("a declined payment does NOT free the coupon — the order stays payable until it expires", async () => {
		const fx = fixture();
		const order = await checkout(fx);
		const raw = fx.orders.stripeGateway.webhook({
			outcome: "failed",
			orderId: order.id,
			providerRef: `pi_${order.id}`,
			amount: order.totals.total,
			currency: "USD",
			dedupeKey: `evt-fail-${order.id}`,
		});
		const settled = await settleOrder(fx.settleDeps, fx.orders.stripeGateway, raw);
		expect(settled.ok).toBe(true);
		expect((await fx.orders.store.getById(order.id))?.state).toBe("pending");
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(1);
		// Nobody retries: the expiry sweep is what frees it.
		fx.orders.advance(16 * 60 * 1000);
		expect(await expireOrders(fx.expireDeps)).toBe(1);
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(0);
	});

	// Issue #598: the storefront's key is fixed per cart, so a double-clicked Place
	// runs two same-key checkouts. Each mints its own order id; the second REPLAYS the
	// first's redemption (keyed on coupon + key), which names the first call's id —
	// and here the second call's insert lands first, so the order persists under the
	// second call's id. The order still holds the use: the orphan sweep must not free
	// it, and the order's own expiry must.
	test("a same-key double place whose second insert lands first: the persisted order keeps, then frees, the use", async () => {
		const fx = fixture();
		await fx.orders.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "Widget",
			onHand: 5,
		});
		await fx.coupons.store.create({
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
			maxUses: 1,
			maxUsesPerCustomer: null,
		});
		const cartId = await fx.orders.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
		]);
		// The interleaving is FORCED, never left to the scheduler: each call gets its
		// own dependency bundle, and three gates order the steps that matter.
		//   1. call 1 redeems only once call 2 has quoted — both quote against the
		//      unspent coupon, as a double click does. Left to timing, a Postgres pool
		//      opening its second connection lets call 1 bump the counter first, and
		//      call 2's quote then refuses the spent coupon (`maxUses: 1`) before it
		//      ever reaches the replay this case is about;
		//   2. call 2 redeems only once call 1's redeem has returned, so it REPLAYS
		//      the redemption that names call 1's order id;
		//   3. call 1 inserts only once call 2's insert has landed.
		// A call that settles opens every gate it owns, so a refusal at ANY step fails
		// the assertions below rather than parking the other call until the timeout.
		const secondQuoted = opening();
		const firstRedeemed = opening();
		const secondInserted = opening();
		const couponStore = fx.coupons.store;
		const orderStore = fx.createDeps.orderStore;
		const first: CreateOrderDeps = {
			...fx.createDeps,
			couponStore: overriding(couponStore, {
				async redeem(input) {
					await secondQuoted.promise;
					try {
						return await couponStore.redeem(input);
					} finally {
						firstRedeemed.open();
					}
				},
			}),
			orderStore: overriding(orderStore, {
				async createFromCart(input) {
					await secondInserted.promise;
					return await orderStore.createFromCart(input);
				},
			}),
		};
		const second: CreateOrderDeps = {
			...fx.createDeps,
			couponStore: overriding(couponStore, {
				async findByCode(code) {
					try {
						return await couponStore.findByCode(code);
					} finally {
						secondQuoted.open();
					}
				},
				async redeem(input) {
					await firstRedeemed.promise;
					return await couponStore.redeem(input);
				},
			}),
			orderStore: overriding(orderStore, {
				async createFromCart(input) {
					try {
						return await orderStore.createFromCart(input);
					} finally {
						secondInserted.open();
					}
				},
			}),
		};
		const [a, b] = await Promise.all([
			createOrderFromCart(first, cmd(cartId)).finally(() => firstRedeemed.open()),
			createOrderFromCart(second, cmd(cartId)).finally(() => {
				secondQuoted.open();
				secondInserted.open();
			}),
		]);
		if (!a.ok || !b.ok) throw new Error("both same-key calls must succeed");
		expect(a.order.id).toBe(b.order.id);
		expect(b.order.totals.discount).toBe(500);
		const [redemption] = await fx.coupons.store.listRedemptionsCreatedBefore(
			"9999-12-31T00:00:00.000Z",
		);
		expect(redemption?.orderId).not.toBe(b.order.id);
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(1);

		// Past a grace window, the order still pending inside its hold.
		fx.orders.advance(10 * 60 * 1000);
		const released = await reconcileCouponRedemptions(
			{ couponStore: fx.coupons.store, orderStore: fx.orders.store, clock: fx.orders.clock },
			{ graceMs: 5 * 60 * 1000 },
		);
		expect(released).toBe(0);
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(1);

		// Unpaid past its hold: expiry frees the use the order actually holds.
		fx.orders.advance(10 * 60 * 1000);
		expect(await expireOrders(fx.expireDeps)).toBe(1);
		expect((await fx.orders.store.getById(b.order.id))?.state).toBe("expired");
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(0);
		expect(await fx.coupons.redemptions.count({ couponId: "cpn", holdsUse: "yes" })).toBe(0);
	});

	// #598 review: the orphan sweep reads the key through the PURE peek. A checkout
	// that died between its key claim and its order document leaves a claim carrying
	// a discounted order; the sweep must neither complete it (conjuring an order the
	// expiry would mail about) nor free its use while that claim could still be
	// finished inside its hold — and once the hold lapses, nothing else ever will.
	test("a claim whose order never landed keeps its use inside the hold, frees it after, and is never completed by the sweep", async () => {
		const fx = fixture();
		await fx.orders.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "Widget",
			onHand: 5,
		});
		await fx.coupons.store.create({
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
			maxUses: 1,
			maxUsesPerCustomer: null,
		});
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const keys = collectionOf<OrderKeyDoc>(bound.storage, ORDER_KEYS_COLLECTION);
		const crashing = failCall(orders, isClaimWrite, { mode: "instead" });
		const crashed = makeOrderHarness(bound.storage, {
			share: fx.orders.shared,
			storageForOrders: withCollection(bound.storage, ORDERS_COLLECTION, crashing.collection),
		});
		const cartId = await fx.orders.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
		]);
		// The isolate DIES at the order write: the use-case's in-process catch (which
		// would release the redemption eagerly) never runs, so `release` does nothing.
		const store = fx.coupons.store;
		const dyingCoupons = new Proxy(store, {
			get(target, prop) {
				if (prop === "release") return async () => {};
				const value: unknown = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await expect(
			createOrderFromCart({ ...crashed.createDeps, couponStore: dyingCoupons }, cmd(cartId)),
		).rejects.toThrow(InjectedCrashError);
		const claim = await keys.get(idempotencyKey("k-checkout"));
		if (claim === null || claim.state !== "claimed") throw new Error("expected a CLAIMED key");
		expect(claim.doc.totals.appliedCouponCode).toBe("SAVE5");
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(1);
		const sweep = () =>
			reconcileCouponRedemptions(
				{ couponStore: fx.coupons.store, orderStore: fx.orders.store, clock: fx.orders.clock },
				{ graceMs: 5 * 60 * 1000 },
			);

		// Past the grace, inside the claim's hold: kept, and nothing written.
		fx.orders.advance(10 * 60 * 1000);
		expect(await sweep()).toBe(0);
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(1);
		expect(await orders.get(claim.orderId)).toBeNull();
		expect((await keys.get(idempotencyKey("k-checkout")))?.state).toBe("claimed");

		// Past the hold: freed — and still no order was conjured.
		fx.orders.advance(10 * 60 * 1000);
		expect(await sweep()).toBe(1);
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(0);
		expect(await orders.get(claim.orderId)).toBeNull();
		expect((await keys.get(idempotencyKey("k-checkout")))?.state).toBe("claimed");
	});

	test("a PAID order does NOT release its coupon — the use stays consumed", async () => {
		const fx = fixture();
		const order = await checkout(fx);
		const raw = fx.orders.stripeGateway.webhook({
			outcome: "succeeded",
			orderId: order.id,
			providerRef: `pi_${order.id}`,
			amount: order.totals.total,
			currency: "USD",
			dedupeKey: `evt-ok-${order.id}`,
		});
		const settled = await settleOrder(fx.settleDeps, fx.orders.stripeGateway, raw);
		expect(settled.ok).toBe(true);
		expect((await fx.orders.store.getById(order.id))?.state).toBe("paid");
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(1);
		// And the record is still there, which is what forbids deleting the coupon.
		expect(await fx.coupons.store.delete("cpn")).toEqual({
			ok: false,
			reason: "in_use_by_redemptions",
		});
	});
});
