/**
 * Drive a promise to completion under FAKE `setTimeout` (`vi.useFakeTimers({ toFake:
 * ["setTimeout", "clearTimeout"] })`), for a case whose subject is a deadline: a
 * hung sender that would otherwise hold the suite for seconds.
 *
 * Time advances in `stepMs` steps, with a REAL macrotask yielded between steps so the
 * store work the promise is doing (real SQLite, not timer-driven) interleaves rather
 * than racing a single big jump. Returns the fake milliseconds that had elapsed when
 * the promise settled, so a case can pin WHEN its deadline fired, not only that it did.
 */
import { vi } from "vitest";

export async function runUnderFakeTime(
	p: Promise<unknown>,
	options: { stepMs?: number; limitMs?: number } = {},
): Promise<number> {
	const stepMs = options.stepMs ?? 100;
	const limitMs = options.limitMs ?? 20_000;
	// An object, not a `let`: the flag is flipped by the promise's callbacks, which a
	// loop-condition lint cannot see.
	const state = { done: false };
	void p.then(
		() => (state.done = true),
		() => (state.done = true),
	);
	let elapsed = 0;
	while (!state.done && elapsed < limitMs) {
		await new Promise((resolve) => setImmediate(resolve));
		if (state.done) break;
		await vi.advanceTimersByTimeAsync(stepMs);
		elapsed += stepMs;
	}
	await p;
	return elapsed;
}
