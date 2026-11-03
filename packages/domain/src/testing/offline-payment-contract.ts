import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, reservationId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import { cancelOrder, cancelOrderWithRefund } from "../orders/cancel-order.js";
import {
	cancelUnpaidOfflineOrders,
	CouponReleaseDeferredError,
} from "../orders/cancel-unpaid-offline.js";
import { RecordingLogger } from "./recording-logger.js";
import { expireOrdersBatch } from "../orders/expire-orders.js";
import type { Order, OrderState, PaymentMethod } from "../orders/model.js";
import { offlinePaymentRef } from "../orders/payment-methods.js";
import { recordFulfillment } from "../orders/record-fulfillment.js";
import {
	adminNextStates,
	transitionOrder,
	transitionOrderAsAdmin,
	type TransitionOrderDeps,
} from "../orders/transition.js";
import { NOOP_LOGGER } from "../ports/logger.js";
import type { OutboxEmail } from "../ports/order-store.js";
import type { PaymentDeclineHarness } from "./payment-decline-contract.js";

const USD = currency("USD");
const UNIT_CENTS = 700;
const QTY = 2;
const ON_HAND = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const FAR = "2999-01-01T00:00:00.000Z";

export interface OfflinePaymentContractOptions {
	dialect: string;
}

const ADDRESS = {
	name: "Asha Rao",
	line1: "12 MG Road",
	line2: null,
	city: "Pune",
	region: null,
	postalCode: "411001",
	country: "IN",
	email: null,
	phone: "+91 98765 43210",
};

/**
 * An order placed with `method` over one line of {@link QTY} units, built through
 * the ports alone, so every adapter family seeds it byte-identically. A cod order
 * is moved `pending → awaiting_payment`, as checkout places it (ADR-0044); a
 * stripe order stays `pending`.
 */
async function seedOrder(
	h: PaymentDeclineHarness,
	n: string,
	method: PaymentMethod,
	opts: {
		kind?: "physical" | "digital";
		buyerRef?: string;
		clientKey?: string;
		couponCode?: string;
	} = {},
): Promise<{ order: Order; sku: string }> {
	const kind = opts.kind ?? "physical";
	const { inventoryStore, orderStore, clock } = h.settleDeps;
	const holdExpiresAt = new Date(clock.now().getTime() + 15 * 60 * 1000).toISOString();
	const s = `SKU-OFF-${n}`;
	let held: string | null = null;
	if (kind === "physical") {
		await inventoryStore.seedOnHand(s, ON_HAND);
		held = await h.holdForCheckout(s, QTY, `offline-res-${n}`, holdExpiresAt);
	}
	const oid = orderId(`ord-offline-${n}`);
	const total = UNIT_CENTS * QTY;
	await orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`offline-order-${n}`),
		holdExpiresAt,
		buyerRef: opts.buyerRef ?? `buyer-${n}@example.com`,
		paymentMethod: method,
		shippingAddress: ADDRESS,
		...(method === "cod" ? { offlineClientKey: opts.clientKey ?? `net-${n}` } : {}),
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
		totals: {
			subtotal: cents(total),
			total: cents(total),
			currency: USD,
			...(opts.couponCode !== undefined ? { appliedCouponCode: opts.couponCode } : {}),
		},
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
	if (method === "cod") {
		const placed = await orderStore.transition({
			orderId: oid,
			fromState: "pending",
			toState: "awaiting_payment",
			idempotencyKey: idempotencyKey(`place:${oid}`),
			enqueueEmail: true,
		});
		if (!placed.transitioned) throw new Error("seed could not place the offline order");
	}
	const order = await orderStore.getById(oid);
	if (order === null) throw new Error("seed lost its order");
	return { order, sku: s };
}

function adminDeps(h: PaymentDeclineHarness): TransitionOrderDeps {
	const { orderStore, entitlementStore, inventoryStore, paymentEventStore, clock } = h.settleDeps;
	return {
		orderStore,
		entitlementStore,
		offlinePayment: { inventoryStore, paymentEventStore, clock },
	};
}

