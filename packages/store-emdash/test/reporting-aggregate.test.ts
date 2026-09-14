/**
 * The aggregate guard, directly.
 *
 * When the reports were SQL, the precision risk was at the boundary: Postgres returns
 * `SUM(int)` as a bigint string, and coercing one above `Number.MAX_SAFE_INTEGER` would
 * round to a nearby representable integer that the money brand then happily accepted.
 * The guard lived in the adapter that parsed it, and a focused unit test asserted the
 * refusal because an actual sum past 2^53 would need millions of rows to reproduce end
 * to end.
 *
 * Folding day documents in JS moves the same risk inside the adapter — the addition is
 * now ours — so the guard moved with it and so did this test. Nothing else here can
 * catch it: every other suite works with realistic money, which is exactly the range in
 * which an unguarded sum looks right.
 */
import { expect, test } from "vitest";
import { addAggregate } from "../src/index.js";

test("adding two ordinary aggregate parts is exact", () => {
	expect(addAggregate(0, 0)).toBe(0);
	expect(addAggregate(1_000, 2_500)).toBe(3_500);
	expect(addAggregate(Number.MAX_SAFE_INTEGER - 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
});

test("a part that is not a safe integer is refused, never coerced", () => {
	expect(() => addAggregate(0, 1.5)).toThrow(RangeError);
	expect(() => addAggregate(0, Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
	expect(() => addAggregate(0, Number.NaN)).toThrow(RangeError);
	expect(() => addAggregate(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
});

test("a SUM that leaves the safe range is refused, even though both parts are safe", () => {
	// This is the case a bare `a + b` gets silently wrong: the result is a valid
	// `number`, it is even an integer, and it is not the sum.
	expect(() => addAggregate(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
	expect(() => addAggregate(Number.MAX_SAFE_INTEGER - 1, 10)).toThrow(RangeError);
});
