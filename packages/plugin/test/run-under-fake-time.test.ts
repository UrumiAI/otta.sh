/**
 * The fake-time driver itself. Its elapsed count is what deadline cases pin
 * (`waited < DEADLINE + 1_000`), so it must count only time something WAITED on
 * a timer — not time burned while real (non-timer) work was still in progress.
 * On a slow runner that real work spans many loop turns; counting each as 100 ms
 * of fake time made main's `unit` job fail at 12600 ms for a 5000 ms deadline.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { runUnderFakeTime } from "./helpers/run-under-fake-time.js";

/** Real, timer-free work spanning `turns` macrotasks (a slow store, say). */
async function realWork(turns: number): Promise<void> {
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
	vi.useRealTimers();
});

describe("runUnderFakeTime", () => {
	test("slow real work before a deadline is armed does not count as waited time", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const work = (async () => {
			await realWork(200);
			await new Promise((resolve) => setTimeout(resolve, 5_000));
		})();

		const waited = await runUnderFakeTime(work);

		expect(waited).toBeGreaterThanOrEqual(5_000);
		expect(waited).toBeLessThan(6_000);
	});

	test("a promise with no timers at all settles with nothing waited", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		expect(await runUnderFakeTime(realWork(50))).toBe(0);
	});
});
