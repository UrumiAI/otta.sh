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
 *
 * WHY A HARD CEILING AS WELL (QA2 M2). The checks above are cooperative: they admit
 * a unit on an ESTIMATE of its calls, and a leg whose unit is one call the tick cannot
 * see inside — a store method that loops — is not checked at all. QA caught exactly
 * that: one tick at 334 of 30 queries, a closed day's rollup heal absorbing every
 * live claim inside one `reconcile`. On Workers Free (50 per invocation) that tick
 * fails. So the counter itself REFUSES the call that would pass the budget
 * (`SweepQueryCeilingError`, thrown before the call is made): while the legs run the
 * ceiling is the budget less one call, kept for the cadence-state write after them,
 * and that write may use the last one. The legs' own checks keep their units under
 * it; the ceiling is the backstop that makes "never over the budget" true even when
 * an estimate is wrong, and the leg it stops is reported and logged by name.
 *
 * AND EVERY CALL IS ATTRIBUTED to the leg running when it was made (or to the tick's
 * own reads), so a summary and the log can say which leg spent what.
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

/** Calls the ceiling keeps back while the legs run: the cadence-state write. */
const CEILING_RESERVE = 1;

/**
 * The call that would have passed the tick's query budget, refused BEFORE it was
 * made. Not a storage failure: the work it interrupted is a guarded unit any later
 * tick completes. `leg` is the leg that was running, or null for the tick's own reads.
 */
export class SweepQueryCeilingError extends Error {
	override readonly name = "SweepQueryCeilingError";
	readonly ceiling: number;
	readonly leg: string | null;

	constructor(ceiling: number, leg: string | null) {
		super(
			`the sweep tick reached its ceiling of ${String(ceiling)} queries` +
				(leg === null ? "" : ` in ${leg}`) +
				"; the rest runs on the next tick",
		);
		this.ceiling = ceiling;
		this.leg = leg;
	}
}

/** Structural test for {@link SweepQueryCeilingError}: it may be re-thrown or
 *  wrapped by code that does not import this module. */
export function isSweepQueryCeilingError(err: unknown): err is SweepQueryCeilingError {
	return err instanceof Error && err.name === "SweepQueryCeilingError";
}

export class TickBudget {
	readonly #clock: () => number;
	readonly #startedAtMs: number;
	#limits: TickBudgetLimits;
	#queries = 0;
	#currentLeg: string | null = null;
	#legsDone = false;
	readonly #byLeg = new Map<string, number>();
	readonly #refused = new Set<string>();

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

	/**
	 * Count one storage/kv/egress call, attributed to the running leg — or REFUSE it
	 * (`SweepQueryCeilingError`, before the call is made) when it would pass the
	 * ceiling. See the head comment.
	 */
	countQuery(): void {
		const ceiling = this.ceiling();
		if (this.#queries >= ceiling) {
			// Remembered per leg, so a leg that SWALLOWED the refusal (a unit loop that
			// catches each unit's failure) is still known to have stopped short.
			if (this.#currentLeg !== null) this.#refused.add(this.#currentLeg);
			throw new SweepQueryCeilingError(ceiling, this.#currentLeg);
		}
		this.#queries++;
		if (this.#currentLeg !== null) {
			this.#byLeg.set(this.#currentLeg, (this.#byLeg.get(this.#currentLeg) ?? 0) + 1);
		}
	}

	/** The most calls the tick may have made so far: the budget, less the call kept
	 *  for the cadence-state write while the legs are still running. */
	ceiling(): number {
		return this.#limits.queries - (this.#legsDone ? 0 : CEILING_RESERVE);
	}

	/** The legs are done: the trailing write may use the last call. */
	finishLegs(): void {
		this.#legsDone = true;
		this.#currentLeg = null;
	}

	/** Run `body` with every call it makes attributed to `leg`. Legs run one at a
	 *  time, so one current leg is enough. */
	async charge<T>(leg: string, body: () => Promise<T>): Promise<T> {
		const previous = this.#currentLeg;
		this.#currentLeg = leg;
		try {
			return await body();
		} finally {
			this.#currentLeg = previous;
		}
	}

	/** Whether the ceiling refused a call made by `leg` this tick — whether or not
	 *  the leg let the error reach its runner. */
	wasRefused(leg: string): boolean {
		return this.#refused.has(leg);
	}

	/** Calls attributed to `leg` this tick. */
	queriesFor(leg: string): number {
		return this.#byLeg.get(leg) ?? 0;
	}

	/** Calls made outside any leg: the setting read, the cadence state. */
	overheadQueries(): number {
		let legs = 0;
		for (const n of this.#byLeg.values()) legs += n;
		return this.#queries - legs;
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

	/** Calls this leg may still make, reserve kept back. Never negative. */
	remainingQueries(): number {
		const q = this.#budget.queriesUsed();
		const { queries, reserveQueries } = this.#budget.limits;
		return Math.max(0, Math.min(this.#endQueries - q, queries - reserveQueries - q));
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
	gate(minUnitMs = 0, minUnitQueries = 1): (unitHint?: number) => boolean {
		let last: { ms: number; queries: number } | undefined;
		let unitMs = 0;
		let unitQueries = Math.max(1, minUnitQueries);
		// The most this leg could EVER be given: a unit estimated above it is clamped
		// to it, so an oversized unit (a ten-line order's completion) still runs when
		// the leg has its whole slice — and the ceiling, not a refusal on every tick
		// forever, is what stops it part-way. Its guarded writes persist, so the next
		// attempt starts further on.
		const cap = Math.max(1, this.remainingQueries());
		return (unitHint?: number) => {
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
			// A caller that can size THIS unit (an order's outstanding holds) says so.
			const thisUnit = Math.min(cap, Math.max(unitQueries, unitHint ?? 0));
			const ok = this.#fits(Math.max(unitMs, minUnitMs, thisUnit * perCallMs), thisUnit);
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