function admin(h: PaymentDeclineHarness, id: OrderId, to: OrderState, key = `admin:${id}:${to}`) {
	return transitionOrderAsAdmin(adminDeps(h), {
		orderId: id,
		toState: to,
		idempotencyKey: idempotencyKey(key),
		actor: "Ops Person",
	});
}

function cancel(h: PaymentDeclineHarness, id: OrderId) {
	return cancelOrder(
		{ orderStore: h.settleDeps.orderStore, logger: NOOP_LOGGER },
		{
			orderId: id,
			reason: "customer_request",
			cancelledBy: "Ops Person",
			idempotencyKey: idempotencyKey(`cancel:${id}`),
		},
	);
}

/** Every outbox row of the order that is due, claimed under a far lease. */
async function outboxRows(h: PaymentDeclineHarness, id: OrderId): Promise<OutboxEmail[]> {
	const now = h.settleDeps.clock.now().toISOString();
	const rows: OutboxEmail[] = [];
	for (let i = 0; i < 20; i++) {
		const row = await h.settleDeps.orderStore.claimNextEmailForOrder(id, now, FAR);
		if (row === null) break;
		rows.push(row);
	}
	return rows;
}

function reservationIds(order: Order): string[] {
	return order.lines.flatMap((l) => (l.reservationId === null ? [] : [l.reservationId]));
}

/** Release whatever the order still holds `adopted` (the store's release intent
 *  stands for exactly this; order-scoped and idempotent) and report on-hand. */
async function onHandAfterRelease(h: PaymentDeclineHarness, order: Order, s: string) {
	await h.settleDeps.inventoryStore.releaseAdoptedMany(reservationIds(order), order.id);
	return h.settleDeps.inventoryStore.getOnHand(s);
}

/**
 * The OFFLINE (cash-on-delivery) lifecycle of ADR-0044 against every adapter
 * family: the two unpaid states, Mark paid as a recorded payment (with its actor,
 * once, safe to repeat and to race), ship-before-pay, cancel returning stock, the
 * open-order counts behind the caps, and the auto-cancel of stale unpaid orders.
 */
