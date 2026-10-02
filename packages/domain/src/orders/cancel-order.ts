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
import type { CancellationReason, CancellationRefund, Order, OrderState } from "./model.js";
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
	/** The refund and restock happened, but the order left its cancellable state
	 *  (shipped, say) before the cancel flip landed. The order is FLAGGED for
	 *  reconciliation naming the refund — the money is never silently returned on
	 *  an order that is not cancelled. */
	| "CANCEL_LOST_AFTER_REFUND"
	/** The refund went through, then the restock or the flip threw. The order is
	 *  flagged ("did not finish") and still cancellable; a retry completes it. */
	| "CANCEL_INCOMPLETE_AFTER_REFUND";

export type CancelOrderWithRefundOutcome =
	| {
			ok: true;
			/** False ⇒ an idempotent replay of a cancellation already on file. */
			cancelled: boolean;
			order: Order;
			/** The money this cancellation returned, or null when it returned none. */
			refund: CancellationRefund | null;
			/** Units returned to stock by THIS call (0 on a replay, or when declined). */
			restockedUnits: number;
			/** Lines the restock could NOT return, and why — reported, never dropped. */
			restockSkipped: RestockSkip[];
	  }
	| {
			ok: false;
			reason: Exclude<
				CancelOrderWithRefundFailure,
				"CANCEL_LOST_AFTER_REFUND" | "CANCEL_INCOMPLETE_AFTER_REFUND"
			>;
	  }
	/** The refund went through but the restock or the cancel flip then FAILED (an
	 *  error, not a refusal): the order is still `paid`/`processing`, flagged, and a
	 *  retry finishes it without refunding twice. */
	| {
			ok: false;
			reason: "CANCEL_INCOMPLETE_AFTER_REFUND";
			refund: CancellationRefund;
			/** The failure was a retryable storage condition (busy). */
			retryable: boolean;
	  }
	/** The refund (and restock) happened but the order shipped first — flagged. */
	| {
			ok: false;
			reason: "CANCEL_LOST_AFTER_REFUND";
			refund: CancellationRefund | null;
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
 * Return each physical line's units to stock EXACTLY ONCE.
 *
 * A line that still carries its checkout reservation is the subtle case. If settle's
 * commit bracket is still open the hold is `adopted`, and the cancel flip's release
 * intent would return its units — and a restock would return them AGAIN (phantom
 * stock, then oversell). So the bracket is CLOSED first: `commit` (idempotent; a
 * no-op on an already-committed hold), which leaves the release a no-op, then the
 * restock returns the units once. A hold that was already `released` (lost before
 * settlement) gave its units back then: it is skipped. A reservation record that no
 * longer exists cannot be told apart, so it is skipped too.
 *
 * Every write is keyed (`<key>:restock:<lineId>`, and `commit` is idempotent), so a
 * retry after a crash moves nothing more.
 */
async function restockLines(
	inventoryStore: InventoryStore,
	order: Order,
	key: IdempotencyKey,
	restock: boolean,
): Promise<{ restockedUnits: number; restockSkipped: RestockSkip[] }> {
	let restockedUnits = 0;
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
		// The bracket is closed whatever the operator chose (an ADOPTED hold left open
		// would be RELEASED by the flip — units back although Return to stock was
		// unticked). Only the restock itself follows the choice.
		if (!restock) continue;
		const res = await inventoryStore.restock(
			line.sku,
			line.quantity,
			toIdempotencyKey(`${key}:restock:${line.id}`),
		);
		if (res.ok) restockedUnits += line.quantity;
		else restockSkipped.push({ sku: line.sku, quantity: line.quantity, reason: "UNKNOWN_SKU" });
	}
	return { restockedUnits, restockSkipped };
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
 *  2. **Restock** each physical line through the inventory's exactly-once `restock`
 *     (key `<key>:restock:<lineId>`), unless the operator declined.
 *  3. **Cancel** through the store's guarded flip, recording the refund and the
 *     restock on the envelope; the cancelled email carries the refund.
 *
 * WHY THIS ORDER. The flip is LAST because it is the commit point: until it lands
 * the order is still `paid`, so the operator still sees a Cancel control and a
 * retry is the obvious next step. A retry after a crash anywhere in between replays
 * the refund (its key — recorded ⇒ duplicate, reserved ⇒ resumed under Stripe's
 * native idempotency) and the restock (spent keys move nothing), then lands the
 * flip. Neither the money nor the units can move twice.
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
 * `CANCEL_LOST_AFTER_REFUND` — loud, never a silent success.
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
		// The replay: report what the cancellation on file did, move nothing.
		if (order.cancellation === null) return { ok: false, reason: "NOT_CANCELLABLE" };
		return {
			ok: true,
			cancelled: false,
			order,
			refund: order.cancellation.refund ?? null,
			restockedUnits: 0,
			restockSkipped: [],
		};
	}
	if (!isLegalOrderTransition(order.state, "cancelled")) {
		return { ok: false, reason: "NOT_CANCELLABLE" };
	}
	if (order.state === "pending") {
		// Nothing was sold and nothing captured: the plain cancel, which releases the
		// held stock through the store's own release intent.
		const res = await cancelOrder({ orderStore: deps.orderStore }, cmd);
		return res.ok ? { ...res, refund: null, restockedUnits: 0, restockSkipped: [] } : res;
	}

	// 1. REFUND.
	const refundLeg = await refundForCancellation(deps, gateway, order, cmd, cancelledBy);
	if (!refundLeg.ok) return refundLeg.failure;
	const refund = refundLeg.refund;

	// 2–3. RESTOCK and CANCEL. Once money has moved, nothing below may surface as a
	// bare throw: the operator would read "a fault in the console", with the order
	// still paid, refunded and unflagged. So a failure here is flagged (best-effort)
	// and answered as CANCEL_INCOMPLETE_AFTER_REFUND — a retry finishes it, and its
	// refund replays rather than repeating.
	const restock = refundLeg.restock;
	let legs: {
		res: Awaited<ReturnType<OrderStore["cancelOrder"]>>;
		restockedUnits: number;
		restockSkipped: RestockSkip[];
	};
	try {
		legs = await restockAndFlip(deps, order, cmd, { detail, cancelledBy, refund, restock });
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
	const { res, restockedUnits, restockSkipped } = legs;
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
		return {
			ok: true,
			cancelled: true,
			order: res.order ?? order,
			refund,
			restockedUnits,
			restockSkipped,
		};
	}
	const fresh = res.order;
	if (fresh !== null && fresh.state === "cancelled" && fresh.cancellation !== null) {
		// A concurrent cancel (a second tab, the same key) won the flip: benign.
		return {
			ok: true,
			cancelled: false,
			order: fresh,
			refund: fresh.cancellation.refund ?? null,
			restockedUnits: 0,
			restockSkipped: [],
		};
	}
	if (refund !== null || restockedUnits > 0) {
		// TRULY lost: the order left every cancellable state (it shipped). The money is
		// back and the units may be too, so the order is flagged with what was done and
		// what to do next — never a silent success.
		const what = [
			refund !== null ? `refunded ${String(refund.amount)} ${refund.currency}` : null,
			restockedUnits > 0 ? `restocked ${String(restockedUnits)} unit(s)` : "restocked nothing",
		]
			.filter((part) => part !== null)
			.join(" and ");
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
			restockedUnits,
			movedTo: fresh?.state ?? null,
			refundId: refundLeg.refundId,
		};
	}
	return { ok: false, reason: "NOT_CANCELLABLE" };
}

/**
 * Legs 2 and 3: close every open commit bracket and restock when asked, then the
 * guarded cancel flip — retried once from where the order now is when it moved but
 * is still cancellable (paid → processing). The refund and restock are keyed, so the
 * retry repeats nothing.
 */
async function restockAndFlip(
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
	restockedUnits: number;
	restockSkipped: RestockSkip[];
}> {
	const { restockedUnits, restockSkipped } = await restockLines(
		deps.inventoryStore,
		order,
		cmd.idempotencyKey,
		opts.restock,
	);
	// `restocked` is what the restock records say happened (a replayed restock
	// reports its recorded units), not the checkbox.
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
			restocked: restockedUnits > 0,
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
	return { res, restockedUnits, restockSkipped };
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
