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

/**
 * Review 2a B1: with prices entered WITH tax, a line's amount is the GROSS and
 * the tax inside it is `G × r / (10000 + r)` — below G at any rate. The bound is
 * that at the 1000% cap, `ceil(G × 100000 / 110000)`, in exact integers, so the
 * net (G − tax) can never go negative. Shipping is always entered without tax,
 * so it keeps the exclusive bound (`amount × 10`).
 */
describe("validateTaxResult — the tax bound when prices are entered with tax", () => {
	const gross = (amounts: [number, number], shipping = 300): TaxRequest => ({
		...req,
		pricesIncludeTax: true,
		lines: [
			{ ...req.lines[0]!, amountCents: cents(amounts[0]), unitPriceCents: cents(amounts[0]) },
			{ ...req.lines[1]!, amountCents: cents(amounts[1]), unitPriceCents: cents(amounts[1]) },
		],
		shipping: { amountCents: cents(shipping), methodId: "m" },
	});
	const answer = (tax0: number, shippingTax = 27) => ({
		...good(),
		lines: [line("0", { taxCents: tax0 }), line("1", { taxCents: 0 })],
		shipping: { rateBps: 888, label: "NY sales tax", taxCents: shippingTax },
	});

	test.each<[number, number]>([
		// [gross, the largest tax accepted] — ceil(G × 100000 / 110000)
		[1100, 1000], // exact: 1100 at 1000% is 1000 tax + 100 net
		[1, 1],
		[12, 11], // 10.909… ⇒ 11
		[11, 10], // exactly 10
		[1200, 1091], // 1090.909… ⇒ 1091
	])("gross %i: tax %i is accepted, one more is refused", (g, max) => {
		expect(validateTaxResult(gross([g, 500]), answer(max))).not.toBeNull();
		expect(validateTaxResult(gross([g, 500]), answer(max + 1))).toBeNull();
	});

	test("tax above the gross (the reviewer's repro: tax = 10 × amount) is refused", () => {
		expect(validateTaxResult(gross([1200, 500]), answer(12_000))).toBeNull();
		expect(validateTaxResult(gross([1200, 500]), answer(1201))).toBeNull();
	});

	test("a zero gross allows only zero tax", () => {
		expect(validateTaxResult(gross([0, 500]), answer(0))).not.toBeNull();
		expect(validateTaxResult(gross([0, 500]), answer(1))).toBeNull();
	});

	test("exact at the largest safe gross — no float product", () => {
		const g = Number.MAX_SAFE_INTEGER;
		const max = Number((BigInt(g) * 100_000n + 109_999n) / 110_000n);
		expect(validateTaxResult(gross([g, 0]), answer(max, 0))).not.toBeNull();
		expect(validateTaxResult(gross([g, 0]), answer(max + 1, 0))).toBeNull();
	});

	test("shipping keeps the exclusive bound: amount × 10 accepted, one more refused", () => {
		expect(validateTaxResult(gross([1000, 500]), answer(0, 3000))).not.toBeNull();
		expect(validateTaxResult(gross([1000, 500]), answer(0, 3001))).toBeNull();
	});

	test("prices entered without tax keep the exclusive bound on lines: amount × 10", () => {
		const excl = { ...gross([1000, 500]), pricesIncludeTax: false };
		expect(validateTaxResult(excl, answer(10_000))).not.toBeNull();
		expect(validateTaxResult(excl, answer(10_001))).toBeNull();
	});
});
