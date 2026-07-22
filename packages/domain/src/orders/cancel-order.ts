import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { OrderStore } from "../ports/order-store.js";
import { emailTemplateForState, isLegalOrderTransition } from "./state-machine.js";
import type { CancellationReason, Order } from "./model.js";

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
	if (res.cancelled) return { ok: true, cancelled: true, order: res.order ?? order };

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
