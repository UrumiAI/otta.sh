import { cents } from "../money/cents.js";
import { idempotencyKey as toIdempotencyKey } from "../money/ids.js";
import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import {
	ReservationCommitLostError,
	ReservationNotFoundError,
	type InventoryStore,
} from "../ports/inventory-store.js";
import type { OrderStore, RefundRecord } from "../ports/order-store.js";
import type { PaymentEventStore } from "../ports/payment-event-store.js";
import type { PaymentGateway } from "../ports/payment-gateway.js";
import { emailTemplateForState, isLegalOrderTransition } from "./state-machine.js";
import type {
	CancellationReason,
	CancellationRefund,
	CancellationRestockPending,
	Order,
	OrderLine,
	OrderState,
} from "./model.js";
import {
	computeRefundCeiling,
	refundOrder,
	sumCapturedPayments,
	sumRefunds,
	type RefundOrderFailure,
} from "./refund-order.js";

export interface CancelOrderDeps {
	orderStore: OrderStore;
}

export interface CancelOrderCommand {
	orderId: OrderId;
	reason: CancellationReason;
	/** Optional free-text elaboration — trimmed; an absent/blank value normalizes
	 *  to `null` (mirrors `recordFulfillment`'s optional `trackingUrl`). */
	detail?: string | null;
	/** Who cancelled it — trimmed + required non-empty (mirrors an order note's
	 *  `author`; the domain does not model admin identity). */
	cancelledBy: string;
	/** Every command carries one (CLAUDE.md); the store's guarded flip enforces
	 *  once-only. */
	idempotencyKey: IdempotencyKey;
}

export type CancelOrderFailure =
	| "ORDER_NOT_FOUND"
	/** The order's current state cannot legally reach `cancelled` (per
	 *  `isLegalOrderTransition(state, "cancelled")` — today `pending`, `paid`, and
	 *  `processing`). A terminal order (shipped/delivered/completed/refunded/
	 *  already-cancelled-without-reason via a DIFFERENT race, or already failed/
	 *  expired) is rejected: cancellation is only meaningful pre-fulfillment. */
	| "NOT_CANCELLABLE"
	| "EMPTY_CANCELLED_BY";

export type CancelOrderOutcome =
	| { ok: true; cancelled: boolean; order: Order }
	| { ok: false; reason: CancelOrderFailure };

/**
 * Cancel an order WITH a structured reason (admin-UX Increment 1, "cancel with
 * reason" slice). Pure orchestration — no IO of its own: validate, confirm the
 * order's current state can legally reach `cancelled` (per the ONE state
 * machine), then delegate the guarded "flip + record" compose to the store.
 *
 * This is the SAME composition shape as `recordFulfillment`: cancelling records
 * the reason envelope AND drives the transition to `cancelled` AND enqueues the
 * cancelled email, atomically, so no reachable state is "cancelled with no
 * reason recorded" (via this path). Mutable-envelope only — it NEVER touches
 * line items, prices, or totals (the snapshot invariant); the bare
 * `transitionOrder` command remains available for other callers/back-compat
 * (a cancellation via that path has `cancellation === null`, an honest "no
 * reason on file" state).
 *
 * Legality + idempotency, mirroring `recordFulfillment`/`transitionOrder`:
 *  - a state that can legally cancel (per `isLegalOrderTransition(state,
 *    "cancelled")` — never a re-listing; today `pending`/`paid`/`processing`)
 *    cancels once; the store's guarded `WHERE state=:fromState` flip makes
 *    concurrent/replayed calls a 0-row no-op, so exactly one reason is ever
 *    written and exactly one cancelled email enqueued;
 *  - an **already-cancelled-WITH-a-reason** order is an idempotent no-op success
 *    (`cancelled:false`) — a redelivery / double-submit is not an error;
 *  - an **already-cancelled-WITHOUT-a-reason** order (cancelled via the bare
 *    transition) is `NOT_CANCELLABLE` — this compose never back-fills a reason
 *    onto a cancellation it didn't make (mirrors `recordFulfillment`'s
 *    shipped-without-fulfillment case);
 *  - any **other state** (shipped/delivered/completed/refunded/failed/expired,
 *    or a concurrent transition that won the race first) is `NOT_CANCELLABLE`.
 */
