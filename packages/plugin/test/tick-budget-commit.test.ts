/**
 * The commit window against the configured budget (review of QA3 N2). A provider
 * call's record runs inside a window the ceiling does not refuse; above the Workers
 * Free preset that window is kept OUT of the ceiling the units see, so even a
 * record that runs the whole window lands inside the budget. On the Free preset the
 * window is not reserved (it would cost a quarter of the Free expiry pace) and a
 * tick may pass its 30 by at most the window — inside the 20 the preset leaves the
 * host under Workers Free's 50.
 */
import { describe, expect, test } from "vitest";
import {
	COMMIT_WINDOW_EXEMPT_BUDGET,
	MAX_COMMIT_WINDOW,
	TickBudget,
} from "../src/cron/tick-budget.js";

/** Count calls until the ceiling refuses one; then open the largest window and
 *  spend all of it; then finish the legs and make the state write. */
function worstCase(queries: number): number {
	const budget = new TickBudget(() => 0, 0, {
		ms: 9_500,
		queries,
		reserveMs: 250,
		reserveQueries: 2,
	});
	for (;;) {
		try {
			budget.countQuery();
		} catch {
			break;
		}
	}
	budget.allowCommit(MAX_COMMIT_WINDOW);
	for (let i = 0; i < MAX_COMMIT_WINDOW; i++) budget.countQuery();
	budget.endCommit();
	budget.finishLegs();
	budget.countQuery(); // the cadence-state write
	return budget.queriesUsed();
}

describe("a tick's worst case against its configured budget", () => {
	test.each([31, 40, 600, 900])(
		"budget %i: never more than the budget, record included",
		(queries) => {
			expect(worstCase(queries)).toBeLessThanOrEqual(queries);
		},
	);

	test("the Workers Free preset: at most the window past it", () => {
		expect(COMMIT_WINDOW_EXEMPT_BUDGET).toBe(30);
		expect(worstCase(30)).toBeLessThanOrEqual(30 + MAX_COMMIT_WINDOW);
		expect(30 + MAX_COMMIT_WINDOW).toBeLessThanOrEqual(50 - 16);
	});
});
