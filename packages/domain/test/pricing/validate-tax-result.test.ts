import { describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import type { TaxRequest } from "../../src/pricing/tax-calculator.js";
import { validateTaxResult } from "../../src/pricing/validate-tax-result.js";

/**
 * An outside calculator's answer is untrusted input. Anything but an exact,
 * well-formed answer to THIS request is refused (null ⇒ TAX_UNAVAILABLE).
 */
const req: TaxRequest = {
	purpose: "quote",
	currency: currency("USD"),
	pricesIncludeTax: false,
	lines: [
		{
			lineId: "0",
			quantity: 1,
			unitPriceCents: cents(1000),
			amountCents: cents(1000),
			taxClassId: "standard",
			taxStatus: "taxable",
				requiresShipping: true,
		},
		{
			lineId: "1",
			quantity: 1,
			unitPriceCents: cents(500),
			amountCents: cents(500),
			taxClassId: "standard",
			taxStatus: "taxable",
				requiresShipping: true,
		},
	],
	shipping: { amountCents: cents(300), methodId: "m" },
	origin: null,
	destination: { country: "US", region: "NY", postalCode: "10001", city: "New York" },
	zoneId: "z",
};

const line = (lineId: string, over: Record<string, unknown> = {}) => ({
	lineId,
	rateBps: 888,
	label: "NY sales tax",
	taxCents: 89,
	...over,
});
const good = () => ({
	ok: true,
	currency: "USD",
	lines: [line("0"), line("1", { taxCents: 44 })],
	shipping: { rateBps: 888, label: "NY sales tax", taxCents: 27 },
});

describe("validateTaxResult", () => {
	test("a good answer is copied out in REQUEST order, whitelisted fields only", () => {
		const raw = {
			...good(),
			lines: [line("1", { taxCents: 44, extra: "blob" }), line("0")],
			providerBlob: { secret: true },
		};
		expect(validateTaxResult(req, raw)).toEqual({
			ok: true,
			currency: "USD",
			lines: [line("0"), line("1", { taxCents: 44 })],
			shipping: { rateBps: 888, label: "NY sales tax", taxCents: 27 },
		});
	});

	test("shipping may be null when shipping was requested (untaxed shipping)", () => {
		expect(validateTaxResult(req, { ...good(), shipping: null })?.shipping).toBeNull();
	});

	const withLine0 = (over: Record<string, unknown>) => ({
		...good(),
		lines: [line("0", over), line("1")],
	});
	test.each<[string, unknown]>([
		["null", null],
		["a string", "ok"],
		["ok: false", { ...good(), ok: false }],
		["ok: 'true'", { ...good(), ok: "true" }],
		["wrong currency", { ...good(), currency: "EUR" }],
		["lines not an array", { ...good(), lines: { 0: line("0") } }],
		["a missing line", { ...good(), lines: [line("0")] }],
		["an extra line", { ...good(), lines: [line("0"), line("1"), line("2")] }],
		["a duplicated lineId", { ...good(), lines: [line("0"), line("0")] }],
		["an unknown lineId", { ...good(), lines: [line("0"), line("9")] }],
		["a __proto__ lineId", { ...good(), lines: [line("0"), line("__proto__")] }],
		["a numeric lineId", { ...good(), lines: [line("0"), line("1", { lineId: 1 })] }],
		["a line that is not an object", { ...good(), lines: [line("0"), null] }],
		["float tax", withLine0({ taxCents: 89.5 })],
		["NaN tax", withLine0({ taxCents: Number.NaN })],
		["Infinity tax", withLine0({ taxCents: Number.POSITIVE_INFINITY })],
		["negative tax", withLine0({ taxCents: -1 })],
		["string tax", withLine0({ taxCents: "89" })],
		["unsafe tax", withLine0({ taxCents: 2 ** 53 })],
		[
			"an unsafe SUM",
			{
				...good(),
				lines: [
					line("0", { taxCents: Number.MAX_SAFE_INTEGER }),
					line("1", { taxCents: Number.MAX_SAFE_INTEGER }),
				],
			},
		],
		["fractional rate", withLine0({ rateBps: 887.5 })],
		["negative rate", withLine0({ rateBps: -1 })],
		["rate over 1000%", withLine0({ rateBps: 100_001 })],
		["missing rate", withLine0({ rateBps: undefined })],
		["empty label", withLine0({ label: "" })],
		["label over 200 chars", withLine0({ label: "x".repeat(201) })],
		["label with a control char", withLine0({ label: "Tax\nInjected" })],
		["label with DEL", withLine0({ label: "Tax\u007f" })],
		["non-string label", withLine0({ label: 5 })],
		["shipping malformed", { ...good(), shipping: { rateBps: 1, label: "x", taxCents: -2 } }],
		["shipping not an object", { ...good(), shipping: 27 }],
	])("refuses %s", (_name, raw) => {
		expect(validateTaxResult(req, raw)).toBeNull();
	});

	test("refuses a NON-ZERO shipping tax line when no shipping was requested", () => {
		expect(validateTaxResult({ ...req, shipping: null }, good())).toBeNull();
		expect(validateTaxResult({ ...req, shipping: null }, { ...good(), shipping: null })).not.toBe(
			null,
		);
	});

	test("a ZERO shipping tax line when no shipping was requested is accepted and dropped", () => {
		const zero = { ...good(), shipping: { rateBps: 888, label: "NY sales tax", taxCents: 0 } };
		const result = validateTaxResult({ ...req, shipping: null }, zero);
		expect(result).not.toBeNull();
		expect(result?.shipping).toBeNull();
		// Still validated: a malformed zero line is refused.
		expect(
			validateTaxResult(
				{ ...req, shipping: null },
				{ ...zero, shipping: { rateBps: 888, label: "", taxCents: 0 } },
			),
		).toBeNull();
	});

	test("a tax above the taxable amount × 1000% is refused, on a line and on shipping", () => {
		// Line 0 is 1000 ⇒ at most 10000; shipping is 300 ⇒ at most 3000.
		expect(validateTaxResult(req, withLine0({ taxCents: 10_000 }))).not.toBeNull();
		expect(validateTaxResult(req, withLine0({ taxCents: 10_001 }))).toBeNull();
		const ship = (taxCents: number) => ({
			...good(),
			shipping: { rateBps: 888, label: "NY sales tax", taxCents },
		});
		expect(validateTaxResult(req, ship(3_000))).not.toBeNull();
		expect(validateTaxResult(req, ship(3_001))).toBeNull();
		// A zero-amount line can carry no tax.
		const freeLine = {
			...req,
			lines: req.lines.map((l, i) => (i === 0 ? { ...l, amountCents: cents(0) } : l)),
		};
		expect(validateTaxResult(freeLine, withLine0({ taxCents: 1 }))).toBeNull();
		expect(validateTaxResult(freeLine, withLine0({ taxCents: 0 }))).not.toBeNull();
	});

	test("a label of exactly 200 chars and a 1000% rate are the inclusive bounds", () => {
		expect(
			validateTaxResult(req, withLine0({ label: "x".repeat(200), rateBps: 100_000 })),
		).not.toBeNull();
	});
});
