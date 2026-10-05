import type { AttemptThrottle } from "../ports/attempt-throttle.js";
import type { Clock } from "../ports/clock.js";

/** IO-free `AttemptThrottle` fake: a list of attempt instants per key. */
export class InMemoryAttemptThrottle implements AttemptThrottle {
	readonly #clock: Clock;
	readonly #windowMs: number;
	readonly #maxAttempts: number;
	readonly #attempts = new Map<string, number[]>();

	constructor(options: { clock: Clock; windowMs: number; maxAttempts: number }) {
		this.#clock = options.clock;
		this.#windowMs = options.windowMs;
		this.#maxAttempts = options.maxAttempts;
	}

	async admit(key: string): Promise<boolean> {
		const now = this.#clock.now().getTime();
		const live = (this.#attempts.get(key) ?? []).filter((at) => at + this.#windowMs > now);
		if (live.length >= this.#maxAttempts) {
			this.#attempts.set(key, live);
			return false;
		}
		this.#attempts.set(key, [...live, now]);
		return true;
	}
}
