import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { OrderStore } from "../ports/order-store.js";
import type { Order, ReconciliationOutcome } from "./model.js";

export interface ResolveReconciliationDeps {
	orderStore: OrderStore;
}

export interface ResolveReconciliationCommand {
	orderId: OrderId;
	/** The flag detail the admin REVIEWED (exactly as displayed). The resolve is a
	 *  compare-and-clear on this value — following `transition`'s fromState-equality
	 *  precedent — so a NEW anomaly re-flagging the order between page load and
	 *  submit is a `RECONCILIATION_FLAG_CHANGED` conflict, never a blind clear of
	 *  an anomaly nobody reviewed. */
	expectedFlag: string;
	outcome: ReconciliationOutcome;
	/** Human justification — trimmed + required non-empty (a blank disposition is
	 *  meaningless); the trimmed value is what gets persisted. */
	reason: string;
	/** Who resolved it — trimmed + required non-empty (mirrors an order note's
	 *  `author`; the domain does not model admin identity). */
	resolvedBy: string;
	/** Every command carries one (CLAUDE.md); the store enforces once-only on the
	 *  guarded flip. */
	idempotencyKey: IdempotencyKey;
}

export type ResolveReconciliationFailure =
	| "ORDER_NOT_FOUND"
	| "NOT_IN_RECONCILIATION"
	/** The order's live flag differs from the one the admin reviewed (a new settle
	 *  anomaly re-flagged it mid-review). The caller should reload and re-review. */
	| "RECONCILIATION_FLAG_CHANGED"
	| "EMPTY_REASON"
	| "EMPTY_RESOLVER";

export type ResolveReconciliationOutcome =
	| { ok: true; resolved: boolean; order: Order }
	| { ok: false; reason: ResolveReconciliationFailure };

/**
 * Resolve an order's manual-reconciliation flag (admin-UX Increment 1). Pure
 * orchestration — no IO of its own: validate, confirm the order is actually in
 * the reconciliation-needed state the ADMIN REVIEWED, then delegate the guarded
 * compare-and-clear to the store.
 *
 * The reconciliation dimension is a **two-state machine orthogonal to the order
 * state machine**: `flagged (reconciliationFlag ≠ null) → resolved (flag null +
 * disposition recorded)`. This use-case only ever moves an order along THAT axis
 * — it NEVER touches `order.state`, line items, or totals (the snapshot
 * invariant). A real refund/cancel is the separate `transitionOrder` command; the
 * `outcome` here only RECORDS which disposition the admin took — it moves no
 * money.
 *
 * Legality + idempotency, mirroring `transitionOrder`:
 *  - a **flagged** order resolves once, and only against the EXACT flag the
 *    admin reviewed — the store's guarded `WHERE reconciliation_flag =
 *    :expectedFlag` flip makes concurrent/replayed calls a 0-row no-op
 *    (`resolved:false`), so exactly one disposition is ever written;
 *  - a **stale review** (the live flag differs from `expectedFlag` — a new
 *    anomaly re-flagged the order mid-review) is rejected with
 *    `RECONCILIATION_FLAG_CHANGED`: the admin must reload and review the new
 *    anomaly, the resolve never clears it blind;
 *  - an **already-resolved** order (flag null + a recorded resolution) is an
 *    idempotent no-op success (`resolved:false`) — a redelivery / double click is
 *    not an error;
 *  - a **never-flagged** order is rejected with `NOT_IN_RECONCILIATION` — you
 *    cannot resolve what was never flagged.
 */
export async function resolveReconciliation(
	deps: ResolveReconciliationDeps,
	cmd: ResolveReconciliationCommand,
): Promise<ResolveReconciliationOutcome> {
	const reason = cmd.reason.trim();
	const resolvedBy = cmd.resolvedBy.trim();
	if (reason.length === 0) return { ok: false, reason: "EMPTY_REASON" };
	if (resolvedBy.length === 0) return { ok: false, reason: "EMPTY_RESOLVER" };

	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };

	if (order.reconciliationFlag === null) {
		// Already resolved (flag cleared, disposition on file) ⇒ benign no-op — a
		// replay/double-submit, not an error. Never flagged at all ⇒ nothing to
		// resolve, a legality error.
		if (order.reconciliationResolution !== null) {
			return { ok: true, resolved: false, order };
		}
		return { ok: false, reason: "NOT_IN_RECONCILIATION" };
	}

	// Stale review: the live flag is not the one the admin looked at.
	if (order.reconciliationFlag !== cmd.expectedFlag) {
		return { ok: false, reason: "RECONCILIATION_FLAG_CHANGED" };
	}

	const res = await deps.orderStore.resolveReconciliation({
		orderId: cmd.orderId,
		expectedFlag: cmd.expectedFlag,
		outcome: cmd.outcome,
		reason,
		resolvedBy,
		idempotencyKey: cmd.idempotencyKey,
	});
	if (res.resolved) return { ok: true, resolved: true, order: res.order ?? order };

	// The equality-guarded flip missed (0 rows) — someone changed the flag between
	// our read and the UPDATE. Disambiguate on the fresh row: cleared ⇒ a
	// concurrent resolve won (benign no-op); anything else (re-flagged, vanished)
	// ⇒ the stale-review conflict.
	const fresh = res.order;
	if (
		fresh !== null &&
		fresh.reconciliationFlag === null &&
		fresh.reconciliationResolution !== null
	) {
		return { ok: true, resolved: false, order: fresh };
	}
	return { ok: false, reason: "RECONCILIATION_FLAG_CHANGED" };
}
