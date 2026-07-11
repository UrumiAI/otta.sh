import { describe, expect, test } from "vitest";
import { parseAggregate } from "../src/kysely-reporting-store.js";

// Review round J4: the pg SUM/COUNT bigint→Number defense. An actual >2^53 sum
// would need millions of rows to reproduce end-to-end, so the guard is unit-
// tested directly at the coercion boundary.
describe("parseAggregate (pg bigint-string → safe integer)", () => {
	test("passes through a bigint string within the safe-integer range", () => {
		expect(parseAggregate("1000")).toBe(1000);
		expect(parseAggregate(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
	});

	test("THROWS on a bigint string above Number.MAX_SAFE_INTEGER instead of silently rounding", () => {
		// 2^53 + 1 — the classic value Number() would round down to 2^53.
		expect(() => parseAggregate("9007199254740993")).toThrow(RangeError);
	});

	test("passes through a safe-integer number (sqlite path)", () => {
		expect(parseAggregate(42)).toBe(42);
	});

	test("THROWS on a non-safe-integer number (sqlite dynamic-typing float footgun)", () => {
		expect(() => parseAggregate(1.5)).toThrow(RangeError);
		expect(() => parseAggregate(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
	});
});
