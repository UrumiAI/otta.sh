/**
 * The ONE deadline a settle request runs under (`settle-deadline.ts`): fixed at the
 * request's start, and shared by every slow thing the request does after verifying —
 * a late payment's Stripe refund calls and the inline order-email drain — so their
 * sum, not each alone, stays under Stripe's ~10 s webhook delivery timeout.
 */
import { describe, expect, test } from "vitest";
import { SETTLE_REQUEST_BUDGET_MS, settleDeadline } from "../src/settle-deadline.js";

describe("settleDeadline", () => {
	test("the budget sits under Stripe's ~10 s delivery timeout", () => {
		expect(SETTLE_REQUEST_BUDGET_MS).toBeLessThan(10_000);
	});

	test("fixed at creation; remaining shrinks as time passes and goes negative past it", () => {
		let clock = 1_000;
		const d = settleDeadline(() => clock);
		expect(d.at).toBe(1_000 + SETTLE_REQUEST_BUDGET_MS);
		clock += 3_000;
		expect(d.remainingMs()).toBe(SETTLE_REQUEST_BUDGET_MS - 3_000);
		clock += SETTLE_REQUEST_BUDGET_MS;
		expect(d.remainingMs()).toBeLessThan(0);
	});

	test("boundedBy(ceiling) is a per-call timeout: the ceiling, or what is left, never below 1 ms", () => {
		let clock = 0;
		const timeout = settleDeadline(() => clock).boundedBy(3_000);
		expect(timeout()).toBe(3_000);
		clock = SETTLE_REQUEST_BUDGET_MS - 1_200;
		expect(timeout()).toBe(1_200);
		clock = SETTLE_REQUEST_BUDGET_MS + 5_000;
		expect(timeout()).toBe(1);
	});
});
