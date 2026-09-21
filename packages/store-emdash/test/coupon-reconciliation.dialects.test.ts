/**
 * The coupon reconciliation sweep — ported from the SQL adapter's suite of the same
 * name, case for case, over the real `EmdashCouponStore` and `EmdashOrderStore`.
 *
 * `reconcileCouponRedemptions` pairs every redemption older than the grace window with
 * its order: a redemption whose order never became durable (a crash mid-request) is
 * released, and one whose order exists is left alone. Two things this store has to get
 * right for that to work, and the SQL adapter did not have to think about either:
 *
 * - `listRedemptionsCreatedBefore` is a RANGE on `createdAt` plus an ORDER BY on it,
 *   which means both must be declared indexes or the read throws.
 * - a REFUSED redemption key keeps a document (that is what makes a replay answer the
 *   same way twice), and the sweep must not see it. The SQL adapter rolled its row
 *   back, so "refused" and "never existed" were the same state; here the `holdsUse`
 *   mirror is what keeps them apart.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	reconcileCouponRedemptions,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import { COUPON_LIFECYCLE_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness, type CouponHarness } from "./coupon-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";

const USD = currency("USD");
const GRACE = { graceMs: 15 * 60 * 1000 };

/** The sweep runs at 01:00; with a 15-minute grace the cutoff is 00:45. */
const NOW = new Date("2026-07-10T01:00:00.000Z");

describeEachDialect("coupon reconciliation sweep", (ctx) => {
	const bound = ctx.useStorage(COUPON_LIFECYCLE_LAYOUT);

	function fixture(): { orders: OrderHarness; coupons: CouponHarness } {
		const orders = makeOrderHarness(bound.storage);
		orders.clock.advance(NOW.getTime() - orders.clock.now().getTime());
		return { orders, coupons: makeCouponHarness(bound.storage, { clock: orders.clock }) };
	}

	async function seedCoupon(coupons: CouponHarness): Promise<void> {
		await coupons.store.create({
			id: "c1",
			code: "SWEEP",
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: USD,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: 10,
			maxUsesPerCustomer: null,
		});
	}

	test("releases a redemption whose order never became durable within the grace window, and leaves alone one whose order exists", async () => {
		const fx = fixture();
		await seedCoupon(fx.coupons);

		// Redemption A: its order NEVER became durable (a crash mid-request), created
		// before the cutoff.
		const a = await fx.coupons.store.redeem({
			couponId: "c1",
			orderId: orderId("o-stranded"),
			idempotencyKey: idempotencyKey("k-a"),
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		// Redemption B: its order IS durable — must be left alone.
		await fx.orders.seedOrder({
			id: "o-durable",
			state: "pending",
			currency: "USD",
			totalCents: 500,
			buyerRef: "b@example.com",
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		const b = await fx.coupons.store.redeem({
			couponId: "c1",
			orderId: orderId("o-durable"),
			idempotencyKey: idempotencyKey("k-b"),
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect((await fx.coupons.store.findById("c1"))?.usesCount).toBe(2);

		const released = await reconcileCouponRedemptions(
			{ couponStore: fx.coupons.store, orderStore: fx.orders.store, clock: fx.orders.clock },
			GRACE,
		);
		expect(released).toBe(1);

		// A was released (record gone, use returned); B untouched.
		const remaining = await fx.coupons.store.listRedemptionsCreatedBefore(
			"9999-12-31T00:00:00.000Z",
		);
		expect(remaining.map((r) => r.id)).toEqual([b.redemptionId]);
		expect((await fx.coupons.store.findById("c1"))?.usesCount).toBe(1);
	});

	test("does not release a stranded redemption still inside the grace window", async () => {
		const fx = fixture();
		await seedCoupon(fx.coupons);
		// Created at 00:50, cutoff is 00:45 ⇒ not yet eligible.
		await fx.coupons.store.redeem({
			couponId: "c1",
			orderId: orderId("o-recent"),
			idempotencyKey: idempotencyKey("k-recent"),
			createdAt: "2026-07-10T00:50:00.000Z",
		});
		const released = await reconcileCouponRedemptions(
			{ couponStore: fx.coupons.store, orderStore: fx.orders.store, clock: fx.orders.clock },
			GRACE,
		);
		expect(released).toBe(0);
		expect((await fx.coupons.store.findById("c1"))?.usesCount).toBe(1);
	});

	test("a REFUSED redemption key is never swept: it holds no use, so there is nothing to release", async () => {
		const fx = fixture();
		await fx.coupons.store.create({
			id: "c2",
			code: "ONEUSE",
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
		const at = "2026-07-10T00:00:00.000Z";
		const spent = await fx.coupons.store.redeem({
			couponId: "c2",
			orderId: orderId("o-spent"),
			idempotencyKey: idempotencyKey("k-spent"),
			createdAt: at,
		});
		expect(spent.ok).toBe(true);
		expect(
			await fx.coupons.store.redeem({
				couponId: "c2",
				orderId: orderId("o-refused"),
				idempotencyKey: idempotencyKey("k-refused"),
				createdAt: at,
			}),
		).toEqual({ ok: false, reason: "COUPON_EXHAUSTED" });

		// The refusal keeps a document, and the reconciliation read does not see it.
		expect(await fx.coupons.redemptions.count({ couponId: "c2" })).toBe(2);
		const listed = await fx.coupons.store.listRedemptionsCreatedBefore("9999-12-31T00:00:00.000Z");
		expect(listed.map((r) => r.orderId)).toEqual(["o-spent"]);

		// Neither order is durable, so the sweep releases the ONE real use and nothing
		// else — a refusal that got swept would decrement a use it never took.
		const released = await reconcileCouponRedemptions(
			{ couponStore: fx.coupons.store, orderStore: fx.orders.store, clock: fx.orders.clock },
			GRACE,
		);
		expect(released).toBe(1);
		expect((await fx.coupons.store.findById("c2"))?.usesCount).toBe(0);
	});
});