export function offlinePaymentContract(
	makeHarness: () => PaymentDeclineHarness | Promise<PaymentDeclineHarness>,
	opts: OfflinePaymentContractOptions,
): void {
	describe(`offlinePaymentContract [${opts.dialect}]`, () => {
		test("a placed cod order is awaiting_payment, emails 'order received' once, never expires and keeps its stock", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "1", "cod");
			expect(order.state).toBe("awaiting_payment");
			const rows = await outboxRows(h, order.id);
			expect(rows.map((r) => r.toState)).toEqual(["awaiting_payment"]);
			const yearLater = new Date(h.settleDeps.clock.now().getTime() + 365 * DAY_MS);
			expect(await h.settleDeps.orderStore.listExpirable(yearLater.toISOString())).toEqual([]);
			await expireOrdersBatch(h.expireDeps, yearLater);
			expect((await h.settleDeps.orderStore.getById(order.id))?.state).toBe("awaiting_payment");
			expect(await h.settleDeps.inventoryStore.getOnHand(s)).toBe(ON_HAND - QTY);
		});

		test("the console offers Mark paid and ship on a cod order, and neither on a card order", async () => {
			const h = await makeHarness();
			const cod = await seedOrder(h, "2a", "cod");
			const card = await seedOrder(h, "2b", "stripe");
			const none = { payments: [], refunds: [] };
			expect(adminNextStates(cod.order, none)).toEqual(["paid", "shipped_awaiting_payment"]);
			expect(adminNextStates(card.order, none)).not.toContain("paid");
			expect(adminNextStates(card.order, none)).not.toContain("awaiting_payment");
			// A hand-made request cannot park a card order unpaid either.
			const parked = await transitionOrder(
				{ orderStore: h.settleDeps.orderStore },
				{
					orderId: card.order.id,
					toState: "awaiting_payment",
					idempotencyKey: idempotencyKey("park"),
				},
			);
			expect(parked).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
		});

		test("Mark paid records the payment and its actor, commits the stock and emails the confirmation once — a replay changes nothing", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "3", "cod");
			await outboxRows(h, order.id);
			expect(await admin(h, order.id, "paid")).toMatchObject({ ok: true, transitioned: true });
			const paid = await h.settleDeps.orderStore.getById(order.id);
			expect(paid?.state).toBe("paid");
			expect(paid?.paidProviderRef).toBe(offlinePaymentRef("cod", order.id));
			const events = await h.settleDeps.orderStore.listEventsForOrder(order.id);
			// Found by its move, not its position: two events stamped at one instant
			// may list in either order.
			expect(events.find((e) => e.toState === "paid")).toMatchObject({
				fromState: "awaiting_payment",
				actor: "Ops Person",
			});
			const captured = await h.settleDeps.orderStore.getCapturedPayments(order.id);
			expect(captured).toEqual([
				expect.objectContaining({
					gateway: "cod",
					providerRef: offlinePaymentRef("cod", order.id),
					amount: UNIT_CENTS * QTY,
					status: "succeeded",
				}),
			]);
			expect(await onHandAfterRelease(h, order, s)).toBe(ON_HAND - QTY);

			const replay = await admin(h, order.id, "paid", "second-click");
			expect(replay).toMatchObject({ ok: true, transitioned: false });
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toHaveLength(1);
			const rows = await outboxRows(h, order.id);
			expect(rows.filter((r) => r.toState === "paid")).toHaveLength(1);
		});

		test("ship before pay: the shipment is recorded unpaid, then Mark paid lands it delivered", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "4", "cod");
			await outboxRows(h, order.id);
			const shipped = await recordFulfillment(
				{ orderStore: h.settleDeps.orderStore },
				{
					orderId: order.id,
					carrier: "Delhivery",
					trackingNumber: "DL123",
					trackingUrl: null,
					recordedBy: "Ops Person",
					idempotencyKey: idempotencyKey(`ship:${order.id}`),
				},
			);
			expect(shipped).toMatchObject({ ok: true, recorded: true });
			const inTransit = await h.settleDeps.orderStore.getById(order.id);
			expect(inTransit?.state).toBe("shipped_awaiting_payment");
			expect(inTransit?.fulfillment?.trackingNumber).toBe("DL123");
			expect((await outboxRows(h, order.id)).map((r) => r.toState)).toEqual([
				"shipped_awaiting_payment",
			]);
			// Unpaid: nothing captured, and only Mark paid (→ delivered) moves it on.
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toEqual([]);
			expect(adminNextStates(inTransit as Order, { payments: [], refunds: [] })).toEqual([
				"delivered",
			]);

			expect(await admin(h, order.id, "delivered")).toMatchObject({ ok: true, transitioned: true });
			expect((await h.settleDeps.orderStore.getById(order.id))?.state).toBe("delivered");
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toHaveLength(1);
			expect(await onHandAfterRelease(h, order, s)).toBe(ON_HAND - QTY);
			expect(await admin(h, order.id, "completed")).toMatchObject({ ok: true, transitioned: true });
		});

		test("a Mark paid that died after recording the payment is finished by the next click", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "5", "cod");
			// The crash window: the payment row is durable, the flip never happened.
			await h.settleDeps.orderStore.recordPayment({
				orderId: order.id,
				gateway: "cod",
				providerRef: offlinePaymentRef("cod", order.id),
				amount: cents(UNIT_CENTS * QTY),
				currency: USD,
				status: "succeeded",
			});
			const stuck = await h.settleDeps.orderStore.getById(order.id);
			expect(stuck?.state).toBe("awaiting_payment");
			expect(adminNextStates(stuck as Order, { payments: [], refunds: [] })).toContain("paid");
			expect(await admin(h, order.id, "paid")).toMatchObject({ ok: true, transitioned: true });
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toHaveLength(1);
			expect(await onHandAfterRelease(h, order, s)).toBe(ON_HAND - QTY);
		});

		test("Mark paid on a digital line of a cod order grants its download", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "6", "cod", { kind: "digital" });
			await admin(h, order.id, "paid");
			expect(await h.settleDeps.entitlementStore.check({ orderId: order.id, sku: sku(s) })).toBe(
				true,
			);
		});

		test("a card order is still refused a manual Mark paid (ADR-0026)", async () => {
			const h = await makeHarness();
			const { order } = await seedOrder(h, "7", "stripe");
			expect(await admin(h, order.id, "paid")).toEqual({
				ok: false,
				reason: "MANUAL_PAYMENT_NOT_ALLOWED",
			});
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toEqual([]);
		});

		for (const shippedFirst of [false, true]) {
			test(`cancelling an unpaid cod order${shippedFirst ? " that was shipped (returned)" : ""} returns its stock and records no payment`, async () => {
				const h = await makeHarness();
				const { order, sku: s } = await seedOrder(h, shippedFirst ? "8b" : "8a", "cod");
				if (shippedFirst) await admin(h, order.id, "shipped_awaiting_payment");
				expect(await cancel(h, order.id)).toMatchObject({ ok: true, cancelled: true });
				expect(await onHandAfterRelease(h, order, s)).toBe(ON_HAND);
				expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toEqual([]);
				expect(await admin(h, order.id, "paid")).toEqual({
					ok: false,
					reason: "INVALID_TRANSITION",
				});
			});
		}

		test("Mark paid twice at once: one flip, one payment, one confirmation", async () => {
			const h = await makeHarness();
			const { order } = await seedOrder(h, "9", "cod");
			await outboxRows(h, order.id);
			const [a, b] = await Promise.all([
				admin(h, order.id, "paid", "click-a"),
				admin(h, order.id, "paid", "click-b"),
			]);
			const won = [a, b].filter((r) => r.ok && r.transitioned).length;
			expect(won).toBe(1);
			expect([a, b].every((r) => r.ok)).toBe(true);
			expect((await h.settleDeps.orderStore.getById(order.id))?.state).toBe("paid");
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toHaveLength(1);
			expect((await outboxRows(h, order.id)).filter((r) => r.toState === "paid")).toHaveLength(1);
		});

		test("Mark paid racing Cancel order: exactly one wins, and cash recorded on a cancelled order is flagged", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "10", "cod");
			const [paid, cancelled] = await Promise.all([
				admin(h, order.id, "paid"),
				cancel(h, order.id),
			]);
			const final = await h.settleDeps.orderStore.getById(order.id);
			const captured = await h.settleDeps.orderStore.getCapturedPayments(order.id);
			if (final?.state === "paid") {
				expect(paid).toMatchObject({ ok: true, transitioned: true });
				expect(cancelled.ok).toBe(false);
				expect(await onHandAfterRelease(h, order, s)).toBe(ON_HAND - QTY);
			} else {
				expect(final?.state).toBe("cancelled");
				expect(cancelled).toMatchObject({ ok: true, cancelled: true });
				expect(await onHandAfterRelease(h, order, s)).toBe(ON_HAND);
				// If the attestation was recorded before the cancel won, the money is
				// held and someone must reconcile it — never silently.
				if (captured.length > 0) expect(final?.reconciliationFlag).toMatch(/cash recorded/);
			}
		});

		test("the open-order counts behind the caps follow the buyer and the client network", async () => {
			const h = await makeHarness();
			const a = await seedOrder(h, "11a", "cod", {
				buyerRef: "Same@Example.com",
				clientKey: "net-x",
			});
			const b = await seedOrder(h, "11b", "cod", {
				buyerRef: "same@example.com",
				clientKey: "net-x",
			});
			await seedOrder(h, "11c", "cod", { buyerRef: "other@example.com", clientKey: "net-y" });
			const count = () =>
				h.settleDeps.orderStore.countOpenOfflineOrders({
					buyerRef: "SAME@example.com",
					clientKey: "net-x",
				});
			expect(await count()).toEqual({ byBuyer: 2, byClient: 2 });
			await admin(h, a.order.id, "shipped_awaiting_payment");
			expect(await count()).toEqual({ byBuyer: 2, byClient: 2 }); // still unpaid: still open
			await admin(h, a.order.id, "delivered");
			await cancel(h, b.order.id);
			expect(await count()).toEqual({ byBuyer: 0, byClient: 0 });
			expect(
				await h.settleDeps.orderStore.countOpenOfflineOrders({ buyerRef: "nobody@example.com" }),
			).toEqual({ byBuyer: 0, byClient: 0 });
		});

		test("auto-cancel: a stale awaiting_payment order is cancelled with its stock back; shipped or recorded-cash orders are not", async () => {
			const h = await makeHarness();
			const stale = await seedOrder(h, "12a", "cod");
			const shipped = await seedOrder(h, "12b", "cod");
			await admin(h, shipped.order.id, "shipped_awaiting_payment");
			const half = await seedOrder(h, "12c", "cod");
			await h.settleDeps.orderStore.recordPayment({
				orderId: half.order.id,
				gateway: "cod",
				providerRef: offlinePaymentRef("cod", half.order.id),
				amount: cents(UNIT_CENTS * QTY),
				currency: USD,
				status: "succeeded",
			});
			const later = new Date(h.settleDeps.clock.now().getTime() + 15 * DAY_MS);
			const listed = await h.settleDeps.orderStore.listAwaitingPaymentBefore(
				new Date(later.getTime() - 14 * DAY_MS).toISOString(),
				10,
			);
			expect([...listed].toSorted()).toEqual([stale.order.id, half.order.id].toSorted());

			const res = await cancelUnpaidOfflineOrders(
				{
					orderStore: h.settleDeps.orderStore,
					couponStore: h.expireDeps.couponStore,
					clock: { now: () => later },
					logger: NOOP_LOGGER,
				},
				{ maxAgeDays: 14, limit: 10 },
			);
			expect(res).toMatchObject({ cancelled: 1, skipped: 1 });
			const after = await h.settleDeps.orderStore.getById(stale.order.id);
			expect(after?.state).toBe("cancelled");
			expect(after?.cancellation).toMatchObject({
				reason: "other",
				cancelledBy: "otta:auto-cancel",
			});
			expect(await onHandAfterRelease(h, stale.order, stale.sku)).toBe(ON_HAND);
			expect((await h.settleDeps.orderStore.getById(shipped.order.id))?.state).toBe(
				"shipped_awaiting_payment",
			);
			const kept = await h.settleDeps.orderStore.getById(half.order.id);
			expect(kept?.state).toBe("awaiting_payment");
			expect(kept?.reconciliationFlag).toMatch(/cash recorded/);
			// Not yet stale: nothing to do.
			expect(
				await cancelUnpaidOfflineOrders(
					{
						orderStore: h.settleDeps.orderStore,
						couponStore: h.expireDeps.couponStore,
						clock: h.settleDeps.clock,
						logger: NOOP_LOGGER,
					},
					{ maxAgeDays: 14, limit: 10 },
				),
			).toMatchObject({ cancelled: 0 });
		});

		test("Mark paid losing its flip to a Record shipment is retryable: nothing revoked or flagged, and the next click lands it delivered", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "14", "cod", { kind: "physical" });
			const real = h.settleDeps.orderStore;
			// A store whose flip first lets a concurrent Record shipment win — the exact
			// interleave of the race, made deterministic.
			const racing = new Proxy(real, {
				get(target, prop, receiver) {
					if (prop === "markPaid") {
						return async (...args: Parameters<typeof real.markPaid>) => {
							await recordFulfillment(
								{ orderStore: real },
								{
									orderId: order.id,
									carrier: "Delhivery",
									trackingNumber: "DL-RACE",
									trackingUrl: null,
									recordedBy: "Other Person",
									idempotencyKey: idempotencyKey(`ship-race:${order.id}`),
								},
							);
							return real.markPaid(...args);
						};
					}
					const value: unknown = Reflect.get(target, prop, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const raced = await transitionOrderAsAdmin(
				{ ...adminDeps(h), orderStore: racing },
				{
					orderId: order.id,
					toState: "paid",
					idempotencyKey: idempotencyKey("raced-click"),
					actor: "Ops Person",
				},
			);
			expect(raced).toEqual({ ok: false, reason: "MARK_PAID_RETRY" });
			const shipped = await real.getById(order.id);
			expect(shipped?.state).toBe("shipped_awaiting_payment");
			expect(shipped?.reconciliationFlag).toBeNull();
			// The click again, toward delivered: one payment row, the same reference.
			expect(await admin(h, order.id, "delivered")).toMatchObject({ ok: true, transitioned: true });
			expect(await real.getCapturedPayments(order.id)).toHaveLength(1);
			expect(await onHandAfterRelease(h, order, s)).toBe(ON_HAND - QTY);
		});

		test("a refused parcel whose Mark paid lost to the shipment is cancellable: the attested row is flagged, downloads revoked, stock back (R3-3)", async () => {
			const h = await makeHarness();
			const { order, sku: s } = await seedOrder(h, "17", "cod", { kind: "digital" });
			const real = h.settleDeps.orderStore;
			const racing = new Proxy(real, {
				get(target, prop, receiver) {
					if (prop === "markPaid") {
						return async (...args: Parameters<typeof real.markPaid>) => {
							await transitionOrder(
								{ orderStore: real },
								{
									orderId: order.id,
									toState: "shipped_awaiting_payment",
									idempotencyKey: idempotencyKey(`ship17:${order.id}`),
								},
							);
							return real.markPaid(...args);
						};
					}
					const value: unknown = Reflect.get(target, prop, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			expect(
				await transitionOrderAsAdmin(
					{ ...adminDeps(h), orderStore: racing },
					{ orderId: order.id, toState: "paid", idempotencyKey: idempotencyKey("click17") },
				),
			).toEqual({ ok: false, reason: "MARK_PAID_RETRY" });
			expect(await real.getCapturedPayments(order.id)).toHaveLength(1);
			expect(await h.settleDeps.entitlementStore.check({ orderId: order.id, sku: sku(s) })).toBe(
				true,
			);

			const res = await cancelOrderWithRefund(
				{
					orderStore: real,
					inventoryStore: h.settleDeps.inventoryStore,
					entitlementStore: h.settleDeps.entitlementStore,
					logger: NOOP_LOGGER,
				},
				null,
				{
					orderId: order.id,
					reason: "customer_request",
					cancelledBy: "Ops Person",
					idempotencyKey: idempotencyKey(`cancel17:${order.id}`),
					restock: true,
				},
			);
			expect(res).toMatchObject({ ok: true, cancelled: true });
			const cancelled = await real.getById(order.id);
			expect(cancelled?.state).toBe("cancelled");
			expect(cancelled?.reconciliationFlag).toMatch(
				/cash recorded on a cash-on-delivery order that was then cancelled/,
			);
			expect(await h.settleDeps.entitlementStore.check({ orderId: order.id, sku: sku(s) })).toBe(
				false,
			);
		});

		/**
		 * Review of round 3: Cancel order decided on one read and cancelled through a
		 * second, so a payment landing in between was cancelled with its money kept,
		 * no refund, no flag, and a "cancelled" email. The flip is now pinned to the
		 * state the decision read; a lost flip re-runs the decision on the order as
		 * it now is. The payment lands inside the store's cancel call, just before its
		 * guarded flip — the exact window.
		 */
		for (const method of ["cod", "stripe"] as const) {
			test(`a payment landing between Cancel order's read and its flip is never cancelled away (${method})`, async () => {
				const h = await makeHarness();
				const { order } = await seedOrder(h, `race-${method}`, method);
				const real = h.settleDeps.orderStore;
				let landed = false;
				const racing = new Proxy(real, {
					get(target, prop, receiver) {
						if (prop === "cancelOrder") {
							return async (...args: Parameters<typeof real.cancelOrder>) => {
								if (!landed) {
									landed = true;
									if (method === "cod") {
										await admin(h, order.id, "paid", `race-click-${method}`);
									} else {
										// A card settle: the guarded flip and its payment row.
										await real.markPaid(order.id, "pi_race");
										await real.recordPayment({
											orderId: order.id,
											gateway: "stripe",
											providerRef: "pi_race",
											amount: cents(UNIT_CENTS * QTY),
											currency: USD,
											status: "succeeded",
										});
									}
								}
								return real.cancelOrder(...args);
							};
						}
						const value: unknown = Reflect.get(target, prop, receiver);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
				const res = await cancelOrderWithRefund(
					{
						orderStore: racing,
						inventoryStore: h.settleDeps.inventoryStore,
						entitlementStore: h.settleDeps.entitlementStore,
						logger: NOOP_LOGGER,
					},
					null,
					{
						orderId: order.id,
						reason: "customer_request",
						cancelledBy: "Ops Person",
						idempotencyKey: idempotencyKey(`race-cancel-${method}`),
						restock: true,
					},
				);
				// The now-paid order went down the money path: no gateway can return it
				// automatically here, so the cancel is refused and the order stays paid.
				expect(res).toEqual({ ok: false, reason: "REFUND_NOT_AUTOMATIC" });
				const final = await real.getById(order.id);
				expect(final?.state).toBe("paid");
				expect(final?.cancellation).toBeNull();
				expect(await real.getCapturedPayments(order.id)).toHaveLength(1);
				// No "cancelled" email was enqueued for it.
				expect((await outboxRows(h, order.id)).some((r) => r.toState === "cancelled")).toBe(false);
			});
		}

		test("an unpaid cod order carrying a payment that is NOT its own attestation is still refused a plain cancel", async () => {
			const h = await makeHarness();
			const { order } = await seedOrder(h, "18", "cod");
			await h.settleDeps.orderStore.recordPayment({
				orderId: order.id,
				gateway: "cod",
				providerRef: "someone-else",
				amount: cents(UNIT_CENTS * QTY),
				currency: USD,
				status: "succeeded",
			});
			const res = await cancelOrderWithRefund(
				{
					orderStore: h.settleDeps.orderStore,
					inventoryStore: h.settleDeps.inventoryStore,
					logger: NOOP_LOGGER,
				},
				null,
				{
					orderId: order.id,
					reason: "customer_request",
					cancelledBy: "Ops Person",
					idempotencyKey: idempotencyKey(`cancel18:${order.id}`),
					restock: true,
				},
			);
			expect(res).toEqual({ ok: false, reason: "REFUND_NOT_AUTOMATIC" });
			expect((await h.settleDeps.orderStore.getById(order.id))?.state).toBe("awaiting_payment");
		});

		test("the bare transitionOrder refuses an offline order's paid targets — only transitionOrderAsAdmin records the payment", async () => {
			const h = await makeHarness();
			const { order } = await seedOrder(h, "15", "cod");
			const bare = await transitionOrder(
				{ orderStore: h.settleDeps.orderStore },
				{ orderId: order.id, toState: "paid", idempotencyKey: idempotencyKey("bare-paid") },
			);
			expect(bare).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
			expect((await h.settleDeps.orderStore.getById(order.id))?.state).toBe("awaiting_payment");
		});

		test("auto-cancel frees the coupon use BEFORE cancelling: a failed release leaves the order for the next run, which frees it and cancels", async () => {
			const h = await makeHarness();
			const stale = await seedOrder(h, "16", "cod");
			const later = new Date(h.settleDeps.clock.now().getTime() + 15 * DAY_MS);
			const released: string[] = [];
			let failNext = true;
			const coupons = {
				async releaseByOrder(order: { id: string }) {
					if (failNext) {
						failNext = false;
						throw new Error("coupon store busy");
					}
					released.push(order.id);
					return 1;
				},
			};
			const run = () =>
				cancelUnpaidOfflineOrders(
					{
						orderStore: h.settleDeps.orderStore,
						couponStore: coupons,
						clock: { now: () => later },
						logger: NOOP_LOGGER,
					},
					{ maxAgeDays: 14, limit: 10 },
				);
			expect(await run()).toMatchObject({ cancelled: 0, skipped: 1 });
			expect((await h.settleDeps.orderStore.getById(stale.order.id))?.state).toBe(
				"awaiting_payment",
			);
			expect(await run()).toMatchObject({ cancelled: 1 });
			expect(released).toEqual([stale.order.id]);
			expect((await h.settleDeps.orderStore.getById(stale.order.id))?.state).toBe("cancelled");
		});

		test("auto-cancel logging: a DEFERRED coupon release is info, a real failure is error (R3-4)", async () => {
			const h = await makeHarness();
			await seedOrder(h, "19", "cod");
			const later = new Date(h.settleDeps.clock.now().getTime() + 15 * DAY_MS);
			const run = async (err: Error) => {
				const logger = new RecordingLogger();
				await cancelUnpaidOfflineOrders(
					{
						orderStore: h.settleDeps.orderStore,
						couponStore: {
							releaseByOrder: async () => {
								throw err;
							},
						},
						clock: { now: () => later },
						logger,
					},
					{ maxAgeDays: 14, limit: 10 },
				);
				return logger.entries.map((e) => e.level);
			};
			expect(await run(new CouponReleaseDeferredError())).toEqual(["info"]);
			expect(await run(new Error("coupon store down"))).toEqual(["error"]);
		});

		test("auto-cancel that frees the coupon and then loses the cancel warns, naming the order and the coupon (M2 visibility)", async () => {
			const h = await makeHarness();
			const { order } = await seedOrder(h, "20", "cod", { couponCode: "CASH10" });
			const later = new Date(h.settleDeps.clock.now().getTime() + 15 * DAY_MS);
			const logger = new RecordingLogger();
			const res = await cancelUnpaidOfflineOrders(
				{
					orderStore: h.settleDeps.orderStore,
					couponStore: {
						// The release lands; then a Mark paid wins before the cancel.
						releaseByOrder: async () => {
							await admin(h, order.id, "paid");
							return 1;
						},
					},
					clock: { now: () => later },
					logger,
				},
				{ maxAgeDays: 14, limit: 10 },
			);
			expect(res).toMatchObject({ cancelled: 0, skipped: 1 });
			expect((await h.settleDeps.orderStore.getById(order.id))?.state).toBe("paid");
			const warn = logger.entries.find((e) => e.level === "warn");
			expect(warn?.fields).toMatchObject({ orderId: order.id, coupon: "CASH10" });
		});

		test("Mark paid on an offline order without the payment wiring throws before writing anything", async () => {
			const h = await makeHarness();
			const { order } = await seedOrder(h, "13", "cod");
			await expect(
				transitionOrderAsAdmin(
					{ orderStore: h.settleDeps.orderStore },
					{ orderId: order.id, toState: "paid", idempotencyKey: idempotencyKey("bare") },
				),
			).rejects.toThrow(/offlinePayment/);
			expect((await h.settleDeps.orderStore.getById(order.id))?.state).toBe("awaiting_payment");
			expect(await h.settleDeps.orderStore.getCapturedPayments(order.id)).toEqual([]);
		});
	});
}
