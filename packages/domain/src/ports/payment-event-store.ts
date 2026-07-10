import type { OrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";

/** An anomaly the settle path must surface loudly (§5/§9). */
export type PaymentAnomalyKind = "AMOUNT_MISMATCH" | "COMMIT_LOST" | "SETTLE_ON_NON_PENDING";

/**
 * The `PaymentEventStore` port (Phase 4 §5). Two jobs:
 *  1. **Dedupe** — a UNIQUE `dedupe_key` (Stripe event id / x402 receipt id)
 *     makes webhook redelivery / double page-gate a no-op. `dedupe` returns
 *     `true` only for the FIRST delivery; a duplicate returns `false`.
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
