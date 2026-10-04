/**
 * The cron tick's budget: wall time AND storage queries, shared by the legs.
 *
 * WHY TWO DIMENSIONS. The host abandons the `cron` hook after its timeout (time),
 * and Cloudflare caps one Worker invocation at 50 D1 queries and 50 subrequests
 * on Workers Free (1000 / 10,000 on Paid) — a cap the scheduled event shares with
 * the host's own executor and scheduled-publishing pass. A tick that respects the
 * first and not the second fails on Free with "too many API requests", leg by
 * leg, which is the starvation this module exists to prevent wearing a different
 * error. So every storage, kv and egress call the tick makes is COUNTED (see
 * `countingContext`), and both dimensions gate every unit of work.
 *
 * WHY RESERVE-AWARE. A check that asks only "is there time left?" admits a unit
 * that starts with 1 ms to spare and then runs for 800. So a check admits the
 * next unit only if the SLOWEST unit seen so far in this loop still fits, with
 * the trailing RESERVE (the state and cursor writes after the legs) kept back.
 * The unit is measured between consecutive checks of one loop — a fresh `gate()`
 * per loop — so a leg's one-off list read is never mistaken for a unit and does
 * not starve the loop that follows it.
 *
 * WHY PER-LEG SHARES. A leg may use at most its share of the TOTAL budget —
 * or one unit of its own work, if that is more — clipped by what is left. A share is a cap, not a reservation — an idle leg
 * leaves its share to the legs after it — but it means a hung email provider, or a
 * hold backlog, can take its share of the tick and not the whole of it.
 */

export interface TickBudgetLimits {
	/** Wall-time budget for the legs, ms, measured from `startedAtMs`. */
	readonly ms: number;
	/** Storage/kv/egress calls the legs may make. */
	readonly queries: number;
	/** Time kept back for the writes after the legs. */
	readonly reserveMs: number;
	/** Calls kept back for the writes after the legs. */
	readonly reserveQueries: number;
}

/** A leg's cap, as fractions of the TOTAL budget. */
export interface LegShare {
	readonly time: number;
	readonly queries: number;
}

export const WHOLE_TICK: LegShare = { time: 1, queries: 1 };

export class TickBudget {
	readonly #clock: () => number;
	readonly #startedAtMs: number;
	#limits: TickBudgetLimits;
	#queries = 0;

	constructor(clock: () => number, startedAtMs: number, limits: TickBudgetLimits) {
		this.#clock = clock;
		this.#startedAtMs = startedAtMs;
		this.#limits = limits;
	}

	get limits(): TickBudgetLimits {
		return this.#limits;
	}

	/**
	 * Set the query limit once it is known. The tick reads its own query budget
	 * (an operational setting) THROUGH the counted context, so that read is
	 * charged against the provisional limit the tick starts with; legs are only
	 * created after this, so none of them sees the provisional figure.
	 */
	setQueryLimit(queries: number): void {
		this.#limits = { ...this.#limits, queries };
	}

	countQuery(): void {
		this.#queries++;
	}

	elapsedMs(): number {
		return this.#clock() - this.#startedAtMs;
	}

	queriesUsed(): number {
		return this.#queries;
	}

	/** A leg's view of the budget, capped at `share` of the total from here — but
	 *  never below `floorQueries` (one unit of the leg's own work), or a small
	 *  budget would refuse a costly leg on every tick. */
	leg(share: LegShare, floorQueries = 0): LegBudget {
		return new LegBudget(this, share, floorQueries);
	}
}

export class LegBudget {
	readonly #budget: TickBudget;
	readonly #endMs: number;
	readonly #endQueries: number;
	/** Set once any gate of this leg refused a unit: the leg stopped early. */
	stopped = false;

	constructor(budget: TickBudget, share: LegShare, floorQueries = 0) {
		this.#budget = budget;
		const { ms, queries } = budget.limits;
		this.#endMs = Math.min(ms, budget.elapsedMs() + share.time * ms);
		this.#endQueries = Math.min(
			queries,
			budget.queriesUsed() + Math.max(share.queries * queries, floorQueries),
		);
	}

	/**
	 * Whether the leg may START: room for its fixed entry reads (`entryQueries`, e.g.
	 * a candidate list that is bounded but not checked call by call) plus one unit
	 * of work, with the reserve kept back. A leg that could not finish even one unit
	 * is better deferred whole than started and stopped at once.
	 */
	canStart(entryQueries = 0, unitQueries = 1): boolean {
		return this.#fits(0, entryQueries + Math.max(1, unitQueries));
	}

	/** Time this leg may still spend, reserve kept back. Never negative. */
	remainingMs(): number {
		const t = this.#budget.elapsedMs();
		const { ms, reserveMs } = this.#budget.limits;
		return Math.max(0, Math.min(this.#endMs - t, ms - reserveMs - t));
	}

	/**
	 * A check for one loop: call it before each unit. It learns the loop's slowest
	 * unit (time and calls) from the gaps between its own calls, and admits the
	 * next unit only if one more of those still fits — or the given minimum, while
	 * no unit has been seen (the FIRST unit of a loop is otherwise free, and one
	 * hold flip is several calls). Bound, so it can be handed to a domain use-case
	 * as-is.
	 */
	gate(minUnitMs = 0, minUnitQueries = 1): () => boolean {
		let last: { ms: number; queries: number } | undefined;
		let unitMs = 0;
		let unitQueries = Math.max(1, minUnitQueries);
		return () => {
			const now = { ms: this.#budget.elapsedMs(), queries: this.#budget.queriesUsed() };
			if (last !== undefined) {
				unitMs = Math.max(unitMs, now.ms - last.ms);
				unitQueries = Math.max(unitQueries, now.queries - last.queries);
			}
			last = now;
			// Before a loop has timed a unit of its own, its time is estimated from its
			// CALL estimate at the tick's observed cost per call — a slow store makes a
			// fourteen-call hold flip slow, and admitting it on a zero estimate is how a
			// tick overran its budget.
			const perCallMs = now.queries > 0 ? now.ms / now.queries : 0;
			const ok = this.#fits(Math.max(unitMs, minUnitMs, unitQueries * perCallMs), unitQueries);
			if (!ok) this.stopped = true;
			return ok;
		};
	}

	#fits(unitMs: number, unitQueries: number): boolean {
		const t = this.#budget.elapsedMs();
		const q = this.#budget.queriesUsed();
		const { ms, queries, reserveMs, reserveQueries } = this.#budget.limits;
		return (
			t + unitMs < this.#endMs &&
			t + unitMs + reserveMs < ms &&
			q + unitQueries <= this.#endQueries &&
			q + unitQueries + reserveQueries <= queries
		);
	}
}
