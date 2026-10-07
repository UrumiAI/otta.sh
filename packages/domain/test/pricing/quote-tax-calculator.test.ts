import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import { computeQuote, type QuoteCommand, type QuoteDeps } from "../../src/pricing/quote.js";
import {
	DEFAULT_TAX_CALCULATOR_TIMEOUT_MS,
	type TaxCalculator,
	type TaxRequest,
} from "../../src/pricing/tax-calculator.js";
import { CountingIdGen, FixedClock } from "../../src/testing/deterministic.js";
import { InMemoryCouponStore } from "../../src/testing/in-memory-coupon-store.js";
import { InMemoryShippingRulesStore } from "../../src/testing/in-memory-shipping-rules-store.js";
import { InMemoryTaxRulesStore } from "../../src/testing/in-memory-tax-rules-store.js";

/**
 * The ONE call site (PR 1): `computeQuote` asks a calculator for the tax. With
 * none injected it uses the built-in rate table; with an outside one, any
 * throw, refusal, invalid answer or timeout is `TAX_UNAVAILABLE`.
 */
const USD = currency("USD");
let deps: QuoteDeps;
let taxRules: InMemoryTaxRulesStore;
let couponStore: InMemoryCouponStore;

beforeEach(async () => {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const shippingRules = new InMemoryShippingRulesStore();
	taxRules = new InMemoryTaxRulesStore();
	couponStore = new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock });
	deps = { shippingRules, taxRules, couponStore, clock };
	await shippingRules.createZone({ id: "z-us", name: "US", regions: ["US"] });
	await shippingRules.createMethod({ id: "m", zoneId: "z-us", name: "Flat", type: "flat_rate" });
	await shippingRules.createRate({
		methodId: "m",
		currency: USD,
		amountCents: cents(500),
		minSubtotalCents: null,
	});
	await taxRules.createRate({
		id: "t",
		taxClassId: "standard",
		zoneId: "z-us",
		rateBps: 1000,
		appliesToShipping: true,
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const command: QuoteCommand = {
	currency: USD,
	lines: [
		{ unitPriceCents: cents(1500), qty: 2, taxClassId: "standard" },
		{ unitPriceCents: cents(999), qty: 1, taxClassId: "reduced" },
	],
	requiresShipping: true,
	destination: { country: "us", region: "ny", postalCode: "10001", city: "New York" },
	methodId: "m",
};

/** An outside calculator answering 8.875% per line, flat 10 on shipping. */
function fake(answer?: (req: TaxRequest) => unknown): TaxCalculator & { seen: TaxRequest[] } {
	const seen: TaxRequest[] = [];
	return {
		id: "acme.tax",
		seen,
		async calculate(req) {
			seen.push(req);
			if (answer !== undefined) return answer(req) as never;
			return {
				ok: true,
				currency: req.currency,
				lines: req.lines.map((l) => ({
					lineId: l.lineId,
					rateBps: 888,
					label: "NY",
					taxCents: cents(Math.round((l.amountCents * 8875) / 100_000)),
				})),
				shipping: { rateBps: 888, label: "NY", taxCents: cents(10) },
			};
		},
	};
}

describe("computeQuote → TaxCalculator", () => {
	test("the built-in is used when none is injected, and it is named on the result", async () => {
		const res = await computeQuote(deps, command);
		expect(res.ok && res.tax.calculatorId).toBe("otta.rate-table");
		// 3000 @10% = 300, 999 @0% (no rate), shipping 500 @10% = 50.
		expect(res.ok && res.breakdown.taxCents).toBe(350);
	});

	test("an outside calculator sees one frozen, generic request and its answer prices the quote", async () => {
		const calc = fake();
		const res = await computeQuote({ ...deps, taxCalculator: calc }, command);
		expect(calc.seen).toEqual([
			{
				purpose: "quote",
				currency: "USD",
				pricesIncludeTax: false,
				lines: [
					{
						lineId: "0",
						quantity: 2,
						unitPriceCents: 1500,
						amountCents: 3000,
						taxClassId: "standard",
						taxStatus: "taxable",
					},
					{
						lineId: "1",
						quantity: 1,
						unitPriceCents: 999,
						amountCents: 999,
						taxClassId: "reduced",
						taxStatus: "taxable",
					},
				],
				shipping: { amountCents: 500, methodId: "m" },
				origin: null,
				destination: { country: "US", region: "NY", postalCode: "10001", city: "New York" },
				zoneId: "z-us",
			},
		]);
		const seen = calc.seen[0] as TaxRequest;
		expect(
			Object.isFrozen(seen) && Object.isFrozen(seen.lines) && Object.isFrozen(seen.lines[0]),
		).toBe(true);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// 3000 → 266.25 → 266; 999 → 88.66 → 89; shipping 10.
		expect(res.breakdown).toMatchObject({
			taxCents: 365,
			shippingTaxCents: 10,
			totalCents: 3999 + 500 + 365,
		});
		expect(res.breakdown.lineBreakdown.map((l) => l.taxCents)).toEqual([266, 89]);
		expect(res.tax.calculatorId).toBe("acme.tax");
		expect(res.tax.result.lines.map((l) => l.label)).toEqual(["NY", "NY"]);
	});

	test("purpose is passed through; a digital-only cart has no destination and no shipping", async () => {
		const calc = fake();
		await computeQuote(
			{ ...deps, taxCalculator: calc },
			{ currency: USD, lines: command.lines, requiresShipping: false },
			{ purpose: "order" },
		);
		expect(calc.seen[0]).toMatchObject({
			purpose: "order",
			destination: null,
			shipping: null,
			zoneId: null,
		});
	});

	test("an absent postcode/city reaches the calculator as null", async () => {
		const calc = fake();
		await computeQuote(
			{ ...deps, taxCalculator: calc },
			{ ...command, destination: { country: "US", region: "NY" } },
		);
		expect(calc.seen[0]?.destination).toEqual({
			country: "US",
			region: "NY",
			postalCode: null,
			city: null,
		});
	});

	test.each<[string, TaxCalculator["calculate"]]>([
		[
			"throws synchronously",
			() => {
				throw new Error("boom");
			},
		],
		["rejects", () => Promise.reject(new Error("503"))],
		["refuses", async () => ({ ok: false, reason: "unavailable", detail: "down" })],
		["answers garbage", async () => ({ ok: true }) as never],
		[
			"answers in another currency",
			async () => ({ ok: true, currency: currency("EUR"), lines: [], shipping: null }) as never,
		],
	])("an outside calculator that %s ⇒ TAX_UNAVAILABLE", async (_name, calculate) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const res = await computeQuote(
			{ ...deps, taxCalculator: { id: "acme.tax", calculate } },
			command,
		);
		expect(res).toEqual({ ok: false, reason: "TAX_UNAVAILABLE" });
		// Logged by calculator id, never with the buyer's address.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warn.mock.calls)).toContain("acme.tax");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("10001");
	});

	test("a calculator with an unusable id is refused before it is called", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const calc = fake();
		const res = await computeQuote(
			{ ...deps, taxCalculator: { ...calc, id: "bad id\n" } },
			command,
		);
		expect(res).toEqual({ ok: false, reason: "TAX_UNAVAILABLE" });
		expect(calc.seen).toEqual([]);
	});

	test(`a calculator that never answers times out at ${String(DEFAULT_TAX_CALCULATOR_TIMEOUT_MS)} ms ⇒ TAX_UNAVAILABLE`, async () => {
		expect(DEFAULT_TAX_CALCULATOR_TIMEOUT_MS).toBe(5_000);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();
		let settled = false;
		const pending = computeQuote(
			{ ...deps, taxCalculator: { id: "slow", calculate: () => new Promise(() => {}) } },
			command,
		).then((r) => {
			settled = true;
			return r;
		});
		await vi.advanceTimersByTimeAsync(4_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toEqual({ ok: false, reason: "TAX_UNAVAILABLE" });
		expect(vi.getTimerCount()).toBe(0);
	});

	test("an answer that arrives in time clears its timer", async () => {
		vi.useFakeTimers();
		const res = await computeQuote({ ...deps, taxCalculator: fake() }, command);
		expect(res.ok).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("a refusal before the tax step never calls the calculator (no paid call wasted)", async () => {
		const calc = fake();
		const res = await computeQuote(
			{ ...deps, taxCalculator: calc },
			{ ...command, couponCode: "NOPE" },
		);
		expect(res).toEqual({ ok: false, reason: "COUPON_NOT_FOUND" });
		expect(calc.seen).toEqual([]);
	});
});
