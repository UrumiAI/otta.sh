import { describe, expect, test } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { idempotencyKey, productId, reservationId, sku } from "../src/money/ids.js";

describe("cents()", () => {
	test("cents() rejects non-integer input", () => {
		const nonInteger: number = 4.99;
		expect(() => cents(nonInteger)).toThrow(/integer/i);
	});

	test("cents() rejects negative input", () => {
		const negative: number = -1;
		expect(() => cents(negative)).toThrow(/negative|>= 0|non-negative/i);
	});

	test("cents() rejects NaN and Infinity", () => {
		expect(() => cents(Number.NaN)).toThrow();
		expect(() => cents(Number.POSITIVE_INFINITY)).toThrow();
	});

	test("cents() mints zero and positive integers unchanged", () => {
		expect(cents(0)).toBe(0);
		expect(cents(500)).toBe(500);
	});
});

describe("currency()", () => {
	test("accepts ISO-4217-shaped codes and rejects anything else", () => {
		expect(currency("USD")).toBe("USD");
		expect(() => currency("usd")).toThrow();
		expect(() => currency("US")).toThrow();
		expect(() => currency("")).toThrow();
	});
});

describe("money()", () => {
	test("carries amount and explicit currency", () => {
		const m = money(cents(1250), currency("EUR"));
		expect(m).toEqual({ amount: 1250, currency: "EUR" });
	});
});

describe("branded ids", () => {
	test("constructors reject empty strings", () => {
		expect(() => sku("")).toThrow();
		expect(() => productId("")).toThrow();
		expect(() => idempotencyKey("")).toThrow();
		expect(() => reservationId("")).toThrow();
	});

	test("constructors mint the given string unchanged", () => {
		expect(sku("SKU-1")).toBe("SKU-1");
		expect(productId("prod-1")).toBe("prod-1");
		expect(idempotencyKey("key-1")).toBe("key-1");
		expect(reservationId("res-1")).toBe("res-1");
	});
});