export async function cancelOrder(
	deps: CancelOrderDeps,
	cmd: CancelOrderCommand,
): Promise<CancelOrderOutcome> {
	const cancelledBy = cmd.cancelledBy.trim();
	if (cancelledBy.length === 0) return { ok: false, reason: "EMPTY_CANCELLED_BY" };
	// The detail is optional free text: trim and treat a blank/absent value as
	// "none" (null) — mirrors recordFulfillment's optional trackingUrl.
	const trimmedDetail = (cmd.detail ?? "").trim();
	const detail = trimmedDetail.length === 0 ? null : trimmedDetail;

	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };

	// Already cancelled WITH a reason ⇒ benign idempotent no-op (a replay / double
	// submit). Already cancelled WITHOUT a reason (the bare transition path) is
	// not back-fillable via this compose — mirrors recordFulfillment's
	// shipped-without-fulfillment case.
	if (order.state === "cancelled") {
		if (order.cancellation !== null) return { ok: true, cancelled: false, order };
		return { ok: false, reason: "NOT_CANCELLABLE" };
	}
	// Legality is DERIVED from the one state machine (never a hardcoded state
	// list): cancellable ⇔ the current state can legally transition to
	// `cancelled` (today pending/paid/processing; if the machine ever widens
	// this, this — and the store's fromState guard below — follow automatically).
	if (!isLegalOrderTransition(order.state, "cancelled")) {
		return { ok: false, reason: "NOT_CANCELLABLE" };
	}

	const res = await deps.orderStore.cancelOrder({
		orderId: cmd.orderId,
		// The guarded flip's from-state — the state we just validated as legally
		// able to cancel (the `transition`/`recordFulfillment` fromState precedent).
		fromState: order.state,
		reason: cmd.reason,
		detail,
		cancelledBy,
		idempotencyKey: cmd.idempotencyKey,
		// `cancelled` always has a template — symmetric with `transitionOrder`/
		// `recordFulfillment`.
		enqueueEmail: emailTemplateForState("cancelled") !== null,
	});
	if (res.cancelled) {
		// An order cancelled while UNPAID still has a payable intent, due only at its
		// hold deadline. Make it due NOW so the intent-cancel sweep withdraws it on
		// its next tick (`cancelDueIntents`). From `paid`/`processing` the intent
		// already succeeded — nothing to withdraw, and refunding is the admin's act.
		if (order.state === "pending") await expediteIntentCancels(deps, cmd.orderId, res.order);
		return { ok: true, cancelled: true, order: res.order ?? order };
	}

	// The guarded flip missed (0 rows) — someone moved the order out of
	// `fromState` between our read and the UPDATE. Disambiguate on the fresh row:
	// cancelled WITH a reason ⇒ a concurrent cancel won (benign no-op); anything
	// else (a concurrent ship/refund/etc., or cancelled-without-reason) ⇒ not
	// cancellable.
	const fresh = res.order;
	if (fresh !== null && fresh.state === "cancelled" && fresh.cancellation !== null) {
		return { ok: true, cancelled: false, order: fresh };
	}
	return { ok: false, reason: "NOT_CANCELLABLE" };
}

/**
 * Bring an unpaid-cancelled order's unresolved intents due to the cancellation
 * instant (the store-stamped `updatedAt` of the flip, so no clock is needed here).
 * BEST-EFFORT: the cancellation is already durable; a failed write only leaves the
 * intent due at its hold, which the sweep reaches anyway, and a payment that lands
 * meanwhile is refunded at settle. Logged, never thrown.
 */
