/**
 * The ONE deadline a settle request runs under — `webhooks/stripe/settle`. (The
 * x402 page-gate route that shared it, `entitlements/x402/settle`, was retired
 * by ADR-0028 increment 2.)
 *
 * WHY ONE, AND WHY FROM THE REQUEST'S START. Stripe treats a webhook delivery as
 * failed after ~10 s and sends it again. After verifying, a settle can do two slow
 * things: a late payment's automatic refund (a pre-flight read and a create, each a
 * Stripe call — ADR-0022's late-payment amendment), and the inline order-email
 * attempt (ADR-0005's 2026-10-02 amendment). Each had its own bound, but bounds that
 * each fit do not add up to one that does: two 3 s refund calls plus a 5 s email
 * wait is already past 10 s. So the handler fixes one deadline as it starts, and
 * every slow step after that draws on it. The settle's own storage work, whose
 * compare-and-set retries have no fixed bound, is charged against the same clock
 * simply by running first.
 *
 * TWO RULES, BY WHAT A TIMEOUT MEANS:
 *  - a call whose timeout is RECOVERABLE — the refund pre-flight read (it issued
 *    nothing: retryable) and an inline email send (released uncounted) — takes
 *    `min(its own ceiling, what is left)` as it starts (`boundedBy`), never below
 *    1 ms — never 0, which some runtimes read as "no timeout";
 *  - the refund CREATE is "full bound or not started" (`boundedRefundStripeOptions`,
 *    shared with the sweep). A timed-out create is AMBIGUOUS — it may have reached
 *    Stripe — and would flag the order "verify in Stripe"; so it starts only while
 *    its whole bound plus the writes after it still fit, and otherwise answers
 *    not-started, leaving the refund reserved, uncounted, for the redelivery.
 *
 * Worst case on the Stripe route: storage, a read of at most 3 s, a 3 s create only
 * if it fits, then the inline email from whatever is left — inside 8 s.
 */

/** The whole request's budget, from its start: comfortably under Stripe's ~10 s,
 *  leaving room for the host's own response path. */
export const SETTLE_REQUEST_BUDGET_MS = 8_000;

export interface SettleDeadline {
	/** The wall clock the deadline is measured on (`Date.now` in a deploy). */
	readonly now: () => number;
	/** The deadline, in {@link now}'s milliseconds. */
	readonly at: number;
	/** Milliseconds left; zero or negative once the budget is spent. */
	remainingMs(): number;
	/** A per-call timeout function — asked when each call STARTS — of
	 *  `min(ceilingMs, remaining)`, never below 1 ms. */
	boundedBy(ceilingMs: number): () => number;
}

/** Fix the deadline now. A route calls this first thing, before any other work. */
export function settleDeadline(now: () => number = Date.now): SettleDeadline {
	const at = now() + SETTLE_REQUEST_BUDGET_MS;
	const remainingMs = (): number => at - now();
	return {
		now,
		at,
		remainingMs,
		boundedBy: (ceilingMs) => () => Math.max(1, Math.min(ceilingMs, remainingMs())),
	};
}
