import type { Clock } from "@otta-sh/domain";

/**
 * A clock that ADVANCES a millisecond per reading — the clock every
 * compare-and-set race needs, and the reason it is shared rather than copied.
 *
 * A `FixedClock` makes `updated_at` identical on every write, which silently
 * turns a compare-and-set into a guard that always passes: a same-row race would
 * then "pass" while proving nothing, because the CAS it depends on was never
 * exercised. Real writers read a moving clock, so the race suites do too.
 *
 * Deliberately NOT `FixedClock.advance`-based: the point is that no test has to
 * remember to advance it. Every `now()` is a new instant, exactly as a wall clock
 * would be, so a sequence of writes inside one case produces the distinct
 * watermarks a CAS needs without any bookkeeping in the case itself.
 */
export class TickingClock implements Clock {
	#at: number;

	constructor(start: string) {
		this.#at = new Date(start).getTime();
	}

	now(): Date {
		this.#at += 1;
		return new Date(this.#at);
	}
}