async function expediteIntentCancels(
	deps: CancelOrderDeps,
	orderId: CancelOrderCommand["orderId"],
	after: Order | null,
): Promise<void> {
	if (after === null) return;
	const at = after.updatedAt;
	try {
		for (const intent of await deps.orderStore.listPaymentIntents(orderId)) {
			if (intent.cancelOutcome !== null) continue;
			if (intent.cancelDueAt !== null && intent.cancelDueAt <= at) continue;
			await deps.orderStore.updatePaymentIntentCancel(orderId, intent.intentId, {
				cancelDueAt: at,
				cancelAttempts: intent.cancelAttempts,
				cancelOutcome: null,
			});
		}
	} catch (err) {
		console.error(`[domain] could not expedite the intent cancels of cancelled order ${orderId}`, {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// -- cancelling an order that has been paid -----------------------------------

export interface CancelOrderWithRefundDeps {
	orderStore: OrderStore;
	/** Where a cancellation returns sold units (`restock`, exactly-once per key). */
	inventoryStore: InventoryStore;
	/** Forwarded to `refundOrder` for its loud "issued but unrecorded" residual. */
	paymentEventStore?: PaymentEventStore;
	clock?: Clock;
	/** Whether an error is a RETRYABLE storage condition (the plugin's
	 *  `isRetryableStorageBusy`). Only shapes the operator's wording after the refund:
	 *  "the store was busy" instead of "did not finish". The domain cannot name the
	 *  adapter's error, so the caller tells it. */
	isRetryable?: (err: unknown) => boolean;
}

export interface CancelOrderWithRefundCommand extends CancelOrderCommand {
	/**
	 * Return the order's physical units to stock. The operator's call — `false` for
	 * goods that came back damaged. Ignored for a `pending` order, whose units were
	 * never sold: its held stock is released by the cancel itself.
	 */
	restock: boolean;
}

export type CancelOrderWithRefundFailure =
	| CancelOrderFailure
	/** Money was captured, but this order's gateway cannot return it automatically
	 *  (x402, which has no wallet to send from — ADR-0008 — or no gateway wired).
	 *  NOTHING changed: refunding it is a person's job, recorded in Money → Refunds. */
	| "REFUND_NOT_AUTOMATIC"
	/** Another refund on this order is still reserved or of unknown outcome. NOTHING
	 *  changed: refunding the "rest" now could double-refund what that one returns. */
	| "REFUND_IN_FLIGHT"
	/** The order was paid in more than one capture. One refund targets one capture,
	 *  so Otta cannot return the whole in one step; NOTHING changed. (Refunding per
	 *  capture is a follow-up.) */
	| "MULTIPLE_CAPTURES"
	/** The refund happened, but the order left its cancellable state (shipped, say)
	 *  before the cancel flip landed. Nothing was restocked: the restock waits for the
	 *  flip. The order is FLAGGED for reconciliation naming the refund — the money is
	 *  never silently returned on an order that is not cancelled. */
	| "CANCEL_LOST_AFTER_REFUND"
	/** The refund went through, then closing a commit bracket or the flip threw. The
	 *  order is flagged ("did not finish") and still cancellable; a retry completes
	 *  it. Nothing was restocked. */
	| "CANCEL_INCOMPLETE_AFTER_REFUND";

export type CancelOrderWithRefundOutcome =
	| {
			ok: true;
			/** False ⇒ an idempotent replay of a cancellation already on file. */
			cancelled: boolean;
			order: Order;
			/** The money this cancellation returned, or null when it returned none. */
			refund: CancellationRefund | null;
			/** Units returned to stock by THIS call (0 when declined, or on a replay
			 *  with nothing left owed). */
			restockedUnits: number;
			/** Lines the restock could NOT return, and why — reported, never dropped. */
			restockSkipped: RestockSkip[];
			/** The order is cancelled but its units have NOT all come back yet: the
			 *  restock after the flip failed. It stays recorded on the cancellation
			 *  (`restockPending`) and the sweep — or a replay — finishes it. A caller
			 *  must not say the units were returned. */
			restockPending: boolean;
	  }
	| {
			ok: false;
			reason: Exclude<
				CancelOrderWithRefundFailure,
				"CANCEL_LOST_AFTER_REFUND" | "CANCEL_INCOMPLETE_AFTER_REFUND"
			>;
	  }
	/** The refund went through but closing a commit bracket or the cancel flip then
	 *  FAILED (an error, not a refusal): the order is still `paid`/`processing`,
	 *  flagged, nothing restocked, and a retry finishes it without refunding twice. */
	| {
			ok: false;
			reason: "CANCEL_INCOMPLETE_AFTER_REFUND";
			refund: CancellationRefund;
			/** The failure was a retryable storage condition (busy). */
			retryable: boolean;
	  }
	/** The refund happened but the order shipped first — flagged. */
	| {
			ok: false;
			reason: "CANCEL_LOST_AFTER_REFUND";
			refund: CancellationRefund | null;
			/** Always 0: the restock runs only after a flip that landed, so units that
			 *  shipped are never counted back. Kept so callers need not change. */
			restockedUnits: number;
			/** The state the order moved to instead (shipped, say). */
			movedTo: OrderState | null;
			/** The refund whose `refund-issued` notice now tells the buyer — so a caller
			 *  can send it inline. Null when nothing was refunded. */
			refundId: string | null;
	  }
	/** The refund leg failed and the order was NOT cancelled; `refundFailure` says
	 *  why, with `refundOrder`'s own taxonomy (retryable, rejected, unknown, …). */
	| { ok: false; reason: "REFUND_FAILED"; refundFailure: RefundOrderFailure };

/**
 * A line the cancellation could not restock:
 *  - `UNKNOWN_SKU`   — no inventory row for the sku (the product was deleted);
 *  - `HOLD_RELEASED` — the line's hold was lost before settlement, so its units went
 *    back to stock then and were never taken; returning them again would be phantom
 *    stock;
 *  - `HOLD_UNKNOWN`  — the line's reservation record is gone, so whether its units
 *    were taken cannot be told; not restocked (the safe direction — no phantom stock).
 */
export interface RestockSkip {
	sku: string;
	quantity: number;
	reason: "UNKNOWN_SKU" | "HOLD_RELEASED" | "HOLD_UNKNOWN";
}

/**
 * Close every physical line's open commit bracket, BEFORE the flip, and say which
 * lines a restock may return.
 *
 * A line that still carries its checkout reservation is the subtle case. If settle's
 * commit bracket is still open the hold is `adopted`, and the cancel flip's release
 * intent would return its units — and a restock would return them AGAIN (phantom
 * stock, then oversell). So the bracket is CLOSED first: `commit` (idempotent; a
 * no-op on an already-committed hold), which leaves the release a no-op. Committing
 * returns no stock, so it is safe whether or not the flip then lands: if the order
 * ships instead, its units are sold, which is what a committed hold says. A hold that
 * was already `released` (lost before settlement) gave its units back then: it is
 * skipped. A reservation record that no longer exists cannot be told apart, so it is
 * skipped too.
 */
async function closeBrackets(
	inventoryStore: InventoryStore,
	order: Order,
): Promise<{ restockable: OrderLine[]; restockSkipped: RestockSkip[] }> {
	const restockable: OrderLine[] = [];
	const restockSkipped: RestockSkip[] = [];
	for (const line of order.lines) {
		if (line.fulfillmentKind !== "physical") continue;
		if (line.reservationId !== null) {
			try {
				await inventoryStore.commit(line.reservationId);
			} catch (err) {
				if (err instanceof ReservationCommitLostError) {
					// Only a RELEASED hold provably gave its units back; any other lost state
					// (pending, failed, …) cannot be told apart.
					restockSkipped.push({
						sku: line.sku,
						quantity: line.quantity,
						reason: err.state === "released" ? "HOLD_RELEASED" : "HOLD_UNKNOWN",
					});
					continue;
				}
				if (err instanceof ReservationNotFoundError) {
					restockSkipped.push({ sku: line.sku, quantity: line.quantity, reason: "HOLD_UNKNOWN" });
					continue;
				}
				throw err;
			}
		}
		restockable.push(line);
	}
	return { restockable, restockSkipped };
}

/**
 * Return the units a cancellation recorded as owed, EXACTLY ONCE: each line through
 * the inventory's keyed `restock` (`<key>:restock:<lineId>`, the key recorded on the
 * flip), so a replay, the sweep, or both at once move nothing more. A replayed key
 * reports its recorded units. It never re-commits a hold: the brackets were closed
 * before the flip, and a committed reservation may since have been pruned.
 */
async function restockOwed(
	inventoryStore: InventoryStore,
	order: Order,
	pending: CancellationRestockPending,
): Promise<{ restockedUnits: number; restockSkipped: RestockSkip[] }> {
	let restockedUnits = 0;
	const restockSkipped: RestockSkip[] = [];
	const owed = new Set(pending.lineIds);
	for (const line of order.lines) {
		if (!owed.has(String(line.id))) continue;
		const res = await inventoryStore.restock(
			line.sku,
			line.quantity,
			toIdempotencyKey(`${pending.idempotencyKey}:restock:${String(line.id)}`),
		);
		if (res.ok) restockedUnits += line.quantity;
		else restockSkipped.push({ sku: line.sku, quantity: line.quantity, reason: "UNKNOWN_SKU" });
	}
	return { restockedUnits, restockSkipped };
}

/**
 * How many CONSECUTIVE failed sweep attempts at a cancellation's pending restock
 * are retried quietly before the order is flagged for the operator (ADR-0026's
 * 2026-10-05 amendment). The sweep keeps retrying after the flag; the flag is
 * written once and clears itself when the restock lands.
 */
export const CANCELLATION_RESTOCK_FLAG_AFTER = 3;

/** The prefix of the flag a stuck cancellation restock leaves, so its completion can
 *  recognise (and clear) exactly that flag. */
function restockFlagPrefix(key: string): string {
	return `a cancellation (key ${key}): items could not be returned to stock`;
}

export interface FinishCancellationRestockDeps {
	orderStore: OrderStore;
	inventoryStore: InventoryStore;
}

export interface FinishCancellationRestockOutcome {
	/** True ⇒ THIS call closed the pending restock. False ⇒ nothing was owed, or a
	 *  racing caller closed it first (the units still moved once). */
	finished: boolean;
	restockedUnits: number;
	restockSkipped: RestockSkip[];
	/** Why this attempt failed, or null. A failure leaves the restock owed. */
	failure: string | null;
}

/**
 * Finish a cancelled order's pending restock (issue #364) — the sweep's entry point.
 * A no-op for an order that is not cancelled or owes nothing. Exactly-once under any
 * interleaving: the units move under the keys the flip recorded, and the marker is
 * cleared compare-and-set on its own key.
 *
 * A failure is returned, never thrown, and counted on the marker. At
 * {@link CANCELLATION_RESTOCK_FLAG_AFTER} consecutive failures the order is flagged
 * ("items could not be returned to stock: <why>"), once; later attempts keep trying
 * without writing it again. The attempt that lands clears that flag
 * (compare-and-clear on its exact text, as the cancel clears its own).
 */
export async function finishCancellationRestock(
	deps: FinishCancellationRestockDeps,
	orderId: OrderId,
): Promise<FinishCancellationRestockOutcome> {
	const order = await deps.orderStore.getById(orderId);
	const pending = order?.cancellation?.restockPending ?? null;
	if (order === null || order.state !== "cancelled" || pending === null) {
		return { finished: false, restockedUnits: 0, restockSkipped: [], failure: null };
	}
	const nothing = { finished: false, restockedUnits: 0, restockSkipped: [] };
	let moved: { restockedUnits: number; restockSkipped: RestockSkip[] };
	let closed: { completed: boolean; order: Order | null };
	try {
		moved = await restockOwed(deps.inventoryStore, order, pending);
		closed = await deps.orderStore.completeCancellationRestock({
			orderId: order.id,
			idempotencyKey: pending.idempotencyKey,
			restocked: moved.restockedUnits > 0,
		});
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		await bestEffort(async () => {
			const failures = await deps.orderStore.recordCancellationRestockFailure(
				order.id,
				pending.idempotencyKey,
			);
			const prefix = restockFlagPrefix(pending.idempotencyKey);
			if (
				failures >= CANCELLATION_RESTOCK_FLAG_AFTER &&
				!(order.reconciliationFlag ?? "").startsWith(prefix)
			) {
				await deps.orderStore.flagReconciliation(
					order.id,
					`${prefix}: ${why}. Otta keeps retrying; this clears once they are back`,
				);
			}
		});
		return { ...nothing, failure: why };
	}
	const stale = closed.order?.reconciliationFlag ?? null;
	if (stale !== null && stale.startsWith(restockFlagPrefix(pending.idempotencyKey))) {
		await bestEffort(() =>
			deps.orderStore.resolveReconciliation({
				orderId: order.id,
				expectedFlag: stale,
				outcome: "refunded",
				reason: "The cancellation's restock finished on a later attempt.",
				resolvedBy: "otta",
				idempotencyKey: toIdempotencyKey(`${pending.idempotencyKey}:resolve-restock`),
			}),
		);
	}
	return { finished: closed.completed, ...moved, failure: null };
}

/** How many definitively-rejected (`voided`) refund attempts one cancellation may
 *  step past before it stops asking the provider. A safety bound, not a policy. */
const MAX_CANCELLATION_REFUND_ATTEMPTS = 10;

/**
 * Cancel an order and give the buyer their money back (QA T1-4; the maintainer's
 * 2026-10-02 decision; ADR-0008's 2026-10-02 amendment). A `pending` order is
 * cancelled exactly as {@link cancelOrder} cancels it. A `paid` or `processing`
 * order is cancelled in three legs, each idempotent on a key derived from the
 * command's own:
 *
 *  1. **Refund** whatever is still refundable — the ceiling `min(Σ captured,
 *     total)` less what earlier refunds already returned — through the SAME
 *     reserve → issue → finalize ledger every refund uses (`refundOrder`, purpose
 *     `cancellation`, key `<key>:refund`). No second money path. The row's purpose
 *     stops it flipping the order `→ refunded`: the cancellation closes it instead.
 *  2. **Cancel** through the store's guarded flip, recording the refund on the
 *     envelope (the cancelled email carries it) and, when units are to come back,
 *     the restock it still owes (`restockPending`: the key and the lines). Every
 *     open commit bracket is closed just before, so the flip's release returns
 *     nothing.
 *  3. **Restock** each owed line through the inventory's exactly-once `restock`
 *     (key `<key>:restock:<lineId>`), then clear `restockPending`.
 *
 * WHY THIS ORDER (issue #364). The refund comes first because a refund that fails
 * must refuse the cancel (below). The flip is the commit point for the ORDER: until
 * it lands the order is still `paid`, the operator still sees a Cancel control, and a
 * retry replays the refund (its key — recorded ⇒ duplicate, reserved ⇒ resumed under
 * Stripe's native idempotency) and lands the flip. The restock comes AFTER the flip
 * because units are only owed back by a cancelled order: restocking first counted
 * units back into stock when a concurrent fulfilment won the flip, or when the flip
 * threw, and those units could be sold twice. A restock that fails after the flip is
 * not lost — the flip recorded it, and a replay or the sweep's hold-intent leg
 * finishes it under the recorded keys. Neither the money nor the units move twice.
 *
 * WHY A FAILED REFUND REFUSES THE CANCEL rather than cancelling and flagging the
 * order for a manual refund: refusing leaves no state in which the buyer has been
 * told "cancelled" while the shop keeps the money, and the order stays exactly as
 * the operator found it — still paid, stock untouched, nobody emailed. A retryable
 * failure is retried by clicking again (the reservation is resumed under its key);
 * a definite rejection spends its key, and the next attempt uses `<key>:refund:<n>`;
 * an unknown outcome is never retried blind.
 *
 * WHAT IS REFUSED UP FRONT, with nothing changed: money this gateway cannot return
 * automatically (`REFUND_NOT_AUTOMATIC` — recording a manual refund here would claim
 * the operator already sent it), and another refund still in flight on the order
 * (`REFUND_IN_FLIGHT`).
 *
 * THE ONE STATE LEFT FOR A PERSON: the order leaves `paid`/`processing` (it ships)
 * between the refund and the flip. The money is back and cannot be un-refunded, so
 * the order is flagged for reconciliation naming the refund, and the outcome is
 * `CANCEL_LOST_AFTER_REFUND` — loud, never a silent success. No unit was restocked.
 */
export async function cancelOrderWithRefund(
	deps: CancelOrderWithRefundDeps,
	gateway: PaymentGateway | null,
	cmd: CancelOrderWithRefundCommand,
): Promise<CancelOrderWithRefundOutcome> {
	const cancelledBy = cmd.cancelledBy.trim();
	if (cancelledBy.length === 0) return { ok: false, reason: "EMPTY_CANCELLED_BY" };
	const trimmedDetail = (cmd.detail ?? "").trim();
	const detail = trimmedDetail.length === 0 ? null : trimmedDetail;

	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };
	if (order.state === "cancelled") {
		// The replay: report what the cancellation on file did, and finish the restock
		// it still owes, if any (under the key the flip recorded — never this call's).
		if (order.cancellation === null) return { ok: false, reason: "NOT_CANCELLABLE" };
		const owed = await finishOwedRestock(deps, order);
		return {
			ok: true,
			cancelled: false,
			order: owed.order,
			refund: order.cancellation.refund ?? null,
			restockedUnits: owed.restockedUnits,
			restockSkipped: owed.restockSkipped,
			restockPending: owed.restockPending,
		};
	}
	if (!isLegalOrderTransition(order.state, "cancelled")) {
		return { ok: false, reason: "NOT_CANCELLABLE" };
	}
	if (order.state === "pending") {
		// Nothing was sold and nothing captured: the plain cancel, which releases the
		// held stock through the store's own release intent.
		const res = await cancelOrder({ orderStore: deps.orderStore }, cmd);
		return res.ok
			? { ...res, refund: null, restockedUnits: 0, restockSkipped: [], restockPending: false }
			: res;
	}

	// 1. REFUND.
	const refundLeg = await refundForCancellation(deps, gateway, order, cmd, cancelledBy);
	if (!refundLeg.ok) return refundLeg.failure;
	const refund = refundLeg.refund;

	// 2. CANCEL (closing the commit brackets first). Once money has moved, nothing
	// below may surface as a bare throw: the operator would read "a fault in the
	// console", with the order still paid, refunded and unflagged. So a failure here
	// is flagged (best-effort) and answered as CANCEL_INCOMPLETE_AFTER_REFUND — a
	// retry finishes it, and its refund replays rather than repeating. Nothing has
	// been restocked at this point.
	const restock = refundLeg.restock;
	let legs: Awaited<ReturnType<typeof closeAndFlip>>;
	try {
		legs = await closeAndFlip(deps, order, cmd, { detail, cancelledBy, refund, restock });
	} catch (err) {
		if (refund === null) throw err;
		await bestEffort(() =>
			deps.orderStore.flagReconciliation(
				cmd.orderId,
				`${cancellationFlagPrefix(cmd.idempotencyKey)} refunded ${String(refund.amount)} ${refund.currency} but did not finish — click Cancel order again (it will not refund twice)`,
			),
		);
		return {
			ok: false,
			reason: "CANCEL_INCOMPLETE_AFTER_REFUND",
			refund,
			retryable: deps.isRetryable?.(err) ?? false,
		};
	}
	const { res, restockSkipped: bracketSkips } = legs;
	if (res.cancelled) {
		// A retry that FINISHED clears the "did not finish — click Cancel order again"
		// flag an earlier attempt left: compare-and-clear on that exact flag, so an
		// anomaly flagged by anything else is never cleared here.
		const finished = res.order;
		const stale = finished?.reconciliationFlag ?? null;
		if (stale !== null && stale.startsWith(cancellationFlagPrefix(cmd.idempotencyKey))) {
			await bestEffort(() =>
				deps.orderStore.resolveReconciliation({
					orderId: cmd.orderId,
					expectedFlag: stale,
					outcome: "refunded",
					reason: "The cancellation finished on a retry; its refund was issued once.",
					resolvedBy: cancelledBy,
					idempotencyKey: toIdempotencyKey(`${cmd.idempotencyKey}:resolve-incomplete`),
				}),
			);
		}
		// 3. RESTOCK, now that the order is cancelled. The flip recorded what is owed,
		// so a failure here loses nothing: the order says "restock pending", and the
		// sweep (or a replay) finishes it.
		const owed = await finishOwedRestock(deps, res.order ?? order);
		return {
			ok: true,
			cancelled: true,
			order: owed.order,
			refund,
			restockedUnits: owed.restockedUnits,
			restockSkipped: [...bracketSkips, ...owed.restockSkipped],
			restockPending: owed.restockPending,
		};
	}
	const fresh = res.order;
	if (fresh !== null && fresh.state === "cancelled" && fresh.cancellation !== null) {
		// A concurrent cancel (a second tab, the same key) won the flip: benign. Its own
		// call restocks; this one reports whether that is still owed.
		return {
			ok: true,
			cancelled: false,
			order: fresh,
			refund: fresh.cancellation.refund ?? null,
			restockedUnits: 0,
			restockSkipped: [],
			restockPending: (fresh.cancellation.restockPending ?? null) !== null,
		};
	}
	if (refund !== null) {
		// TRULY lost: the order left every cancellable state (it shipped). The money is
		// back, so the order is flagged with what was done and what to do next — never
		// a silent success. No unit was restocked: the restock waits for the flip.
		const what = `refunded ${String(refund.amount)} ${refund.currency} and restocked nothing`;
		// The cancelled email that would have told the buyer about their money will
		// never go, so the refund announces itself instead — the same `refund-issued`
		// notice an admin partial refund sends, first-wins per refund (QA T1-6).
		// Best-effort like the flag: nothing after a refund surfaces as a bare throw.
		const lostRefundId = refundLeg.refundId;
		if (refund !== null && lostRefundId !== null) {
			await bestEffort(() =>
				deps.orderStore.enqueueNotice(cmd.orderId, {
					kind: "refund-issued",
					amount: refund.amount,
					currency: refund.currency,
					refundId: lostRefundId,
				}),
			);
		}
		await bestEffort(() =>
			deps.orderStore.flagReconciliation(
				cmd.orderId,
				`${cancellationFlagPrefix(cmd.idempotencyKey)} ${what}, but the order moved to ${fresh?.state ?? "an unknown state"} before it could be cancelled — contact the buyer, then stop the shipment or use Mark refunded; do not ship or refund it again unchecked`,
			),
		);
		return {
			ok: false,
			reason: "CANCEL_LOST_AFTER_REFUND",
			refund,
			restockedUnits: 0,
			movedTo: fresh?.state ?? null,
			refundId: refundLeg.refundId,
		};
	}
	return { ok: false, reason: "NOT_CANCELLABLE" };
}

/**
 * Leg 2: close every open commit bracket, then the guarded cancel flip — retried once
 * from where the order now is when it moved but is still cancellable (paid →
 * processing). The flip records the restock still owed (`restockPending`) when the
 * operator asked for one and a line can take it; it restocks nothing itself.
 */
async function closeAndFlip(
	deps: CancelOrderWithRefundDeps,
	order: Order,
	cmd: CancelOrderWithRefundCommand,
	opts: {
		detail: string | null;
		cancelledBy: string;
		refund: CancellationRefund | null;
		restock: boolean;
	},
): Promise<{
	res: Awaited<ReturnType<OrderStore["cancelOrder"]>>;
	restockSkipped: RestockSkip[];
}> {
	// The bracket is closed whatever the operator chose (an ADOPTED hold left open
	// would be RELEASED by the flip — units back although Return to stock was
	// unticked). Only the restock itself follows the choice.
	const { restockable, restockSkipped } = await closeBrackets(deps.inventoryStore, order);
	const restockPending: CancellationRestockPending | null =
		opts.restock && restockable.length > 0
			? {
					idempotencyKey: String(cmd.idempotencyKey),
					lineIds: restockable.map((line) => String(line.id)),
				}
			: null;
	const flip = (fromState: OrderState) =>
		deps.orderStore.cancelOrder({
			orderId: cmd.orderId,
			fromState,
			reason: cmd.reason,
			detail: opts.detail,
			cancelledBy: opts.cancelledBy,
			idempotencyKey: cmd.idempotencyKey,
			enqueueEmail: emailTemplateForState("cancelled") !== null,
			refund: opts.refund,
			// Nothing is back yet; the restock that follows the flip records it.
			restocked: false,
			restockPending,
		});
	let res = await flip(order.state);
	if (
		!res.cancelled &&
		res.order !== null &&
		res.order.state !== "cancelled" &&
		isLegalOrderTransition(res.order.state, "cancelled")
	) {
		res = await flip(res.order.state);
	}
	return { res, restockSkipped };
}

/**
 * Leg 3, after a flip that landed (or on a replay): finish the restock the
 * cancellation owes. A failure is an OUTCOME, never a throw — the order is already
 * cancelled and refunded, so the caller reports `restockPending` and the sweep
 * finishes it. A failure clearing the marker after the units moved is reported as
 * done: the units are back, and the sweep's replay of spent keys only tidies the
 * record.
 */
async function finishOwedRestock(
	deps: FinishCancellationRestockDeps,
	order: Order,
): Promise<{
	order: Order;
	restockedUnits: number;
	restockSkipped: RestockSkip[];
	restockPending: boolean;
}> {
	const pending = order.cancellation?.restockPending ?? null;
	if (pending === null) {
		return { order, restockedUnits: 0, restockSkipped: [], restockPending: false };
	}
	let moved: { restockedUnits: number; restockSkipped: RestockSkip[] };
	try {
		moved = await restockOwed(deps.inventoryStore, order, pending);
	} catch (err) {
		console.error(
			`[domain] cancelled order ${order.id}: the restock did not finish; the sweep will retry it`,
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return { order, restockedUnits: 0, restockSkipped: [], restockPending: true };
	}
	let after = order;
	try {
		const closed = await deps.orderStore.completeCancellationRestock({
			orderId: order.id,
			idempotencyKey: pending.idempotencyKey,
			restocked: moved.restockedUnits > 0,
		});
		after = closed.order ?? order;
	} catch (err) {
		console.error(
			`[domain] cancelled order ${order.id}: units restocked, but the pending marker was not cleared; the sweep will clear it`,
			{ error: err instanceof Error ? err.message : String(err) },
		);
	}
	return { order: after, ...moved, restockPending: false };
}

/** The prefix of every flag a cancellation leaves, so a later attempt of the SAME
 *  cancellation can recognise (and clear) its own. */
function cancellationFlagPrefix(key: IdempotencyKey): string {
	return `a cancellation (key ${key})`;
}

/** Run a write whose failure must not surface — after a refund, nothing may throw
 *  bare; the outcome the caller returns still tells the operator. */
async function bestEffort(write: () => Promise<unknown>): Promise<void> {
	try {
		await write();
	} catch {
		// Best-effort by design: see the caller.
	}
}

type RefundLeg =
	| { ok: true; refund: CancellationRefund | null; refundId: string | null; restock: boolean }
	| { ok: false; failure: Extract<CancelOrderWithRefundOutcome, { ok: false }> };

/**
 * The cancellation's refund leg: find the attempt this cancellation already made
 * (by its key), or size a new one at what is still refundable, and run it through
 * `refundOrder`. `null` refund ⇒ there was nothing to return.
 */
async function refundForCancellation(
	deps: CancelOrderWithRefundDeps,
	gateway: PaymentGateway | null,
	order: Order,
	cmd: CancelOrderWithRefundCommand,
	cancelledBy: string,
): Promise<RefundLeg> {
	// The attempt this cancellation owns: the first of its keys that is not a
	// definitively-rejected (`voided`) attempt. A voided attempt moved no money, so
	// stepping past it to a fresh key is safe; anything else under the key is THIS
	// cancellation's refund, recorded or still to be resumed.
	let key: IdempotencyKey | null = null;
	let mine: RefundRecord | null = null;
	for (let attempt = 1; attempt <= MAX_CANCELLATION_REFUND_ATTEMPTS; attempt++) {
		const candidate = toIdempotencyKey(
			attempt === 1 ? `${cmd.idempotencyKey}:refund` : `${cmd.idempotencyKey}:refund:${attempt}`,
		);
		const existing = await deps.orderStore.getRefundByIdempotencyKey(candidate);
		if (existing === null || existing.status !== "voided") {
			key = candidate;
			mine = existing;
			break;
		}
	}
	if (key === null) {
		return {
			ok: false,
			failure: { ok: false, reason: "REFUND_FAILED", refundFailure: "GATEWAY_TERMINAL" },
		};
	}

	let amount: number;
	if (mine !== null) {
		amount = mine.amount;
	} else {
		const [payments, refunds] = await Promise.all([
			deps.orderStore.getCapturedPayments(order.id),
			deps.orderStore.listRefunds(order.id),
		]);
		if (refunds.some((r) => r.status === "reserved" || r.status === "unverified")) {
			return { ok: false, failure: { ok: false, reason: "REFUND_IN_FLIGHT" } };
		}
		const ceiling = computeRefundCeiling(sumCapturedPayments(payments), order.totals.total);
		amount = Math.max(0, ceiling - sumRefunds(refunds));
		// One gateway refund targets ONE capture, so a remainder spread over several
		// captures would be rejected by the provider attempt after attempt. Refused
		// up front instead, with its own reason.
		if (amount > 0 && payments.filter((p) => p.status === "succeeded").length > 1) {
			return { ok: false, failure: { ok: false, reason: "MULTIPLE_CAPTURES" } };
		}
	}
	// The FIRST attempt's restock choice wins: a crashed attempt's row carries it, so
	// a retry with the box flipped does not contradict units already moved.
	const restock = mine?.restock ?? cmd.restock;
	if (amount === 0) return { ok: true, refund: null, refundId: null, restock };
	if (gateway === null || !gateway.refundable) {
		return { ok: false, failure: { ok: false, reason: "REFUND_NOT_AUTOMATIC" } };
	}

	const res = await refundOrder(
		{
			orderStore: deps.orderStore,
			...(deps.paymentEventStore !== undefined
				? { paymentEventStore: deps.paymentEventStore }
				: {}),
			...(deps.clock !== undefined ? { clock: deps.clock } : {}),
		},
		gateway,
		{
			orderId: order.id,
			amount: cents(amount),
			currency: order.totals.currency,
			reason: `order cancelled (${cmd.reason})`,
			refundedBy: cancelledBy,
			idempotencyKey: key,
			purpose: "cancellation",
			restock: cmd.restock,
		},
	);
	if (!res.ok) {
		return {
			ok: false,
			failure: { ok: false, reason: "REFUND_FAILED", refundFailure: res.reason },
		};
	}
	return {
		ok: true,
		refund: { amount: res.refund.amount, currency: res.refund.currency },
		restock,
		refundId: res.refund.id,
	};
}
