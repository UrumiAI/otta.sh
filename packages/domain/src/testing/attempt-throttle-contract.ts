import { describe, expect, test } from "vitest";
import type { AttemptThrottle } from "../ports/attempt-throttle.js";

export interface AttemptThrottleHarness {
	throttle: AttemptThrottle;
	advance(ms: number): void;
	/** The window the harness built the throttle with. */
	windowMs: number;
	/** The per-key cap the harness built the throttle with. */
	maxAttempts: number;
}

export interface AttemptThrottleContractOptions {
	dialect: string;
}

/**
 * The `AttemptThrottle` behavioural spec: at most `maxAttempts` admitted per key
 * inside a sliding `windowMs`, keys independent, a lapsed attempt frees its slot.
 * The same per-key slot window the sign-in throttle enforces (ADR-0004), for
 * attempts that are not sign-ins — e.g. guessing the email behind an order link.
 */
export function attemptThrottleContract(
	makeHarness: () => Promise<AttemptThrottleHarness>,
	options: AttemptThrottleContractOptions,
): void {
	describe(`AttemptThrottle contract [${options.dialect}]`, () => {
		test("admits up to the cap for one key, then refuses", async () => {
			const h = await makeHarness();
			for (let i = 0; i < h.maxAttempts; i++) {
				expect(await h.throttle.admit("order:a"), `attempt ${i + 1}`).toBe(true);
			}
			expect(await h.throttle.admit("order:a")).toBe(false);
			expect(await h.throttle.admit("order:a")).toBe(false);
		});

		test("keys are independent", async () => {
			const h = await makeHarness();
			for (let i = 0; i < h.maxAttempts; i++) await h.throttle.admit("order:b");
			expect(await h.throttle.admit("order:b")).toBe(false);
			expect(await h.throttle.admit("order:c")).toBe(true);
		});

		test("a refusal takes no slot, and the window lapsing frees the key", async () => {
			const h = await makeHarness();
			for (let i = 0; i < h.maxAttempts; i++) await h.throttle.admit("order:d");
			expect(await h.throttle.admit("order:d")).toBe(false);
			h.advance(h.windowMs + 1);
			for (let i = 0; i < h.maxAttempts; i++) {
				expect(await h.throttle.admit("order:d"), `after window ${i + 1}`).toBe(true);
			}
			expect(await h.throttle.admit("order:d")).toBe(false);
		});
	});
}
