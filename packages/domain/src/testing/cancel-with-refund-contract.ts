import { describe, expect, test } from "vitest";
import { cents, currency as toCurrency } from "../money/cents.js";
import {
	idempotencyKey,
	orderId as toOrderId,
	productId,
	reservationId as reservationIdOf,
	sku,
} from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";
import { cancelOrder, cancelOrderWithRefund } from "../orders/cancel-order.js";
import { refundOrder } from "../orders/refund-order.js";
import { resolveUnverifiedRefund } from "../orders/resolve-unverified-refund.js";
import { dispatchOrderEmails } from "../orders/transition.js";
import type { Clock } from "../ports/clock.js";
import { ReservationCommitLostError, type InventoryStore } from "../ports/inventory-store.js";
import type { OrderStore } from "../ports/order-store.js";
import { FakeEmailSender } from "./fake-email-sender.js";
import { FakePaymentGateway } from "./fake-payment-gateway.js";

const USD = toCurrency("USD");
/** One sku per order, so no case can observe another's stock even on a store
 *  shared across cases. */
function skuOf(id: string): string {
	return `SKU-${id}`;
}
const UNIT_CENTS = 500;
const QTY = 3;
const TOTAL_CENTS = UNIT_CENTS * QTY;
const ON_HAND = 10;

/** An order store, the inventory store the restock writes to, and a clock — the
 *  same collaborators `cancelOrderWithRefund` composes in the plugin. */
export interface CancelWithRefundHarness {
	orderStore: OrderStore;
	inventoryStore: InventoryStore;
	clock: Clock;
	/** Stamp a fresh hold's deadline, where the adapter requires one before a hold
	 *  can be adopted (the document store's cart step). Absent on the fake. */
	stampHold?(reservationId: string, expiresAt: string): Promise<unknown>;
}

export interface CancelWithRefundContractOptions {
	dialect: string;
}

/** A PHYSICAL order for {@link QTY} units of its own sku (seeded on hand), driven to
 *  `paid` with `capturedCents` captured (default: the whole total; `0` captures
 *  nothing). `state` moves it on to `processing`, or leaves it `pending`. */
async function seedOrder(
	h: CancelWithRefundHarness,
	id: string,
	opts: {
		capturedCents?: number;
		gateway?: PaymentMethod;
		state?: "pending" | "paid" | "processing";
		/** The line's own live reservation, left `adopted` (settle's commit bracket
		 *  still open) or `released` (the hold was lost before settlement). Absent ⇒
		 *  no reservation on the line: the units were sold and the hold is gone. */
		hold?: "adopted" | "released";
		/** Seed no inventory row for the sku (a deleted product). */
		noInventory?: boolean;
		/** Record a SECOND capture of this many cents. */
		secondCaptureCents?: number;
	} = {},
): Promise<OrderId> {
	const oid = toOrderId(id);
	const gateway = opts.gateway ?? "stripe";
	if (opts.noInventory !== true) await h.inventoryStore.seedOnHand(skuOf(id), ON_HAND);
	let reservationId: ReturnType<typeof reservationIdOf> | null = null;
	if (opts.hold !== undefined) {
		// A real checkout hold: reserved (the units leave on-hand), then adopted by the
		// order — exactly what checkout leaves behind before settle commits it.
		const reserved = await h.inventoryStore.reserve(skuOf(id), QTY, idempotencyKey(`hold-${id}`));
		if (!reserved.ok) throw new Error(`seed: could not reserve ${skuOf(id)}`);
		reservationId = reservationIdOf(reserved.reservationId);
		await h.stampHold?.(reserved.reservationId, "2099-01-01T00:00:00.000Z");
		const adopted = await h.inventoryStore.adopt({
			reservationId: reserved.reservationId,
			orderId: id,
			holdExpiresAt: "2099-01-01T00:00:00.000Z",
			now: h.clock.now().toISOString(),
		});
		if (!adopted.ok) throw new Error(`seed: could not adopt the hold for ${id}`);
	}
	await h.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: gateway,
		lines: [
			{
				productId: productId("p-cxl"),
				sku: sku(skuOf(id)),
				title: "Widget",
				unitPrice: cents(UNIT_CENTS),
				currency: USD,
				quantity: QTY,
				fulfillmentKind: "physical",
				// No `hold` ⇒ the units were SOLD and the hold is gone: what a cancellation
				// owes them is a restock.
				reservationId,
			},
		],
		totals: { subtotal: cents(TOTAL_CENTS), total: cents(TOTAL_CENTS), currency: USD },
	});
	if (opts.state === "pending") return oid;
	await h.orderStore.markPaid(oid);
	const captured = opts.capturedCents ?? TOTAL_CENTS;
	if (captured > 0) {
		await h.orderStore.recordPayment({
			orderId: oid,
			gateway,
			providerRef: `pi_${id}`,
			amount: cents(captured),
			currency: USD,
			status: "succeeded",
		});
	}
	if (opts.secondCaptureCents !== undefined) {
		await h.orderStore.recordPayment({
			orderId: oid,
			gateway,
			providerRef: `pi_${id}_2`,
			amount: cents(opts.secondCaptureCents),
			currency: USD,
			status: "succeeded",
		});
	}
	if (opts.hold === "released") {
		// The hold was lost (released back to stock) — the units were never taken.
		await h.inventoryStore.release(String(reservationId));
	}
	if (opts.state === "processing") {
		await h.orderStore.transition({
			orderId: oid,
			fromState: "paid",
			toState: "processing",
			idempotencyKey: idempotencyKey(`seed-processing-${id}`),
			enqueueEmail: false,
		});
	}
	return oid;
}

