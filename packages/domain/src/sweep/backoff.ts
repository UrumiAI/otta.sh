/**
 * A per-unit back-off for bounded sweeps (review round 3, B I4).
 *
 * WHY. A bounded sweep lists its candidates oldest first and attempts at most
 * `limit` of them. A unit whose step throws every time stays a candidate, so it
 * stays at the head of the list; `limit` such units use up every call's bite and
 * the units behind them are never reached. Catching per unit (so one throw does
 * not end the call) is not enough on its own.
 *
 * WHAT. A unit that failed waits before it is attempted again: one `baseMs` after
 * its first failure, doubling per further failure up to `maxMs`. A success
 * forgets it. The sweep reads past the waiting units (it lists that many more
 * candidates and leaves them out), so the bite goes to units that can progress.
 *
 * Held in memory by the caller, and bounded (`maxEntries`): losing it (a restart,
 * a fresh isolate) only means a failing unit is tried once more sooner, which is
 * what happened without it. Pure: the caller passes the time.
 *
 * THE BOUND (review round 3 polish, P-3). It holds back starvation, it does not end
 * it. With F units failing on EVERY attempt ahead of a good one, a sweep with a bite
 * of `limit` per call still reaches the good unit while F is below BOTH:
 *  - the cap (`maxEntries`): past it, each new failure evicts a waiting unit, which
 *    is retried at once, so failing units take the bite again. A sweep should size
 *    the cap to what its one list call can read past (`setMaxEntries`);
 *  - about `maxMs / interval × limit` (60 × `limit` at one call a minute and the
 *    one-hour longest wait): each failing unit is still retried once per `maxMs`,
 *    and past that many the retries alone fill every bite.
 * Measured on the domain harness, cap sized to a 100-row look: bite 1 reaches the
 * good order behind 59 failing ones (in about six hours), not behind 60; bite 18
 * behind 89, not behind 90 (the condition above is sufficient, not tight). Past the
 * bound the rest starve, which before the back-off happened as soon as `limit`
 * units failed.
 */
export interface UnitBackoffOptions {
	/** Wait after the first failure. Default {@link UnitBackoff.DEFAULT_BASE_MS}. */
	readonly baseMs?: number;
	/** Longest wait. Default {@link UnitBackoff.DEFAULT_MAX_MS}. */
	readonly maxMs?: number;
	/** Most units remembered; past it, the one due soonest is dropped. Default 32.
	 *  See THE BOUND above, and `setMaxEntries`. */
	readonly maxEntries?: number;
}

interface Entry {
	failures: number;
	retryAt: number;
}

export class UnitBackoff {
	/** Five minutes: longer than a cron tick (one a minute), so the next ticks
	 *  read past a failed unit instead of retrying it at once. */
	static readonly DEFAULT_BASE_MS = 300_000;
	/** One hour. */
	static readonly DEFAULT_MAX_MS = 3_600_000;
	static readonly DEFAULT_MAX_ENTRIES = 32;

	readonly #baseMs: number;
	readonly #maxMs: number;
	#maxEntries: number;
	readonly #entries = new Map<string, Entry>();

	constructor(options: UnitBackoffOptions = {}) {
		this.#baseMs = options.baseMs ?? UnitBackoff.DEFAULT_BASE_MS;
		this.#maxMs = options.maxMs ?? UnitBackoff.DEFAULT_MAX_MS;
		this.#maxEntries = options.maxEntries ?? UnitBackoff.DEFAULT_MAX_ENTRIES;
		if (!(this.#baseMs > 0) || !(this.#maxMs >= this.#baseMs)) {
			throw new RangeError("UnitBackoff needs 0 < baseMs <= maxMs");
		}
		if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) {
			throw new RangeError("UnitBackoff maxEntries must be a positive integer");
		}
	}

	/** Units remembered (waiting or not). */
	get size(): number {
		return this.#entries.size;
	}

	/** The units still waiting at `nowMs`: leave them out of this call. */
	waiting(nowMs: number): ReadonlySet<string> {
		const ids = new Set<string>();
		for (const [id, entry] of this.#entries) if (entry.retryAt > nowMs) ids.add(id);
		return ids;
	}

	/** Most units remembered. */
	get maxEntries(): number {
		return this.#maxEntries;
	}

	/**
	 * Remember at most `maxEntries` units from now on, dropping the ones due soonest
	 * if more are held. A sweep sizes this to the candidates its one list call can
	 * read past (review round 3 polish, P-3): the cap is where starvation returns, so
	 * it should be as large as the list can afford, and no larger.
	 */
	setMaxEntries(maxEntries: number): void {
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new RangeError("UnitBackoff maxEntries must be a positive integer");
		}
		this.#maxEntries = maxEntries;
		this.#evict();
	}

	/** `id`'s step threw at `nowMs`. */
	failed(id: string, nowMs: number): void {
		const failures = (this.#entries.get(id)?.failures ?? 0) + 1;
		const wait = Math.min(this.#baseMs * 2 ** Math.min(failures - 1, 30), this.#maxMs);
		this.#entries.delete(id);
		this.#entries.set(id, { failures, retryAt: nowMs + wait });
		this.#evict();
	}

	/** Drop the units due soonest until at most `maxEntries` are held. */
	#evict(): void {
		while (this.#entries.size > this.#maxEntries) {
			let soonest: string | undefined;
			let soonestAt = Infinity;
			for (const [key, entry] of this.#entries) {
				if (entry.retryAt < soonestAt) {
					soonest = key;
					soonestAt = entry.retryAt;
				}
			}
			if (soonest === undefined) break;
			this.#entries.delete(soonest);
		}
	}

	/** `id`'s step completed (or found nothing to do): forget it. */
	succeeded(id: string): void {
		this.#entries.delete(id);
	}
}
