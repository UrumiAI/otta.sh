/**
 * Bounded sweeps: the shape a scheduled sweep use-case takes when its caller runs
 * it inside a time box.
 *
 * WHY THIS EXISTS. The plugin's cron tick runs every sweep inside one host hook
 * that the host abandons after a fixed timeout. A use-case that walks its whole
 * backlog in one call can therefore spend the entire tick on one leg — and in the
 * field it did: two slow expiry legs used up the hook's five seconds and every leg
 * after them (the outbox among them) never ran. So a sweep use-case takes a
 * `limit` and a `shouldContinue`, and says whether it `drained` its backlog.
 *
 * STOPPING EARLY IS SAFE BY CONSTRUCTION, which is what makes this a bite and not
 * a truncation: every unit of sweep work is a guarded, idempotent write, so the
 * units a call did not reach are simply still outstanding for the next call.
 *
 * Pure: `shouldContinue` is the caller's clock, injected as a predicate, so the
 * domain never reads time or IO to decide when to stop.
 */
export interface SweepBatchOptions {
	/** Most units ATTEMPTED in this call (a lost guarded flip still counts — it
	 *  still cost the round-trips). Default: unbounded. Bounds the LIST as well as
	 *  the flips: the store is asked for `limit + 1` candidates, the extra one
	 *  being what tells "drained exactly at the limit" from "more left". A
	 *  positive integer; anything else is refused with a `RangeError`. */
	readonly limit?: number;
	/** Asked before each unit; `false` stops the call before that unit begins. */
	readonly shouldContinue?: () => boolean;
	/** Passed to the store's candidate LIST as its `shouldContinue` (see
	 *  `ExpiryListOptions`): the list's own cost, bounded by the caller. */
	readonly shouldContinueListing?: () => boolean;
	/**
	 * An error that ends the whole call rather than failing one unit — the cron
	 * tick's query ceiling (`SweepQueryCeilingError`): a sweep that catches per unit
	 * rethrows it, so the leg reports the ceiling instead of logging each refused
	 * unit as a failure (review round 3, A I2). Default: none.
	 */
	readonly stopsBatch?: (err: unknown) => boolean;
}

export interface SweepBatchResult {
	/** Units actually completed (guarded flips won). */
	readonly count: number;
	/** `true` when every unit found this call was attempted — `false` means a
	 *  limit or a stop left work for the next call. */
	readonly drained: boolean;
}

/**
 * Refuse a limit that is not a positive integer. Thrown rather than clamped: a
 * zero or NaN limit is a caller bug, and quietly treating it as "unbounded" or
 * "nothing" would either read a whole backlog inside a time-boxed hook or make a
 * sweep silently do no work forever. Shared with the store adapters, which apply
 * the same rule to the list limit.
 */
export function assertSweepLimit(limit: number | undefined): void {
	if (limit === undefined) return;
	if (!Number.isInteger(limit) || limit < 1) {
		throw new RangeError(`sweep limit must be a positive integer, got ${String(limit)}`);
	}
}

/** The list options a bounded sweep passes its store: one more than its limit
 *  (plus `readPast` candidates it will leave out, such as units backing off), and
 *  the caller's listing stop check. */
export function listLimitFor(
	options: SweepBatchOptions,
	readPast = 0,
): { limit?: number; shouldContinue?: () => boolean } | undefined {
	assertSweepLimit(options.limit);
	if (options.limit === undefined && options.shouldContinueListing === undefined) return undefined;
	return {
		...(options.limit === undefined ? {} : { limit: options.limit + 1 + readPast }),
		...(options.shouldContinueListing === undefined
			? {}
			: { shouldContinue: options.shouldContinueListing }),
	};
}

/** Whether a sweep loop may begin unit `attempted` (zero-based). */
export function mayContinue(options: SweepBatchOptions, attempted: number): boolean {
	if (options.limit !== undefined && attempted >= options.limit) return false;
	return options.shouldContinue === undefined || options.shouldContinue();
}
