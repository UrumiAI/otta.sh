import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";

/** Deterministic IdGen for tests: `${prefix}-1`, `${prefix}-2`, … */
export class CountingIdGen implements IdGen {
	#prefix: string;
	#next = 1;

	constructor(prefix = "id") {
		this.#prefix = prefix;
	}

	newId(): string {
		return `${this.#prefix}-${this.#next++}`;
	}
}

/** Fixed, manually advanceable Clock for tests. */
export class FixedClock implements Clock {
	#now: Date;

	constructor(now: Date) {
		this.#now = now;
	}

	now(): Date {
		return new Date(this.#now.getTime());
	}

	advance(ms: number): void {
		this.#now = new Date(this.#now.getTime() + ms);
	}
}