function cancelWith(
	h: CancelWithRefundHarness,
	gateway: FakePaymentGateway | null,
	id: OrderId,
	opts: {
		restock?: boolean;
		key?: string;
		orderStore?: OrderStore;
		inventoryStore?: InventoryStore;
		isRetryable?: (err: unknown) => boolean;
	} = {},
) {
	return cancelOrderWithRefund(
		{
			orderStore: opts.orderStore ?? h.orderStore,
			inventoryStore: opts.inventoryStore ?? h.inventoryStore,
			...(opts.isRetryable !== undefined ? { isRetryable: opts.isRetryable } : {}),
		},
		gateway,
		{
			orderId: id,
			reason: "customer_request",
			cancelledBy: "admin@shop",
			restock: opts.restock ?? true,
			idempotencyKey: idempotencyKey(opts.key ?? `cxl:${id}`),
		},
	);
}

/** The inventory store with `method` failing ONCE, with `error` (default: a plain,
 *  untyped Error — the "anything else" a store can throw). */
function failingOnce(
	store: InventoryStore,
	method: "restock" | "commit",
	error: Error = new Error(`simulated ${method} failure`),
): InventoryStore {
	let failed = false;
	return new Proxy(store, {
		get(target, prop, receiver) {
			if (prop === method && !failed) {
				return async () => {
					failed = true;
					throw error;
				};
			}
			const value: unknown = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? (value as Function).bind(target) : value;
		},
	});
}

/** Every email the order's outbox holds, drained through the real dispatcher. */
async function drainEmails(h: CancelWithRefundHarness): Promise<FakeEmailSender> {
	const sender = new FakeEmailSender();
	await dispatchOrderEmails({ orderStore: h.orderStore, emailSender: sender, clock: h.clock });
	return sender;
}

/** The order store with its `cancelOrder` write failing ONCE — the crash between
 *  the refund (and restock) and the flip that ends a cancellation. */
function crashingOnceOnCancel(store: OrderStore): OrderStore {
	let crashed = false;
	return new Proxy(store, {
		get(target, prop, receiver) {
			if (prop === "cancelOrder" && !crashed) {
				return async () => {
					crashed = true;
					throw new Error("simulated crash before the cancel write");
				};
			}
			const value: unknown = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? (value as Function).bind(target) : value;
		},
	});
}

/** Move a paid order on to `shipped` — past every cancellable state. */
async function ship(h: CancelWithRefundHarness, oid: OrderId): Promise<void> {
	for (const [from, to] of [
		["paid", "processing"],
		["processing", "shipped"],
	] as const) {
		await h.orderStore.transition({
			orderId: oid,
			fromState: from,
			toState: to,
			idempotencyKey: idempotencyKey(`${oid}-${to}`),
			enqueueEmail: false,
		});
	}
}

/** A paid order whose cancellation's refund timed out: held `unverified`. */
async function unverifiedCancellation(
	h: CancelWithRefundHarness,
	id: string,
	cancelOpts: { restock?: boolean } = {},
) {
	const oid = await seedOrder(h, id);
	const gw = new FakePaymentGateway({ id: "stripe" });
	gw.setRefundResult({ ok: false, reason: "UNVERIFIED" });
	expect(await cancelWith(h, gw, oid, cancelOpts)).toMatchObject({
		ok: false,
		refundFailure: "GATEWAY_UNVERIFIED",
	});
	const row = (await h.orderStore.listRefunds(oid))[0];
	if (row === undefined) throw new Error("seed: no refund row");
	expect(row).toMatchObject({ status: "unverified", purpose: "cancellation" });
	await drainEmails(h); // the confirmation email is not the subject
	return { oid, gw, key: row.idempotencyKey };
}

function resolveRefund(
	h: CancelWithRefundHarness,
	oid: OrderId,
	key: string,
	outcome: "confirmed" | "voided",
	deps: { inventory?: boolean; orderStore?: OrderStore } = {},
) {
	return resolveUnverifiedRefund(
		{
			orderStore: deps.orderStore ?? h.orderStore,
			...(deps.inventory === false ? {} : { inventoryStore: h.inventoryStore }),
		},
		{ orderId: oid, refundKey: idempotencyKey(key), outcome, resolvedBy: "ops@shop" },
	);
}

/**
 * Cancelling a PAID order refunds what was captured and restocks its units (QA T1-4,
 * the maintainer's 2026-10-02 decision). `cancelOrderWithRefund` composes the
 * refund ledger's reserve → issue → finalize (`refundOrder`, purpose
 * `cancellation`), the inventory's idempotent `restock`, and the guarded cancel
 * flip, in that order. Encoded here:
 *
 *  - the money goes back through the gateway, once, and the order ends `cancelled`
 *    — never `refunded` — with the refund and the restock on its envelope and ONE
 *    email (the cancellation, which carries the refund);
 *  - a refund that fails leaves the order exactly as it was (still paid, stock
 *    untouched, nothing emailed) — never cancelled with the money kept;
 *  - a retry after a crash anywhere in between neither refunds nor restocks twice;
 *  - money a gateway cannot return automatically is refused, not recorded.
 *
 * Runs against the in-memory fakes first, then the document store on each dialect.
 */
