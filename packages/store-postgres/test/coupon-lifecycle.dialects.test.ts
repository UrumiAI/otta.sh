import {
	cents,
	createOrderFromCart,
	currency,
	expireOrders,
	idempotencyKey,
	settleOrder,
} from "@otta-sh/domain";
import { afterEach, describe, expect, test } from "vitest";
import {
	makePgOrderFlow,
	makeSqliteOrderFlow,
	type OrderFlowHarness,
	teardownOrderFlow,
} from "./order-harness.js";

const PG = process.env.PG_CONNECTION_STRING;
const USD = currency("USD");

afterEach(teardownOrderFlow);

async function seedCoupon(h: OrderFlowHarness): Promise<void> {
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
		maxUses: 5,
		maxUsesPerCustomer: null,
	});
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

// Review I2: the coupon lifecycle must stay symmetric with inventory — a durable
// pending order that EXPIRES or has payment FAIL frees its coupon; a PAID order
// keeps it consumed.
function suite(makeHarness: () => Promise<OrderFlowHarness>, dialect: string): void {
	describe(`coupon lifecycle [${dialect}]`, () => {
		async function checkout(h: OrderFlowHarness) {
			await h.seedPhysical({
				productId: "p1",
				sku: "SKU-1",
				priceCents: 1500,
				title: "Widget",
				onHand: 5,
			});
			await seedCoupon(h);
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			]);
			const res = await createOrderFromCart(h.createDeps, cmd(cartId));
			if (!res.ok) throw new Error(res.reason);
			expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
			return res.order;
		}

		test("after a durable order EXPIRES, uses_count returns to its pre-redemption value", async () => {
			const h = await makeHarness();
			const order = await checkout(h);
			// Advance past the checkout TTL and run the expiry sweep.
			h.clock.advance(16 * 60 * 1000);
			const expired = await expireOrders(h.expireDeps);
			expect(expired).toBe(1);
			expect((await h.orderStore.getById(order.id))?.state).toBe("expired");
			// Symmetric with the inventory release: the coupon is freed.
			expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(0);
		});

		test("after a durable order's payment FAILS, uses_count returns to its pre-redemption value", async () => {
			const h = await makeHarness();
			const order = await checkout(h);
			const raw = h.stripeGw.webhook({
				outcome: "failed",
				orderId: order.id,
				providerRef: `pi_${order.id}`,
				amount: order.totals.total,
				currency: "USD",
				dedupeKey: `evt-fail-${order.id}`,
			});
			const settled = await settleOrder(h.settleDeps, h.stripeGw, raw);
			expect(settled.ok).toBe(true);
			expect((await h.orderStore.getById(order.id))?.state).toBe("failed");
			expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(0);
		});

		test("a PAID order does NOT release its coupon — the use stays consumed", async () => {
			const h = await makeHarness();
			const order = await checkout(h);
			const raw = h.stripeGw.webhook({
				outcome: "succeeded",
				orderId: order.id,
				providerRef: `pi_${order.id}`,
				amount: order.totals.total,
				currency: "USD",
				dedupeKey: `evt-ok-${order.id}`,
			});
			const settled = await settleOrder(h.settleDeps, h.stripeGw, raw);
			expect(settled.ok).toBe(true);
			expect((await h.orderStore.getById(order.id))?.state).toBe("paid");
			// A completed/paid order keeps its coupon consumed.
			expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
		});
	});
}

suite(makeSqliteOrderFlow, "sqlite");
if (PG !== undefined) suite(makePgOrderFlow, "postgres");
