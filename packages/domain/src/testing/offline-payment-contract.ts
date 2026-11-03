import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, reservationId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import { cancelOrder } from "../orders/cancel-order.js";
import { expireOrdersBatch } from "../orders/expire-orders.js";
import type { Order, PaymentMethod } from "../orders/model.js";
import { OFFLINE_HOLD_EXPIRES_AT, offlinePaymentRef } from "../orders/payment-methods.js";
import {
	adminNextStates,
	transitionOrderAsAdmin,
	type TransitionOrderDeps,
} from "../orders/transition.js";
import { NOOP_LOGGER } from "../ports/logger.js";
import type { PaymentDeclineHarness } from "./payment-decline-contract.js";

const USD = currency("USD");
const UNIT_CENTS = 700;
const QTY = 2;
const ON_HAND = 10;

export interface OfflinePaymentContractOptions {
	dialect: string;
}

/**
 * A pending order placed with `method` over one physical line of {@link QTY}
 * units held for it, built through the ports alone so every adapter family seeds
 * it byte-identically. An offline order carries the offline hold deadline, as
 * `createOrderFromCart` places it (ADR-0044).
 */
async function seedOrder(
	h: PaymentDeclineHarness,
	n: string,
	method: PaymentMethod,
	kind: "physical" | "digital" = "physical",
): Promise<{ order: Order; sku: string }> {
	const { inventoryStore, orderStore, clock } = h.settleDeps;
	const holdExpiresAt =
		method === "cod"
			? OFFLINE_HOLD_EXPIRES_AT
			: new Date(clock.now().getTime() + 15 * 60 * 1000).toISOString();
	const s = `SKU-OFF-${n}`;
	let held: string | null = null;
	if (kind === "physical") {
		await inventoryStore.seedOnHand(s, ON_HAND);
		held = await h.holdForCheckout(s, QTY, `offline-res-${n}`, holdExpiresAt);
	}
	const oid = orderId(`ord-offline-${n}`);
	const total = UNIT_CENTS * QTY;
	const created = await orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`offline-order-${n}`),
		holdExpiresAt,
		buyerRef: `buyer-${n}@example.com`,
		paymentMethod: method,
		lines: [
			{
				productId: productId(`p-offline-${n}`),
				sku: sku(s),
				title: "Widget",
				unitPrice: cents(UNIT_CENTS),
				currency: USD,
				quantity: QTY,
				fulfillmentKind: kind,
				reservationId: held === null ? null : reservationId(held),
			},
		],
		totals: { subtotal: cents(total), total: cents(total), currency: USD },
	});
	if (held !== null) {
		const adopted = await inventoryStore.adoptMany({
			reservationIds: [held],
			orderId: oid,
			holdExpiresAt,
			now: clock.now().toISOString(),
		});
		if (adopted.lost.length > 0) throw new Error("seed adopt lost");
	}
	return { order: created.order, sku: s };
}

function adminDeps(h: PaymentDeclineHarness): TransitionOrderDeps {
	const { orderStore, entitlementStore, inventoryStore, paymentEventStore, clock } = h.settleDeps;
	return {
		orderStore,
		entitlementStore,
		offlinePayment: { inventoryStore, paymentEventStore, clock },
	};
}

function markPaid(h: PaymentDeclineHarness, id: OrderId, key = `mark-paid:${id}`) {
	return transitionOrderAsAdmin(adminDeps(h), {
		orderId: id,
		toState: "paid",
		idempotencyKey: idempotencyKey(key),
		actor: "Ops",
	});
}

/**
 * The OFFLINE payment lifecycle (ADR-0044, cash on delivery) against every
 * adapter family: an offline order never expires and keeps its stock until a
 * person marks it paid (payment recorded, stock committed, downloads granted,
 * exactly once) or cancels it (stock released). A gateway order is still refused
 * a manual mark-paid (ADR-0026 Decision 1).
 */
