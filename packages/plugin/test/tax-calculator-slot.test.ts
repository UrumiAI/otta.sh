import type { TaxCalculator } from "@urumi.ai/otta-domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const calc = (id: string): TaxCalculator => ({
	id,
	calculate: () => {
		throw new Error("not called");
	},
});

describe("setTaxCalculator", () => {
	let warn: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		vi.resetModules();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => warn.mockRestore());

	test("the first registration is silent", async () => {
		const { setTaxCalculator } = await import("../src/commerce/tax-calculator-slot.js");
		setTaxCalculator(calc("acme.tax"));
		expect(warn).not.toHaveBeenCalled();
	});

	test("replacing a registered calculator of the same id warns, naming the id, and replaces it", async () => {
		const { setTaxCalculator, getTaxCalculator } =
			await import("../src/commerce/tax-calculator-slot.js");
		setTaxCalculator(calc("acme.tax"));
		const second = calc("acme.tax");
		setTaxCalculator(second);
		expect(getTaxCalculator()).toBe(second);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("acme.tax");
	});

	test("re-registering the very same object is not a replacement", async () => {
		const { setTaxCalculator } = await import("../src/commerce/tax-calculator-slot.js");
		const c = calc("acme.tax");
		setTaxCalculator(c);
		setTaxCalculator(c);
		expect(warn).not.toHaveBeenCalled();
	});

	test("repeated hot-reload replacements warn once per process (#463), yet each one still replaces", async () => {
		const { setTaxCalculator, getTaxCalculator } =
			await import("../src/commerce/tax-calculator-slot.js");
		setTaxCalculator(calc("acme.tax"));
		const last = calc("acme.tax");
		setTaxCalculator(calc("acme.tax"));
		setTaxCalculator(calc("acme.tax"));
		setTaxCalculator(last);
		expect(getTaxCalculator()).toBe(last);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
