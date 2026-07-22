import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { OrderStore } from "../ports/order-store.js";
import type { Order, ReconciliationOutcome } from "./model.js";

export interface ResolveReconciliationDeps {
	orderStore: OrderStore;
}

export interface ResolveReconciliationCommand {
	orderId: OrderId;
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
	| "EMPTY_REASON"
	| "EMPTY_RESOLVER";

export type ResolveReconciliationOutcome =
	| { ok: true; resolved: boolean; order: Order }
	| { ok: false; reason: ResolveReconciliationFailure };

/**
 * Resolve an order's manual-reconciliation flag (admin-UX Increment 1). Pure
 * orchestration — no IO of its own: validate, confirm the order is actually in
 * the reconciliation-needed state, then delegate the guarded flag-clear to the
 * store.
 *
 * The reconciliation dimension is a **two-state machine orthogonal to the order
 * state machine**: `flagged (reconciliationFlag ≠ null) → resolved (flag null +
 * disposition recorded)`. This use-case only ever moves an order along THAT axis
 * — it NEVER touches `order.state`, line items, or totals (the snapshot
 * invariant). A real refund/cancel is the separate `transitionOrder` command; the
 * `outcome` here only RECORDS which disposition the admin took.
 *
 * Legality + idempotency, mirroring `transitionOrder`:
 *  - a **flagged** order resolves once — the store's guarded `WHERE
 *    reconciliation_flag IS NOT NULL` flip makes concurrent/replayed calls a
 *    0-row no-op (`resolved:false`), so exactly one disposition is ever written;
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

	const res = await deps.orderStore.resolveReconciliation({
		orderId: cmd.orderId,
		outcome: cmd.outcome,
		reason,
		resolvedBy,
		idempotencyKey: cmd.idempotencyKey,
	});
	return { ok: true, resolved: res.resolved, order: res.order ?? order };
}
