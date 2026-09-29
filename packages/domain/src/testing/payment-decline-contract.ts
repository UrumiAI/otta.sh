import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, reservationId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import { expireOrders, type ExpireOrdersDeps } from "../orders/expire-orders.js";
import type { Order } from "../orders/model.js";
import { settleOrder, type SettleDeps } from "../orders/settle-order.js";
import { FakePaymentGateway } from "./fake-payment-gateway.js";

const USD = currency("USD");

/** Stock seeded per case, and how much of it the order holds. */
const ON_HAND = 5;
const QTY = 2;
const UNIT_CENTS = 750;
const DISCOUNT_CENTS = 500;
const TOTAL_CENTS = UNIT_CENTS * QTY - DISCOUNT_CENTS;

/** The order's hold window — the same 15 minutes a checkout hold gets. */
const HOLD_MS = 15 * 60 * 1000;

/**
 * The stores a declined payment touches, as ONE adapter family wires them. The two
 * dependency bundles MUST share their stores and clock: the decline is settled
 * through one and the abandoned order is expired through the other, and the spec is
 * precisely about what the second sees of the first. (The coupon store is read off
 * `expireDeps`: settlement no longer touches coupons at all.)
 */
export interface PaymentDeclineHarness {
	settleDeps: SettleDeps;
	expireDeps: ExpireOrdersDeps;
	/**
	 * A `held` reservation of `qty` units that `adopt` will accept — i.e. carrying
	 * the checkout's hold deadline. A bare `reserve` leaves some adapters' holds
	 * unstamped (the deadline is the cart's to set), so the adapter family supplies
	 * its own production path for the stamp rather than the spec guessing at it.
	 */
	holdForCheckout(sku: string, qty: number, key: string, expiresAt: string): Promise<string>;
}

export interface PaymentDeclineContractOptions {
	dialect: string;
}

interface Seeded {
	order: Order;
	sku: string;
	couponId: string;
	/** The instant the order's hold lapses — the expiry sweep's "due" line. */
	holdExpiresAt: Date;
}

/**
 * A pending PHYSICAL order that holds `QTY` units and has consumed one coupon use —
 * built through the ports alone (seed → reserve → create → adopt → redeem), so the
 * fake and every document-store dialect seed byte-identically.
 */
async function seedPendingOrder(h: PaymentDeclineHarness, n: string): Promise<Seeded> {
	const { inventoryStore, orderStore, clock } = h.settleDeps;
	const { couponStore } = h.expireDeps;
	const now = clock.now();
	const nowIso = now.toISOString();
	const holdExpiresAt = new Date(now.getTime() + HOLD_MS);
	const skuStr = `SKU-DECLINE-${n}`;
	const oid = orderId(`ord-decline-${n}`);

	await inventoryStore.seedOnHand(skuStr, ON_HAND);
	const heldId = await h.holdForCheckout(
		skuStr,
		QTY,
		`decline-res-${n}`,
		holdExpiresAt.toISOString(),
	);

	const created = await orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`decline-order-${n}`),
		holdExpiresAt: holdExpiresAt.toISOString(),
		buyerRef: `buyer-${n}@example.com`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId(`p-decline-${n}`),
				sku: sku(skuStr),
				title: "Widget",
				unitPrice: cents(UNIT_CENTS),
				currency: USD,
				quantity: QTY,
				fulfillmentKind: "physical",
				reservationId: reservationId(heldId),
			},
		],
		totals: {
			subtotal: cents(UNIT_CENTS * QTY),
			discount: cents(DISCOUNT_CENTS),
			total: cents(TOTAL_CENTS),
			currency: USD,
			appliedCouponCode: `DECLINE${n}`,
		},
	});
	const adopted = await inventoryStore.adopt({
		reservationId: heldId,
		orderId: oid,
		holdExpiresAt: holdExpiresAt.toISOString(),
		now: nowIso,
	});
	if (!adopted.ok) throw new Error(`seed adopt failed: ${adopted.reason}`);

	const coupon = await couponStore.create({
		id: `cpn-decline-${n}`,
		code: `DECLINE${n}`,
		type: "fixed_amount",
		amountCents: cents(DISCOUNT_CENTS),
		rateBps: null,
		capCents: null,
		currency: USD,
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: 10,
		maxUsesPerCustomer: null,
	});
	const redeemed = await couponStore.redeem({
		couponId: coupon.id,
		orderId: oid,
		idempotencyKey: idempotencyKey(`decline-redeem-${n}`),
		createdAt: nowIso,
	});
	if (!redeemed.ok) throw new Error(`seed redeem failed: ${redeemed.reason}`);

	return { order: created.order, sku: skuStr, couponId: coupon.id, holdExpiresAt };
}

async function state(h: PaymentDeclineHarness, id: OrderId): Promise<Order> {
	const order = await h.settleDeps.orderStore.getById(id);
	if (order === null) throw new Error(`order ${id} vanished`);
	return order;
}