export function offlinePaymentContract(
	makeHarness: () => PaymentDeclineHarness | Promise<PaymentDeclineHarness>,
	opts: OfflinePaymentContractOptions,
): void {
	describe(`offlinePaymentContract [${opts.dialect}]`, () => {
		test("an offline (cod) order never expires: a sweep long after placement leaves it pending with its stock held", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "1", "cod");
			expect(await h.settleDeps.inventoryStore.getOnHand(s)).toBe(ON_HAND - QTY);
			const yearLater = new Date(h.settleDeps.clock.now().getTime() + 365 * 24 * 3600 * 1000);
			expect(await h.settleDeps.orderStore.listExpirable(yearLater.toISOString())).toEqual([]);
			await expireOrdersBatch(h.expireDeps, yearLater);
			expect((await h.settleDeps.orderStore.getById(order.id))?.state).toBe("pending");
			expect(await h.settleDeps.inventoryStore.getOnHand(s)).toBe(ON_HAND - QTY);
		});

		test("the console offers Mark paid on a pending cod order, and never on a pending stripe order", async () => {
			const h = await makeHarness();
			const cod = await seedOrder(h, "2a", "cod");
			const card = await seedOrder(h, "2b", "stripe");
			const none = { payments: [], refunds: [] };
			expect(adminNextStates(cod.order, none)).toContain("paid");
			expect(adminNextStates(card.order, none)).not.toContain("paid");
		});

		test("Mark paid on a cod order records the payment, commits the stock and emails the confirmation once", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "3", "cod");
			const res = await markPaid(h, order.id);
			expect(res).toMatchObject({ ok: true, transitioned: true });
			const paid = await h.settleDeps.orderStore.getById(order.id);
			expect(paid?.state).toBe("paid");
			expect(paid?.paidProviderRef).toBe(offlinePaymentRef("cod", order.id));
			const captured = await h.settleDeps.orderStore.getCapturedPayments(order.id);
			expect(captured).toHaveLength(1);
			expect(captured[0]).toMatchObject({
				gateway: "cod",
				providerRef: offlinePaymentRef("cod", order.id),
				amount: UNIT_CENTS * QTY,
				currency: "USD",
				status: "succeeded",
			});
			// Committed, not merely adopted: a release by the order returns nothing.
			await h.settleDeps.inventoryStore.releaseAdoptedMany(
				order.lines.flatMap((l) => (l.reservationId === null ? [] : [l.reservationId])),
				order.id,
			);
			expect(await h.settleDeps.inventoryStore.getOnHand(s)).toBe(ON_HAND - QTY);
			// One confirmation row ("we've received your payment" — the cash arrived).
			const now = h.settleDeps.clock.now().toISOString();
			const row = await h.settleDeps.orderStore.claimNextEmailForOrder(order.id, now, now);
			expect(row?.toState).toBe("paid");
			expect(row?.notice ?? null).toBeNull();
		});

		test("a replayed Mark paid is a no-op: one payment row, the stock committed once", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "4", "cod");
			await markPaid(h, order.id);
			const replay = await markPaid(h, order.id, "another-click");
			expect(replay).toMatchObject({ ok: true, transitioned: false });
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toHaveLength(1);
			expect(await h.settleDeps.inventoryStore.getOnHand(s)).toBe(ON_HAND - QTY);
		});

		test("Mark paid on a digital cod order grants its download", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "5", "cod", "digital");
			await markPaid(h, order.id);
			expect(await h.settleDeps.entitlementStore.check({ orderId: order.id, sku: sku(s) })).toBe(
				true,
			);
		});

		test("a stripe order is still refused a manual Mark paid (ADR-0026)", async () => {
			const h = await makeHarness();
			const { order } = await seedOrder(h, "6", "stripe");
			expect(await markPaid(h, order.id)).toEqual({
				ok: false,
				reason: "MANUAL_PAYMENT_NOT_ALLOWED",
			});
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toEqual([]);
		});

		test("cancelling a pending cod order returns its stock and records no payment", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "7", "cod");
			const res = await cancelOrder(
				{ orderStore: h.settleDeps.orderStore, logger: NOOP_LOGGER },
				{
					orderId: order.id,
					reason: "customer_request",
					cancelledBy: "Ops",
					idempotencyKey: idempotencyKey(`cancel:${order.id}`),
				},
			);
			expect(res).toMatchObject({ ok: true, cancelled: true });
			// The cancel records the release (the document store's intent, completed
			// by the hold-intents leg); the order-scoped release it stands for is run
			// here. It is idempotent, so the units come back exactly once — and only
			// because they were still adopted, never committed.
			await h.settleDeps.inventoryStore.releaseAdoptedMany(
				order.lines.flatMap((l) => (l.reservationId === null ? [] : [l.reservationId])),
				order.id,
			);
			expect(await h.settleDeps.inventoryStore.getOnHand(s)).toBe(ON_HAND);
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toEqual([]);
			// A cancelled cod order can no longer be marked paid.
			expect(await markPaid(h, order.id)).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
		});

		test("Mark paid on an offline order without the payment wiring throws before writing anything", async () => {
			const h = await makeHarness();
			const { order } = await seedOrder(h, "8", "cod");
			await expect(
				transitionOrderAsAdmin(
					{ orderStore: h.settleDeps.orderStore },
					{ orderId: order.id, toState: "paid", idempotencyKey: idempotencyKey("bare") },
				),
			).rejects.toThrow(/offlinePayment/);
			expect((await h.settleDeps.orderStore.getById(order.id))?.state).toBe("pending");
		});
	});
}
