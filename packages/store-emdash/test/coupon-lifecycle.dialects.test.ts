/**
 * The coupon lifecycle, driven end to end through the real checkout use-cases —
 * ported from the SQL adapter's suite of the same name, case for case.
 *
 * Nothing here calls `redeem` or `release` directly: the coupon is consumed by
 * `createOrderFromCart` and freed by `expireOrders` or by the payment-failure half of
 * `settleOrder`, over the real cart, inventory and order documents. That is the point
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
	settleOrder,
	type CreateOrderDeps,
	type ExpireOrdersDeps,
	type SettleDeps,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import { COUPON_LIFECYCLE_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness, type CouponHarness } from "./coupon-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
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
			settleDeps: { ...orders.settleDeps, couponStore: coupons.store },
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

	test("after a durable order's payment FAILS, usesCount returns to its pre-redemption value", async () => {
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
		expect((await fx.orders.store.getById(order.id))?.state).toBe("failed");
		expect((await fx.coupons.store.findById("cpn"))?.usesCount).toBe(0);
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
