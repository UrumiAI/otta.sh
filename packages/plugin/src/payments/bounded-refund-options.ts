/**
 * The Stripe gateway options for a refund made INSIDE someone else's deadline —
 * the cron sweep's `late-refunds` leg (its leg budget) and the settle webhook
 * (`settle-deadline.ts`, the request's one deadline). One helper, so the two
 * callers cannot disagree about the rule that matters:
 *
 *  - the pre-flight READ takes `min(createMs, what is left)` as it starts: a
 *    timed-out read issued nothing and is retryable, so clipping it is safe;
 *  - the CREATE gets the full fixed `createMs`, or is NOT STARTED. A create that
 *    times out is AMBIGUOUS — it may have reached Stripe — and lands as
 *    GATEWAY_UNVERIFIED ("verify in Stripe"), which blocks the automatic retry. So
 *    it is never handed a sliver: it starts only while a whole create plus the
 *    storage writes after it (`storageMs`) still fit. Otherwise the gateway answers
 *    NOT_STARTED having issued nothing, the refund stays `reserved`, and the domain
 *    reschedules it without counting an attempt (payments-stripe's
 *    `refundCreateTimeoutMs` / `beforeRefundCreate`).
 */
export interface RefundTimeBudget {
	/** Milliseconds left; zero or negative once spent. */
	remainingMs(): number;
}

export interface BoundedRefundStripeOptions {
	requestTimeoutMs: () => number;
	refundCreateTimeoutMs: number;
	beforeRefundCreate: () => boolean;
}

export function boundedRefundStripeOptions(
	budget: RefundTimeBudget,
	bounds: { createMs: number; storageMs: number },
): BoundedRefundStripeOptions {
	return {
		requestTimeoutMs: () => Math.max(1, Math.min(bounds.createMs, budget.remainingMs())),
		refundCreateTimeoutMs: bounds.createMs,
		beforeRefundCreate: () => budget.remainingMs() >= bounds.createMs + bounds.storageMs,
	};
}