async function couponUses(h: PaymentDeclineHarness, couponId: string): Promise<number> {
	return (await h.expireDeps.couponStore.findById(couponId))?.usesCount ?? -1;
}

async function onHand(h: PaymentDeclineHarness, s: string): Promise<number> {
	return h.settleDeps.inventoryStore.getOnHand(s);
}

/**
 * THE DECLINE SPEC (ADR-0022, issue #304). A verified `payment_failed` is
 * INFORMATIONAL: Stripe leaves the PaymentIntent payable after a decline and the
 * pay page retries on the same client secret, so the order stays `pending` with its
 * stock held and its coupon consumed. Whether the buyer then pays or walks away is
 * decided by the two paths that already exist — the `succeeded` settle and the
 * order-expiry sweep — and this suite pins both ends.
 *
 * Every observation is made through the ports (`getById`, `getOnHand`,
 * `findById`, `orderForDedupeKey`), so the same cases run on the in-memory fake and
 * on every document-store dialect.
 */
export function paymentDeclineContract(
	makeHarness: () => PaymentDeclineHarness | Promise<PaymentDeclineHarness>,
	opts: PaymentDeclineContractOptions,
): void {
	describe(`paymentDeclineContract [${opts.dialect}]`, () => {
		const gateway = new FakePaymentGateway({ id: "stripe" });

		function event(order: Order, outcome: "succeeded" | "failed", dedupeKey: string) {
			return gateway.webhook({
				outcome,
				orderId: order.id,
				// One PaymentIntent for the whole order: a retry after a decline is a
				// second confirmation of the SAME intent, which is the whole bug.
				providerRef: `pi_${order.id}`,
				amount: TOTAL_CENTS,
				currency: "USD",
				dedupeKey,
			});
		}

		test("a declined payment keeps the order pending, its stock held and its coupon consumed", async () => {
			const h = await makeHarness();
			const { order, sku: s, couponId } = await seedPendingOrder(h, "1");
			expect(await onHand(h, s)).toBe(ON_HAND - QTY);
			expect(await couponUses(h, couponId)).toBe(1);

			const res = await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_1"));

			expect(res.ok).toBe(true);
			if (res.ok) expect(res.noop).toBe(true);
			const after = await state(h, order.id);
			expect(after.state).toBe("pending");
			expect(after.reconciliationFlag).toBeNull();
			expect(await onHand(h, s), "the decline returns no stock").toBe(ON_HAND - QTY);
			expect(await couponUses(h, couponId), "the decline frees no coupon use").toBe(1);
		});

		test("the decline is recorded once, against its order; a replay of the same event id changes nothing", async () => {
			const h = await makeHarness();
			const { order, sku: s, couponId } = await seedPendingOrder(h, "2");

			await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_2"));
			// The audit row: the event id is claimed, and it names this order.
			expect(await h.settleDeps.paymentEventStore.orderForDedupeKey("evt_fail_2")).toBe(order.id);

			const replay = await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_2"));

			expect(replay.ok).toBe(true);
			if (replay.ok) expect(replay.noop).toBe(true);
			// Still claimed exactly once — a fresh claim of the same key is refused.
			expect(
				await h.settleDeps.paymentEventStore.dedupe(
					"evt_fail_2",
					order.id,
					"stripe",
					h.settleDeps.clock.now().toISOString(),
				),
			).toBe(false);
			const after = await state(h, order.id);
			expect(after.state).toBe("pending");
			expect(await onHand(h, s)).toBe(ON_HAND - QTY);
			expect(await couponUses(h, couponId)).toBe(1);
		});

		test("declined, then paid on the same PaymentIntent: the order ends paid, stock committed once, no reconciliation flag", async () => {
			const h = await makeHarness();
			const { order, sku: s, couponId } = await seedPendingOrder(h, "3");

			await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_3a"));
			// A second decline (another bad card) is just as informational.
			await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_3b"));
			const paid = await settleOrder(h.settleDeps, gateway, event(order, "succeeded", "evt_ok_3"));

			expect(paid.ok).toBe(true);
			if (paid.ok) expect(paid.noop).toBe(false);
			const after = await state(h, order.id);
			expect(after.state).toBe("paid");
			expect(after.reconciliationFlag, "no PAID_FLIP_LOST, no manual reconciliation").toBeNull();
			expect(await onHand(h, s), "the held units are the committed units").toBe(ON_HAND - QTY);
			expect(await couponUses(h, couponId), "a paid order keeps its coupon use").toBe(1);
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toHaveLength(1);

			// Committed, not merely still held: the expiry sweep, run long after the
			// hold would have lapsed, has nothing to release.
			const later = new Date(h.settleDeps.clock.now().getTime() + 2 * HOLD_MS);
			expect(await expireOrders(h.expireDeps, later)).toBe(0);
			expect(await onHand(h, s)).toBe(ON_HAND - QTY);
			expect(await couponUses(h, couponId)).toBe(1);
		});

		test("a late decline delivered after the success leaves the paid order exactly as it was", async () => {
			const h = await makeHarness();
			const { order, sku: s, couponId } = await seedPendingOrder(h, "4");

			await settleOrder(h.settleDeps, gateway, event(order, "succeeded", "evt_ok_4"));
			// Stripe does not promise delivery order: the earlier attempt's decline can
			// arrive after the success it preceded.
			const late = await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_4"));

			expect(late.ok).toBe(true);
			if (late.ok) expect(late.noop).toBe(true);
			const after = await state(h, order.id);
			expect(after.state).toBe("paid");
			expect(after.reconciliationFlag).toBeNull();
			expect(await onHand(h, s)).toBe(ON_HAND - QTY);
			expect(await couponUses(h, couponId)).toBe(1);
		});

		test("declined and never paid: the expiry sweep releases the stock and the coupon exactly once", async () => {
			const h = await makeHarness();
			const { order, sku: s, couponId, holdExpiresAt } = await seedPendingOrder(h, "5");
			await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_5"));

			// Before the hold lapses, the sweep leaves a declined order alone — the
			// buyer is still inside the window in which a retry can pay it.
			const early = new Date(holdExpiresAt.getTime() - 60_000);
			expect(await expireOrders(h.expireDeps, early)).toBe(0);
			expect((await state(h, order.id)).state).toBe("pending");
			expect(await onHand(h, s)).toBe(ON_HAND - QTY);

			const due = new Date(holdExpiresAt.getTime() + 60_000);
			expect(await expireOrders(h.expireDeps, due)).toBe(1);
			expect((await state(h, order.id)).state).toBe("expired");
			expect(await onHand(h, s), "every held unit is back").toBe(ON_HAND);
			expect(await couponUses(h, couponId), "the coupon use is freed").toBe(0);

			// A second sweep, and a replayed decline, move nothing further.
			expect(await expireOrders(h.expireDeps, due)).toBe(0);
			await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_5"));
			expect((await state(h, order.id)).state).toBe("expired");
			expect(await onHand(h, s)).toBe(ON_HAND);
			expect(await couponUses(h, couponId)).toBe(0);
		});

		test("a success arriving after the hold lapsed but BEFORE the sweep ran still settles; the sweep then has nothing to do", async () => {
			const h = await makeHarness();
			const { order, sku: s, couponId, holdExpiresAt } = await seedPendingOrder(h, "7");
			await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_7"));
			// Past the deadline, but no sweep has run: the order is still `pending`, so
			// the retry that pays now is a clean settle, not a reconciliation case.
			const lapsed = new Date(holdExpiresAt.getTime() + 60_000);
			const late = { ...h.settleDeps, clock: { now: () => lapsed } };

			const res = await settleOrder(late, gateway, event(order, "succeeded", "evt_ok_7"));

			expect(res.ok).toBe(true);
			if (res.ok) expect(res.noop).toBe(false);
			const after = await state(h, order.id);
			expect(after.state).toBe("paid");
			expect(after.reconciliationFlag).toBeNull();
			expect(await onHand(h, s)).toBe(ON_HAND - QTY);
			// The sweep that would have expired it finds nothing to expire or release.
			expect(await expireOrders(h.expireDeps, new Date(lapsed.getTime() + 60_000))).toBe(0);
			expect((await state(h, order.id)).state).toBe("paid");
			expect(await onHand(h, s)).toBe(ON_HAND - QTY);
			expect(await couponUses(h, couponId)).toBe(1);
		});

		test("a success arriving after the order expired is flagged for reconciliation, exactly as before", async () => {
			const h = await makeHarness();
			const { order, sku: s, couponId, holdExpiresAt } = await seedPendingOrder(h, "6");
			await settleOrder(h.settleDeps, gateway, event(order, "failed", "evt_fail_6"));
			expect(await expireOrders(h.expireDeps, new Date(holdExpiresAt.getTime() + 60_000))).toBe(1);

			const res = await settleOrder(h.settleDeps, gateway, event(order, "succeeded", "evt_ok_6"));

			expect(res.ok).toBe(true);
			if (res.ok) expect(res.noop).toBe(true);
			const after = await state(h, order.id);
			// Money moved on an order that can no longer settle: never silently paid,
			// never silently dropped — the manual-reconciliation flag (SETTLE_ON_NON_PENDING).
			expect(after.state).toBe("expired");
			expect(after.reconciliationFlag).not.toBeNull();
			expect(await onHand(h, s), "released stock is not re-taken").toBe(ON_HAND);
			expect(await couponUses(h, couponId)).toBe(0);
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toHaveLength(0);
		});
	});
}
