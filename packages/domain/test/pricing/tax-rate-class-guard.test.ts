import { describe, expect, test } from "vitest";
import {
	isTaxRateClassNotDeclaredError,
	TaxRateClassNotDeclaredError,
} from "../../src/pricing/tax-rate-class-guard.js";

describe("isTaxRateClassNotDeclaredError (#742)", () => {
	test("accepts the error, and its structural shape as it crosses a bridge", () => {
		const err = new TaxRateClassNotDeclaredError("ghost");
		expect(err).toMatchObject({ code: "TAX_RATE_CLASS_NOT_DECLARED", taxClassId: "ghost" });
		expect(isTaxRateClassNotDeclaredError(err)).toBe(true);
		expect(
			isTaxRateClassNotDeclaredError({ code: "TAX_RATE_CLASS_NOT_DECLARED", taxClassId: "x" }),
		).toBe(true);
	});

	test("refuses an object that only claims the code, or carries another one", () => {
		expect(isTaxRateClassNotDeclaredError({ code: "TAX_RATE_CLASS_NOT_DECLARED" })).toBe(false);
		expect(
			isTaxRateClassNotDeclaredError({ code: "TAX_RATE_CLASS_NOT_DECLARED", taxClassId: 7 }),
		).toBe(false);
		expect(isTaxRateClassNotDeclaredError({ code: "TAX_RATE_DUPLICATE", taxClassId: "x" })).toBe(
			false,
		);
		expect(isTaxRateClassNotDeclaredError(null)).toBe(false);
		expect(isTaxRateClassNotDeclaredError(new Error("nope"))).toBe(false);
	});
});
