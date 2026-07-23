import type { OrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";

/** An anomaly the settle path must surface loudly (§5/§9). */
export type PaymentAnomalyKind =
	| "AMOUNT_MISMATCH"
	| "COMMIT_LOST"
	| "SETTLE_ON_NON_PENDING"
	/** A verified, amount-checked success LOST the guarded `pending→paid` flip to
	 *  a mid-flight expiry/failure: money captured, stock already released. The
	 *  mid-flight loser must be exactly as loud as the already-terminal-at-load
	 *  case — never a silent no-op. */
	| "PAID_FLIP_LOST"
	/** A gateway refund ISSUED but its reserved ledger row could not be finalized
	 *  (ADR-0008 — impossible by construction under reserve-before-issue, kept as
	 *  the loud residual guard): money left the provider with no finalized ledger
	 *  row. Recorded with the provider refundRef in the detail — NEVER silently
	 *  dropped — and the order is flagged for manual reconciliation. */
	| "REFUND_UNRECORDED";

/**
 * The `PaymentEventStore` port (Phase 4 §5). Two jobs:
 *  1. **Dedupe** — a UNIQUE `dedupe_key` (Stripe event id / x402 receipt id):
 *     `dedupe` returns `true` only for the FIRST delivery; a duplicate returns
 *     `false`. The row is the received-events audit trail. NOTE: settlement does
 *     NOT short-circuit on a duplicate — a redelivery RE-DRIVES the idempotent,
 *     state-guarded settle steps so a crash between any two of them is healed by
 *     the next gateway retry (the Phase-3 claim/resume idiom); "settles once" is
 *     enforced by the guarded state flips + keyed side-effects, with the dedupe
 *     row as the audit record.
 *  2. **Anomaly** — record a durable, alert-worthy row when settlement hits an
 *     invariant violation (amount/currency mismatch, a lost adopted hold). The
 *     record IS the alert seam; never swallowed (§5 loud-anomaly).
 */
export interface PaymentEventStore {
	/** Claim `dedupeKey` (INSERT … ON CONFLICT DO NOTHING). True ⇒ first delivery. */
	dedupe(
		dedupeKey: string,
		orderId: OrderId,
		gateway: PaymentMethod,
		now: string,
	): Promise<boolean>;
	/** Record an anomaly row (§5). Idempotent enough for replay safety. */
	recordAnomaly(input: RecordAnomalyInput): Promise<void>;
}

export interface RecordAnomalyInput {
	orderId: OrderId;
	gateway: PaymentMethod;
	kind: PaymentAnomalyKind;
	detail: string;
	now: string;
}