export function cancelWithRefundContract(
	makeHarness: () => Promise<CancelWithRefundHarness> | CancelWithRefundHarness,
	opts: CancelWithRefundContractOptions,
): void {
	describe(`cancelWithRefundContract [${opts.dialect}]`, () => {
		test("cancelling a paid card order refunds the capture, restocks the units and cancels it", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-paid");
			const gw = new FakePaymentGateway({ id: "stripe" });

			const res = await cancelWith(h, gw, id);
			expect(res).toMatchObject({
				ok: true,
				cancelled: true,
				refund: { amount: TOTAL_CENTS, currency: "USD" },
				restockedUnits: QTY,
			});
			const order = await h.orderStore.getById(id);
			expect(order?.state).toBe("cancelled");
			expect(order?.cancellation).toMatchObject({
				reason: "customer_request",
				refund: { amount: TOTAL_CENTS, currency: "USD" },
				restocked: true,
			});
			// The money went back through the gateway, once, for the whole capture.
			expect(gw.refundCalls).toHaveLength(1);
			expect(gw.refundCalls[0]?.amount).toBe(TOTAL_CENTS);
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]).toMatchObject({
				amount: TOTAL_CENTS,
				status: "recorded",
				purpose: "cancellation",
			});
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND + QTY);
			// ONE email: the cancellation, which carries the refund. Never a separate
			// "refunded" one — the order did not go through `refunded`.
			const sent = await drainEmails(h);
			expect(sent.countByTemplate("order-cancelled", id)).toBe(1);
			expect(sent.countByTemplate("order-refunded", id)).toBe(0);
			// ...and that email's data carries the refund, so it can say one is coming.
			const cancelled = sent.sends.find((s) => s.template === "order-cancelled");
			expect(cancelled?.data["cancellation"]).toMatchObject({
				refund: { amountCents: TOTAL_CENTS, currency: "USD" },
			});
			expect(
				(await h.orderStore.listEventsForOrder(id)).some((e) => e.toState === "refunded"),
			).toBe(false);
		});

		test("a processing order is refunded and cancelled the same way", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-proc", { state: "processing" });
			const gw = new FakePaymentGateway({ id: "stripe" });
			expect(await cancelWith(h, gw, id)).toMatchObject({ ok: true, cancelled: true });
			expect((await h.orderStore.getById(id))?.state).toBe("cancelled");
			expect(gw.refundCalls).toHaveLength(1);
		});

		test("restock: false refunds and cancels but leaves the stock alone (damaged goods)", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-norestock");
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await cancelWith(h, gw, id, { restock: false });
			expect(res).toMatchObject({ ok: true, cancelled: true, restockedUnits: 0 });
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND);
			expect((await h.orderStore.getById(id))?.cancellation?.restocked).toBe(false);
			expect(gw.refundCalls).toHaveLength(1);
		});

		test("a replay after success refunds nothing more and restocks nothing more", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-replay");
			const gw = new FakePaymentGateway({ id: "stripe" });
			await cancelWith(h, gw, id);
			const replay = await cancelWith(h, gw, id);
			expect(replay).toMatchObject({
				ok: true,
				cancelled: false,
				refund: { amount: TOTAL_CENTS, currency: "USD" },
			});
			expect(gw.refundCalls).toHaveLength(1);
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND + QTY);
			expect(await h.orderStore.listRefunds(id)).toHaveLength(1);
			expect((await drainEmails(h)).countByTemplate("order-cancelled", id)).toBe(1);
		});

		test("a crash after the refund and restock but before the cancel: the retry neither refunds nor restocks twice", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-crash");
			const gw = new FakePaymentGateway({ id: "stripe" });
			// A failure after the refund is never a bare throw: the money already moved, so
			// the caller is told so — and the operator's retry is the obvious next step.
			expect(
				await cancelWith(h, gw, id, { orderStore: crashingOnceOnCancel(h.orderStore) }),
			).toMatchObject({
				ok: false,
				reason: "CANCEL_INCOMPLETE_AFTER_REFUND",
				refund: { amount: TOTAL_CENTS, currency: "USD" },
			});
			// The order is still PAID — still cancellable — with the money already back and
			// the units restocked, and flagged so it is not lost if nobody retries.
			const after = await h.orderStore.getById(id);
			expect(after?.state).toBe("paid");
			expect(after?.reconciliationFlag).toContain("did not finish");
			expect(gw.refundCalls).toHaveLength(1);
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND + QTY);

			const retry = await cancelWith(h, gw, id);
			expect(retry).toMatchObject({
				ok: true,
				cancelled: true,
				refund: { amount: TOTAL_CENTS, currency: "USD" },
			});
			// The SAME refund (its key), so the provider is not asked again; the restock's
			// keys are spent, so no second unit moves.
			expect(gw.refundCalls).toHaveLength(1);
			expect(await h.orderStore.listRefunds(id)).toHaveLength(1);
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND + QTY);
			const done = await h.orderStore.getById(id);
			expect(done?.state).toBe("cancelled");
			// The "did not finish — click Cancel order again" flag is cleared by the retry
			// that finished: no stale alert pointing at a control that is gone.
			expect(done?.reconciliationFlag).toBeNull();
		});

		test("a retry of a crashed cancel keeps the FIRST attempt's restock choice — the envelope stays truthful", async () => {
			// The first attempt restocked, then crashed before the flip. The operator unticks
			// Return to stock and retries: the units are already back, so the envelope must
			// say they were, and the retry must not claim "nothing was returned".
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-crash-flip");
			const gw = new FakePaymentGateway({ id: "stripe" });
			await cancelWith(h, gw, id, { orderStore: crashingOnceOnCancel(h.orderStore) });
			const retry = await cancelWith(h, gw, id, { restock: false });
			expect(retry).toMatchObject({ ok: true, cancelled: true, restockedUnits: QTY });
			expect((await h.orderStore.getById(id))?.cancellation?.restocked).toBe(true);
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND + QTY);
		});

		test("an untyped failure in the restock AFTER the refund flags the order and a retry finishes without refunding twice", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-restock-throws");
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await cancelWith(h, gw, id, {
				inventoryStore: failingOnce(h.inventoryStore, "restock"),
			});
			expect(res).toMatchObject({
				ok: false,
				reason: "CANCEL_INCOMPLETE_AFTER_REFUND",
				refund: { amount: TOTAL_CENTS, currency: "USD" },
			});
			const after = await h.orderStore.getById(id);
			expect(after?.state).toBe("paid");
			expect(after?.reconciliationFlag).toContain("did not finish");
			expect(gw.refundCalls).toHaveLength(1);

			const retry = await cancelWith(h, gw, id);
			expect(retry).toMatchObject({ ok: true, cancelled: true, restockedUnits: QTY });
			expect(gw.refundCalls).toHaveLength(1);
			expect(await h.orderStore.listRefunds(id)).toHaveLength(1);
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND + QTY);
			expect((await h.orderStore.getById(id))?.reconciliationFlag).toBeNull();
		});

		test("a RETRYABLE (busy) failure after the refund says so, and stays retry-safe", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-busy");
			const gw = new FakePaymentGateway({ id: "stripe" });
			const busy = new Error("storage busy");
			const res = await cancelWith(h, gw, id, {
				inventoryStore: failingOnce(h.inventoryStore, "restock", busy),
				isRetryable: (err) => err === busy,
			});
			expect(res).toMatchObject({
				ok: false,
				reason: "CANCEL_INCOMPLETE_AFTER_REFUND",
				refund: { amount: TOTAL_CENTS, currency: "USD" },
				retryable: true,
			});
			expect(await cancelWith(h, gw, id)).toMatchObject({ ok: true, cancelled: true });
			expect(gw.refundCalls).toHaveLength(1);
		});

		test("a refund the provider REJECTS leaves the order paid, the stock untouched and nobody emailed", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-reject");
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({ ok: false, reason: "TERMINAL" });
			const res = await cancelWith(h, gw, id);
			expect(res).toEqual({
				ok: false,
				reason: "REFUND_FAILED",
				refundFailure: "GATEWAY_TERMINAL",
			});
			const order = await h.orderStore.getById(id);
			expect(order?.state).toBe("paid");
			expect(order?.cancellation).toBeNull();
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND);
			// Nothing for the buyer about a cancellation or a refund that did not happen
			// (the seed's own payment confirmation is the only thing queued).
			const sent = await drainEmails(h);
			expect(sent.countByTemplate("order-cancelled", id)).toBe(0);
			expect(sent.countByTemplate("order-refunded", id)).toBe(0);

			// A deliberate retry once the provider accepts is a NEW attempt (the rejected
			// one spent its key) and completes the cancellation.
			gw.setRefundResult({
				ok: true,
				refundRef: "re_after_reject",
				amount: cents(TOTAL_CENTS),
				currency: USD,
			});
			const retry = await cancelWith(h, gw, id);
			expect(retry).toMatchObject({ ok: true, cancelled: true });
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger.map((r) => r.status).toSorted()).toEqual(["recorded", "voided"]);
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND + QTY);
		});

		test("a transient provider failure leaves the order paid; the retry RESUMES the same refund", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-retryable");
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({ ok: false, reason: "RETRYABLE" });
			expect(await cancelWith(h, gw, id)).toEqual({
				ok: false,
				reason: "REFUND_FAILED",
				refundFailure: "GATEWAY_RETRYABLE",
			});
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
			gw.setRefundResult({
				ok: true,
				refundRef: "re_resumed",
				amount: cents(TOTAL_CENTS),
				currency: USD,
			});
			expect(await cancelWith(h, gw, id)).toMatchObject({ ok: true, cancelled: true });
			// Both calls carried the SAME key — the provider's native idempotency is what
			// makes the second one safe.
			expect(gw.refundCalls.map((c) => c.idempotencyKey)).toHaveLength(2);
			expect(new Set(gw.refundCalls.map((c) => c.idempotencyKey)).size).toBe(1);
			const ledger = await h.orderStore.listRefunds(id);
			expect(ledger).toHaveLength(1);
			expect(ledger[0]?.status).toBe("recorded");
		});

		test("an unknown refund outcome refuses the cancel and is never retried blind", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-unverified");
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({ ok: false, reason: "UNVERIFIED" });
			expect(await cancelWith(h, gw, id)).toEqual({
				ok: false,
				reason: "REFUND_FAILED",
				refundFailure: "GATEWAY_UNVERIFIED",
			});
			// The retry asks the provider for nothing: the attempt's fate is unknown.
			expect(await cancelWith(h, gw, id)).toEqual({
				ok: false,
				reason: "REFUND_FAILED",
				refundFailure: "GATEWAY_UNVERIFIED",
			});
			expect(gw.refundCalls).toHaveLength(1);
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
		});

		test("money a gateway cannot return automatically (x402) is refused — nothing recorded, nothing cancelled", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-x402", { gateway: "x402" });
			const gw = new FakePaymentGateway({ id: "x402" });
			expect(await cancelWith(h, gw, id)).toEqual({ ok: false, reason: "REFUND_NOT_AUTOMATIC" });
			// And with no gateway wired at all, the same.
			expect(await cancelWith(h, null, id)).toEqual({ ok: false, reason: "REFUND_NOT_AUTOMATIC" });
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
			expect(await h.orderStore.listRefunds(id)).toHaveLength(0);
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND);
		});

		test("a paid order with nothing captured cancels with no refund", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-nocapture", { capturedCents: 0 });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await cancelWith(h, gw, id);
			expect(res).toMatchObject({ ok: true, cancelled: true, refund: null, restockedUnits: QTY });
			expect(gw.refundCalls).toHaveLength(0);
			expect((await h.orderStore.getById(id))?.cancellation?.refund).toBeNull();
		});

		test("after a partial refund, the cancellation refunds only the remainder", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-partial");
			const gw = new FakePaymentGateway({ id: "stripe" });
			await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(400),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("cxl-partial-first"),
			});
			const res = await cancelWith(h, gw, id);
			expect(res).toMatchObject({
				ok: true,
				cancelled: true,
				refund: { amount: TOTAL_CENTS - 400, currency: "USD" },
			});
			expect(gw.refundCalls.map((c) => c.amount)).toEqual([400, TOTAL_CENTS - 400]);
		});

		test("another refund still in flight on the order refuses the cancel until it is resolved", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-inflight");
			const gw = new FakePaymentGateway({ id: "stripe" });
			gw.setRefundResult({ ok: false, reason: "UNVERIFIED" });
			await refundOrder({ orderStore: h.orderStore }, gw, {
				orderId: id,
				amount: cents(400),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("cxl-inflight-first"),
			});
			expect(await cancelWith(h, gw, id)).toEqual({ ok: false, reason: "REFUND_IN_FLIGHT" });
			expect(gw.refundCalls).toHaveLength(1);
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
		});

		test("a pending order is cancelled as before: no refund, no restock", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-pending", { state: "pending" });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await cancelWith(h, gw, id, { restock: true });
			expect(res).toMatchObject({ ok: true, cancelled: true, refund: null, restockedUnits: 0 });
			expect(gw.refundCalls).toHaveLength(0);
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND);
			expect((await h.orderStore.getById(id))?.cancellation).toMatchObject({
				refund: null,
				restocked: false,
			});
		});

		test("an order that moved on before the cancel landed is flagged — the refund is never silent", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-lost", { state: "processing" });
			const gw = new FakePaymentGateway({ id: "stripe" });
			// The order ships between the refund and the cancel flip.
			const racing = new Proxy(h.orderStore, {
				get(target, prop, receiver) {
					if (prop === "cancelOrder") {
						return async (input: Parameters<OrderStore["cancelOrder"]>[0]) => {
							await target.transition({
								orderId: id,
								fromState: "processing",
								toState: "shipped",
								idempotencyKey: idempotencyKey("cxl-lost-ship"),
								enqueueEmail: false,
							});
							return target.cancelOrder(input);
						};
					}
					const value: unknown = Reflect.get(target, prop, receiver);
					return typeof value === "function" ? (value as Function).bind(target) : value;
				},
			});
			const res = await cancelWith(h, gw, id, { orderStore: racing });
			expect(res).toMatchObject({
				ok: false,
				reason: "CANCEL_LOST_AFTER_REFUND",
				refund: { amount: TOTAL_CENTS, currency: "USD" },
				restockedUnits: QTY,
				movedTo: "shipped",
				// The refund it carries, so the caller can send its notice inline.
				refundId: (await h.orderStore.listRefunds(id))[0]?.id,
			});
			const order = await h.orderStore.getById(id);
			expect(order?.state).toBe("shipped");
			// The flag says what was done and what to do next.
			expect(order?.reconciliationFlag).toContain("refunded");
			expect(order?.reconciliationFlag).toContain(`restocked ${String(QTY)} unit(s)`);
			expect(order?.reconciliationFlag).toContain("contact the buyer");
			// The buyer still hears about their money: the cancelled email that would have
			// carried it will never go, so the refund announces itself — exactly once.
			const sent = await drainEmails(h);
			expect(sent.countByTemplate("order-refund-issued", id)).toBe(1);
			expect(sent.countByTemplate("order-cancelled", id)).toBe(0);
			const mail = sent.sends.find((m) => m.template === "order-refund-issued");
			expect(mail?.data["noticeAmountCents"]).toBe(TOTAL_CENTS);
			// A retry neither cancels nor emails again.
			await cancelWith(h, gw, id, { orderStore: racing });
			expect((await drainEmails(h)).countByTemplate("order-refund-issued", id)).toBe(0);
		});

		// -- the stock a cancellation returns, exactly once ------------------------

		test("a hold settle never committed (still ADOPTED) is committed, then restocked ONCE — never released AND restocked", async () => {
			// The double-return the cancel's release intent would otherwise cause: the
			// release returns an ADOPTED hold's units, and the restock returns them again
			// — phantom stock, and the oversell it invites. Closing the bracket first
			// leaves the release a no-op on a committed hold.
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-adopted", { hold: "adopted" });
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND - QTY);
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await cancelWith(h, gw, id);
			expect(res).toMatchObject({ ok: true, cancelled: true, restockedUnits: QTY });
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND);
			// A retry moves nothing more.
			await cancelWith(h, gw, id);
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND);
		});

		test("an OPEN commit bracket with Return to stock unticked: the hold is still committed, so no unit comes back", async () => {
			// Restock declined — but the cancel's release intent would otherwise return an
			// ADOPTED hold's units anyway. Closing the bracket is unconditional.
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-adopted-keep", { hold: "adopted" });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await cancelWith(h, gw, id, { restock: false });
			expect(res).toMatchObject({ ok: true, cancelled: true, restockedUnits: 0 });
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND - QTY);
			expect((await h.orderStore.getById(id))?.cancellation?.restocked).toBe(false);
		});

		test("a hold whose state cannot be told (lost, but not RELEASED) is skipped as unknown, never as released", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-hold-pending", { hold: "adopted" });
			const gw = new FakePaymentGateway({ id: "stripe" });
			const order = await h.orderStore.getById(id);
			const reservation = String(order?.lines[0]?.reservationId);
			const res = await cancelWith(h, gw, id, {
				inventoryStore: failingOnce(
					h.inventoryStore,
					"commit",
					new ReservationCommitLostError(reservation, "pending"),
				),
			});
			expect(res).toMatchObject({
				ok: true,
				restockSkipped: [{ sku: skuOf(id), quantity: QTY, reason: "HOLD_UNKNOWN" }],
			});
		});

		test("a hold that was LOST (released before settlement) is not restocked — its units are already back", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-lost-hold", { hold: "released" });
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND);
			const gw = new FakePaymentGateway({ id: "stripe" });
			const res = await cancelWith(h, gw, id);
			expect(res).toMatchObject({
				ok: true,
				cancelled: true,
				restockedUnits: 0,
				restockSkipped: [{ sku: skuOf(id), quantity: QTY, reason: "HOLD_RELEASED" }],
			});
			expect(await h.inventoryStore.getOnHand(skuOf(id))).toBe(ON_HAND);
			expect((await h.orderStore.getById(id))?.cancellation?.restocked).toBe(false);
		});

		test("a line whose sku has no inventory row is reported as skipped, not silently dropped", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-nosku", { noInventory: true });
			const gw = new FakePaymentGateway({ id: "stripe" });
			expect(await cancelWith(h, gw, id)).toMatchObject({
				ok: true,
				cancelled: true,
				restockedUnits: 0,
				restockSkipped: [{ sku: skuOf(id), quantity: QTY, reason: "UNKNOWN_SKU" }],
			});
		});

		test("an order paid in MORE THAN ONE capture is refused — nothing refunded, nothing cancelled", async () => {
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-two-caps", {
				capturedCents: 1000,
				secondCaptureCents: 500,
			});
			const gw = new FakePaymentGateway({ id: "stripe" });
			expect(await cancelWith(h, gw, id)).toEqual({ ok: false, reason: "MULTIPLE_CAPTURES" });
			expect(gw.refundCalls).toHaveLength(0);
			expect((await h.orderStore.getById(id))?.state).toBe("paid");
		});

		test("an order that moved to ANOTHER cancellable state before the flip is cancelled from there", async () => {
			// paid → processing between the read and the flip: the order is still
			// cancellable, so the flip is retried once from where it now is.
			const h = await makeHarness();
			const id = await seedOrder(h, "cxl-moved");
			const gw = new FakePaymentGateway({ id: "stripe" });
			let moved = false;
			const racing = new Proxy(h.orderStore, {
				get(target, prop, receiver) {
					if (prop === "cancelOrder") {
						return async (input: Parameters<OrderStore["cancelOrder"]>[0]) => {
							if (!moved) {
								moved = true;
								await target.transition({
									orderId: id,
									fromState: "paid",
									toState: "processing",
									idempotencyKey: idempotencyKey("cxl-moved-proc"),
									enqueueEmail: false,
								});
							}
							return target.cancelOrder(input);
						};
					}
					const value: unknown = Reflect.get(target, prop, receiver);
					return typeof value === "function" ? (value as Function).bind(target) : value;
				},
			});
			expect(await cancelWith(h, gw, id, { orderStore: racing })).toMatchObject({
				ok: true,
				cancelled: true,
			});
			expect((await h.orderStore.getById(id))?.state).toBe("cancelled");
			expect(gw.refundCalls).toHaveLength(1);
		});

		test("a missing order, a terminal one and a blank canceller are refused before any money moves", async () => {
			const h = await makeHarness();
			const gw = new FakePaymentGateway({ id: "stripe" });
			expect(await cancelWith(h, gw, toOrderId("cxl-nope"))).toEqual({
				ok: false,
				reason: "ORDER_NOT_FOUND",
			});
			const shipped = await seedOrder(h, "cxl-shipped", { state: "processing" });
			await h.orderStore.transition({
				orderId: shipped,
				fromState: "processing",
				toState: "shipped",
				idempotencyKey: idempotencyKey("cxl-shipped-ship"),
				enqueueEmail: false,
			});
			expect(await cancelWith(h, gw, shipped)).toEqual({ ok: false, reason: "NOT_CANCELLABLE" });
			const paid = await seedOrder(h, "cxl-blank");
			const blank = await cancelOrderWithRefund(
				{ orderStore: h.orderStore, inventoryStore: h.inventoryStore },
				gw,
				{
					orderId: paid,
					reason: "customer_request",
					cancelledBy: "  ",
					restock: true,
					idempotencyKey: idempotencyKey("cxl-blank"),
				},
			);
			expect(blank).toEqual({ ok: false, reason: "EMPTY_CANCELLED_BY" });
			expect(gw.refundCalls).toHaveLength(0);
		});

		// -- a cancellation whose refund timed out, resolved by a person (#364) ------
		//
		// Confirming the refund must finish what it was FOR: the order ends exactly as
		// if the provider had answered success the first time — cancelled, restocked per
		// the first attempt's choice, one cancelled email — and the provider is never
		// asked again. "It didn't happen" leaves the cancel retryable.

		test("CONFIRMING a cancellation's unverified refund finishes the cancel: cancelled, restocked, one cancelled email, no second provider call; a replay changes nothing", async () => {
			const h = await makeHarness();
			const { oid, gw, key } = await unverifiedCancellation(h, "cxl-unv-confirm");

			expect(await resolveRefund(h, oid, key, "confirmed")).toMatchObject({
				ok: true,
				outcome: "confirmed",
				changed: true,
				fullyRefunded: false,
				followUp: { purpose: "cancellation", outcome: "cancelled", cancelledNow: true },
			});
			const order = await h.orderStore.getById(oid);
			expect(order?.state).toBe("cancelled");
			expect(order?.cancellation).toMatchObject({
				reason: "customer_request",
				cancelledBy: "admin@shop",
				refund: { amount: TOTAL_CENTS, currency: "USD" },
				restocked: true,
			});
			expect(order?.reconciliationFlag ?? null).toBeNull();
			expect(await h.inventoryStore.getOnHand(skuOf(oid))).toBe(ON_HAND + QTY);
			expect(gw.refundCalls, "the provider is never asked again").toHaveLength(1);
			expect((await h.orderStore.listRefunds(oid)).map((r) => r.status)).toEqual(["recorded"]);
			const sent = await drainEmails(h);
			expect(sent.countByTemplate("order-cancelled", oid)).toBe(1);
			expect(sent.countByTemplate("order-refund-issued", oid)).toBe(0);
			expect(sent.countByTemplate("order-refunded", oid)).toBe(0);
			expect(
				sent.sends.find((m) => m.template === "order-cancelled")?.data["cancellation"],
			).toMatchObject({ refund: { amountCents: TOTAL_CENTS, currency: "USD" } });

			expect(await resolveRefund(h, oid, key, "confirmed")).toMatchObject({
				ok: true,
				changed: false,
				followUp: { purpose: "cancellation", outcome: "cancelled", cancelledNow: false },
			});
			expect(await h.inventoryStore.getOnHand(skuOf(oid))).toBe(ON_HAND + QTY);
			expect((await drainEmails(h)).sends).toHaveLength(0);
			expect(gw.refundCalls).toHaveLength(1);
		});

		test("CONFIRMING keeps the first attempt's Return to stock choice", async () => {
			const h = await makeHarness();
			const { oid, key } = await unverifiedCancellation(h, "cxl-unv-norestock", {
				restock: false,
			});
			expect(await resolveRefund(h, oid, key, "confirmed")).toMatchObject({
				ok: true,
				followUp: {
					purpose: "cancellation",
					outcome: "cancelled",
					restock: false,
					restockedUnits: 0,
				},
			});
			const order = await h.orderStore.getById(oid);
			expect(order?.state).toBe("cancelled");
			expect(order?.cancellation?.restocked).toBe(false);
			expect(await h.inventoryStore.getOnHand(skuOf(oid))).toBe(ON_HAND);
		});

		test("a confirm whose cancel step could not run says 'cancel again', and Cancel order again finishes it without asking the provider", async () => {
			const h = await makeHarness();
			const { oid, gw, key } = await unverifiedCancellation(h, "cxl-unv-later");
			expect(await resolveRefund(h, oid, key, "confirmed", { inventory: false })).toMatchObject({
				ok: true,
				changed: true,
				followUp: { purpose: "cancellation", outcome: "cancel_again" },
			});
			expect((await h.orderStore.getById(oid))?.state).toBe("paid");
			// Even with no gateway wired now: the refund is settled, so nothing is issued.
			expect(await cancelWith(h, null, oid)).toMatchObject({
				ok: true,
				cancelled: true,
				refund: { amount: TOTAL_CENTS, currency: "USD" },
				restockedUnits: QTY,
			});
			expect(gw.refundCalls).toHaveLength(1);
			expect((await drainEmails(h)).countByTemplate("order-cancelled", oid)).toBe(1);
		});

		test("a confirm after the order SHIPPED cannot cancel it: flagged for a person, the buyer told about the refund once, nothing restocked", async () => {
			const h = await makeHarness();
			const { oid, gw, key } = await unverifiedCancellation(h, "cxl-unv-shipped");
			for (const [from, to] of [
				["paid", "processing"],
				["processing", "shipped"],
			] as const) {
				await h.orderStore.transition({
					orderId: oid,
					fromState: from,
					toState: to,
					idempotencyKey: idempotencyKey(`cxl-unv-shipped-${to}`),
					enqueueEmail: false,
				});
			}

			expect(await resolveRefund(h, oid, key, "confirmed")).toMatchObject({
				ok: true,
				changed: true,
				followUp: {
					purpose: "cancellation",
					outcome: "not_cancelled",
					state: "shipped",
					flagged: true,
					refundEmailQueued: true,
				},
			});
			const order = await h.orderStore.getById(oid);
			expect(order?.state).toBe("shipped");
			expect(order?.reconciliationFlag).toContain("could not be cancelled");
			expect(order?.reconciliationFlag).toContain("contact the buyer");
			expect(await h.inventoryStore.getOnHand(skuOf(oid))).toBe(ON_HAND);
			expect(gw.refundCalls).toHaveLength(1);
			const sent = await drainEmails(h);
			expect(sent.countByTemplate("order-refund-issued", oid)).toBe(1);
			expect(sent.countByTemplate("order-cancelled", oid)).toBe(0);

			// A replay neither re-flags nor emails again.
			expect(await resolveRefund(h, oid, key, "confirmed")).toMatchObject({
				ok: true,
				changed: false,
			});
			expect((await drainEmails(h)).sends).toHaveLength(0);
		});

		test("'It didn't happen' on a cancellation's refund leaves the order paid, and Cancel order again refunds and cancels it", async () => {
			const h = await makeHarness();
			const { oid, gw, key } = await unverifiedCancellation(h, "cxl-unv-void");
			expect(await resolveRefund(h, oid, key, "voided")).toMatchObject({
				ok: true,
				outcome: "voided",
				changed: true,
				followUp: { purpose: "cancellation", outcome: "cancel_again" },
			});
			expect((await h.orderStore.getById(oid))?.state).toBe("paid");
			expect((await drainEmails(h)).sends).toHaveLength(0);

			gw.clearRefundResult();
			expect(await cancelWith(h, gw, oid)).toMatchObject({
				ok: true,
				cancelled: true,
				refund: { amount: TOTAL_CENTS, currency: "USD" },
			});
			expect(gw.refundCalls).toHaveLength(2);
			expect((await h.orderStore.listRefunds(oid)).map((r) => r.status).toSorted()).toEqual([
				"recorded",
				"voided",
			]);
			expect((await drainEmails(h)).countByTemplate("order-cancelled", oid)).toBe(1);
		});

		// Review round 1: every follow-up heals on a replay, and says what it did.
		test("settled, then the follow-up crashed, then the order shipped: a confirm REPLAY flags it and tells the buyer once", async () => {
			const h = await makeHarness();
			const { oid, gw, key } = await unverifiedCancellation(h, "cxl-unv-heal");
			// The finalize lands, the cancel step does not run (the crash stand-in).
			expect(await resolveRefund(h, oid, key, "confirmed", { inventory: false })).toMatchObject({
				changed: true,
				followUp: { outcome: "cancel_again" },
			});
			await ship(h, oid);

			expect(await resolveRefund(h, oid, key, "confirmed")).toMatchObject({
				ok: true,
				changed: false,
				followUp: {
					purpose: "cancellation",
					outcome: "not_cancelled",
					state: "shipped",
					flagged: true,
					refundEmailQueued: true,
				},
			});
			const order = await h.orderStore.getById(oid);
			expect(order?.reconciliationFlag).toContain(`a cancellation (key cxl:${oid})`);
			expect(order?.reconciliationFlag).toContain("contact the buyer");
			expect((await drainEmails(h)).countByTemplate("order-refund-issued", oid)).toBe(1);

			// Again: the flag already names this cancellation, the notice is first-wins.
			expect(await resolveRefund(h, oid, key, "confirmed")).toMatchObject({
				followUp: { outcome: "not_cancelled", flagged: true, refundEmailQueued: false },
			});
			expect((await drainEmails(h)).sends).toHaveLength(0);
			expect(gw.refundCalls).toHaveLength(1);
		});

		test("an order cancelled by ANOTHER path without this refund on its record: the buyer is told about the refund once", async () => {
			const h = await makeHarness();
			const { oid, gw, key } = await unverifiedCancellation(h, "cxl-unv-elsewhere");
			// A plain cancel (another key, no refund leg) won while the refund was unknown.
			expect(
				await cancelOrder(
					{ orderStore: h.orderStore },
					{
						orderId: oid,
						reason: "other",
						cancelledBy: "someone",
						idempotencyKey: idempotencyKey("plain-cancel"),
					},
				),
			).toMatchObject({ ok: true, cancelled: true });
			await drainEmails(h);

			expect(await resolveRefund(h, oid, key, "confirmed")).toMatchObject({
				ok: true,
				changed: true,
				followUp: {
					purpose: "cancellation",
					outcome: "already_cancelled",
					refundEmailQueued: true,
				},
			});
			const sent = await drainEmails(h);
			expect(sent.countByTemplate("order-refund-issued", oid)).toBe(1);
			expect(sent.countByTemplate("order-cancelled", oid)).toBe(0);
			expect(await resolveRefund(h, oid, key, "confirmed")).toMatchObject({
				followUp: { outcome: "already_cancelled", refundEmailQueued: false },
			});
			expect((await drainEmails(h)).sends).toHaveLength(0);
			expect(gw.refundCalls).toHaveLength(1);
		});

		test("a cancel under a DIFFERENT key after the refund was settled carries that refund — never 'cancelled with no refund'", async () => {
			const h = await makeHarness();
			const { oid, gw, key } = await unverifiedCancellation(h, "cxl-unv-otherkey");
			await resolveRefund(h, oid, key, "confirmed", { inventory: false });

			expect(await cancelWith(h, gw, oid, { key: "api-cancel-2" })).toMatchObject({
				ok: true,
				cancelled: true,
				refund: { amount: TOTAL_CENTS, currency: "USD" },
			});
			expect((await h.orderStore.getById(oid))?.cancellation?.refund).toMatchObject({
				amount: TOTAL_CENTS,
			});
			expect(gw.refundCalls).toHaveLength(1);
			const sent = await drainEmails(h);
			expect(
				sent.sends.find((m) => m.template === "order-cancelled")?.data["cancellation"],
			).toMatchObject({ refund: { amountCents: TOTAL_CENTS, currency: "USD" } });
		});
	});
}
