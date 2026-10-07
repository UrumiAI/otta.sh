import { beforeEach, describe, expect, test, vi } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import { idempotencyKey } from "../../src/money/ids.js";
import type { ProductTaxStatus } from "../../src/ports/product-commerce-store.js";
import { computeQuote, type QuoteCommand, type QuoteDeps } from "../../src/pricing/quote.js";
import { quoteCommandFor } from "../../src/pricing/quote-input.js";
import {
	applyRateTable,
	inheritShippingTaxClass,
	rateTableOf,
	type RateTableOptions,
} from "../../src/pricing/rate-table-calculator.js";
import type {
	TaxCalculator,
	TaxRequest,
	TaxRequestLine,
} from "../../src/pricing/tax-calculator.js";
import {
	LEGACY_TAX_SETTINGS,
	NEW_STORE_TAX_SETTINGS,
	type TaxSettings,
} from "../../src/pricing/tax-settings.js";
import { validateTaxResult } from "../../src/pricing/validate-tax-result.js";
import { FixedClock, CountingIdGen } from "../../src/testing/deterministic.js";
import { InMemoryCouponStore } from "../../src/testing/in-memory-coupon-store.js";
import { InMemorySettingsStore } from "../../src/testing/in-memory-settings-store.js";
import { InMemoryShippingRulesStore } from "../../src/testing/in-memory-shipping-rules-store.js";
import { InMemoryTaxRulesStore } from "../../src/testing/in-memory-tax-rules-store.js";

/**
 * PR 2b: the product's tax status (taxable / shipping only / none) and the
 * shipping method's "taxable" flag, WooCommerce's `tax_status` on a product and
 * `is_taxable()` on a method (woo-facts-verified Q2, woo-oracle fact 9–10).
 */
const USD = currency("USD");

function line(lineId: string, amount: number, over: Partial<TaxRequestLine> = {}): TaxRequestLine {
	return {
		lineId,
		quantity: 1,
		unitPriceCents: cents(amount),
		amountCents: cents(amount),
		taxClassId: "standard",
		taxStatus: "taxable",
		requiresShipping: true,
		...over,
	};
}

function request(lines: TaxRequestLine[], over: Partial<TaxRequest> = {}): TaxRequest {
	return {
		purpose: "quote",
		currency: USD,
		pricesIncludeTax: false,
		lines,
		shipping: { amountCents: cents(1000), methodId: "m" },
		origin: null,
		destination: null,
		zoneId: "z",
		...over,
	};
}

/** standard 20%, reduced 5%; both flagged for shipping. */
const table = rateTableOf([
	{ id: "r1", taxClassId: "standard", zoneId: "z", rateBps: 2000, appliesToShipping: true },
	{ id: "r2", taxClassId: "reduced", zoneId: "z", rateBps: 500, appliesToShipping: true },
]);
const names = new Map([
	["standard", "Standard"],
	["reduced", "Reduced rate"],
]);
const inherit: RateTableOptions = { shippingTaxClass: { kind: "inherit" } };

describe("built-in maths: only 'taxable' lines are taxed", () => {
	test.each<ProductTaxStatus>(["none", "shipping_only"])(
		"a '%s' line gets 0 tax and a 0 display rate",
		(status) => {
			const r = applyRateTable(request([line("0", 1000, { taxStatus: status })]), table, names);
			expect(r.lines).toEqual([{ lineId: "0", rateBps: 0, label: "Standard", taxCents: 0 }]);
		},
	);

	for (const inclusive of [false, true]) {
		for (const roundAtSubtotal of [false, true]) {
			test(`mixed cart (${inclusive ? "incl" : "excl"}, ${roundAtSubtotal ? "at subtotal" : "per line"}): taxable lines are unchanged by untaxed ones, which get nothing`, () => {
				const taxed = [line("0", 99), line("1", 99), line("2", 99, { taxClassId: "reduced" })];
				const opts = { roundAtSubtotal };
				const alone = applyRateTable(
					request(taxed, { pricesIncludeTax: inclusive }),
					table,
					names,
					opts,
				);
				const mixed = applyRateTable(
					request(
						[
							taxed[0] as TaxRequestLine,
							line("x", 777, { taxStatus: "none" }),
							taxed[1] as TaxRequestLine,
							line("y", 333, { taxStatus: "shipping_only", taxClassId: "reduced" }),
							taxed[2] as TaxRequestLine,
						],
						{ pricesIncludeTax: inclusive },
					),
					table,
					names,
					opts,
				);
				const byId = new Map(mixed.lines.map((l) => [l.lineId, l.taxCents]));
				expect(alone.lines.map((l) => byId.get(l.lineId))).toEqual(
					alone.lines.map((l) => l.taxCents),
				);
				expect(byId.get("x")).toBe(0);
				expect(byId.get("y")).toBe(0);
			});
		}
	}

	test("at subtotal, an untaxed line in a class never absorbs an allocated cent", () => {
		// 3 × 0.99 at 20% exact 59.4 → 59; a big untaxed line in the same class
		// would take most of the allocation if it were grouped.
		const r = applyRateTable(
			request([
				line("0", 99),
				line("big", 100_000, { taxStatus: "none" }),
				line("1", 99),
				line("2", 99),
			]),
			table,
			names,
			{ roundAtSubtotal: true },
		);
		expect(r.lines.map((l) => l.taxCents)).toEqual([20, 0, 20, 19]);
	});

	test("prices entered with tax: an untaxed line's gross is its net (IN-07)", () => {
		const r = applyRateTable(
			request([line("0", 1180, { taxStatus: "none" })], { pricesIncludeTax: true, shipping: null }),
			table,
			names,
		);
		expect(r.lines[0]?.taxCents).toBe(0);
	});
});

describe("which lines set the shipping tax class ('based on cart items')", () => {
	test("a shipping-only cart: its class taxes shipping", () => {
		const r = applyRateTable(
			request([line("0", 1000, { taxStatus: "shipping_only", taxClassId: "reduced" })]),
			table,
			names,
			inherit,
		);
		expect(r.lines[0]?.taxCents).toBe(0);
		expect(r.shipping).toEqual({ rateBps: 500, label: "Reduced rate", taxCents: 50 });
	});

	test("a 'none'-only cart: no shipping tax (SH-04)", () => {
		const r = applyRateTable(
			request([line("0", 1000, { taxStatus: "none" })]),
			table,
			names,
			inherit,
		);
		expect(r.shipping).toBeNull();
	});

	test("a DIGITAL shipping-only line does not count (it ships nothing)", () => {
		const lines = [
			line("0", 1000, { taxStatus: "shipping_only", requiresShipping: false }),
			line("1", 1000, { taxStatus: "none", taxClassId: "reduced" }),
		];
		expect(inheritShippingTaxClass(lines, names)).toBeNull();
	});

	test("a fixed class taxes shipping even when every item is 'none' (WooCommerce step 1)", () => {
		const r = applyRateTable(request([line("0", 1000, { taxStatus: "none" })]), table, names, {
			shippingTaxClass: { kind: "fixed", taxClassId: "reduced" },
		});
		expect(r.shipping?.taxCents).toBe(50);
	});

	test("legacy is unchanged: an all-'none' cart still has its shipping taxed (DECISIONS 2b-1)", () => {
		const r = applyRateTable(request([line("0", 1000, { taxStatus: "none" })]), table, names, {
			shippingTaxClass: { kind: "legacy" },
		});
		expect(r.lines[0]?.taxCents).toBe(0);
		// legacy: the LAST flagged rate's class (reduced, 5%).
		expect(r.shipping?.taxCents).toBe(50);
	});
});

function answer(taxes: [number, number, number]) {
	return {
		ok: true,
		currency: "USD",
		lines: taxes.map((t, i) => ({ lineId: String(i), rateBps: 0, label: "T", taxCents: t })),
		shipping: null,
	};
}

describe("an outside calculator may not tax an untaxed line (DECISIONS 2b-2)", () => {
	const req = request([
		line("0", 1000),
		line("1", 1000, { taxStatus: "none" }),
		line("2", 1000, { taxStatus: "shipping_only" }),
	]);
	test.each([
		["a 'none' line taxed", [100, 1, 0]],
		["a 'shipping only' line taxed", [100, 0, 1]],
	] as const)("%s ⇒ refused", (_name, taxes) => {
		expect(validateTaxResult(req, answer([...taxes]))).toBeNull();
	});

	test("zero on the untaxed lines ⇒ accepted", () => {
		expect(validateTaxResult(req, answer([100, 0, 0]))?.lines.map((l) => l.taxCents)).toEqual([
			100, 0, 0,
		]);
	});

	test("the built-in's own answer is held to the same rule", () => {
		expect(validateTaxResult(req, answer([100, 1, 0]), { boundTaxToAmount: false })).toBeNull();
	});
});

describe("the quote command carries the product's status, absent when taxable", () => {
	const priced = (taxStatus?: ProductTaxStatus) => ({
		price: { amount: cents(1000), currency: USD },
		qty: 1,
		taxClass: null,
		productKind: "physical" as const,
		...(taxStatus !== undefined ? { taxStatus } : {}),
	});

	test("taxable (or a row from before the field) adds no key — the goldens stay byte-identical", () => {
		const cmd = quoteCommandFor({ currency: USD, lines: [priced("taxable"), priced()] });
		for (const l of cmd.lines) expect("taxStatus" in l).toBe(false);
	});

	test("none / shipping only are carried", () => {
		const cmd = quoteCommandFor({
			currency: USD,
			lines: [priced("none"), priced("shipping_only")],
		});
		expect(cmd.lines.map((l) => l.taxStatus)).toEqual(["none", "shipping_only"]);
	});
});

// -- computeQuote end to end -------------------------------------------------

let deps: QuoteDeps;
let shippingRules: InMemoryShippingRulesStore;
let settings: InMemorySettingsStore;
let seq = 0;

beforeEach(async () => {
	const clock = new FixedClock(new Date("2026-10-07T00:00:00.000Z"));
	shippingRules = new InMemoryShippingRulesStore();
	const taxRules = new InMemoryTaxRulesStore();
	settings = new InMemorySettingsStore();
	const couponStore = new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock });
	deps = { shippingRules, taxRules, couponStore, clock, settings };
	await shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
	await shippingRules.createMethod({
		id: "m-taxed",
		zoneId: "z-gb",
		name: "Flat",
		type: "flat_rate",
	});
	await shippingRules.createMethod({
		id: "m-untaxed",
		zoneId: "z-gb",
		name: "Courier",
		type: "flat_rate",
		taxable: false,
	});
	for (const methodId of ["m-taxed", "m-untaxed"]) {
		await shippingRules.createRate({
			methodId,
			currency: USD,
			amountCents: cents(1000),
			minSubtotalCents: null,
		});
	}
	await taxRules.createClass({ id: "standard", name: "VAT" });
	await taxRules.createRate({
		id: "t-gb",
		taxClassId: "standard",
		zoneId: "z-gb",
		rateBps: 1800,
		appliesToShipping: true,
	});
});

async function save(tax: TaxSettings): Promise<void> {
	await settings.update({ tax }, idempotencyKey(`k-${seq++}`));
}

const cart = (methodId: string, taxStatus?: "none" | "shipping_only"): QuoteCommand => ({
	currency: USD,
	lines: [
		{
			unitPriceCents: cents(1000),
			qty: 1,
			taxClassId: "standard",
			requiresShipping: true,
			...(taxStatus !== undefined ? { taxStatus } : {}),
		},
	],
	requiresShipping: true,
	destination: { country: "GB", region: null },
	methodId,
});

describe("computeQuote: product status and method taxable", () => {
	test("a taxable method is unchanged: 180 item + 180 shipping", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true });
		const q = await computeQuote(deps, cart("m-taxed"));
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(360);
		expect(q.breakdown.totalCents).toBe(2360);
	});

	test("a method that is not taxable: no shipping tax (SH-07)", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true });
		const q = await computeQuote(deps, cart("m-untaxed"));
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.shippingTaxCents).toBe(0);
		expect(q.breakdown.taxCents).toBe(180);
		expect(q.breakdown.totalCents).toBe(2180);
	});

	test("legacy stores: the method flag is honoured too", async () => {
		await save({ ...LEGACY_TAX_SETTINGS });
		const q = await computeQuote(deps, cart("m-untaxed"));
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.shippingTaxCents).toBe(0);
	});

	test("legacy stores, 'none' item, taxable method: item untaxed, shipping still taxed", async () => {
		await save({ ...LEGACY_TAX_SETTINGS });
		const q = await computeQuote(deps, cart("m-taxed", "none"));
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.lineBreakdown[0]?.taxCents).toBe(0);
		expect(q.breakdown.shippingTaxCents).toBe(180);
	});

	test("the calculator sees the line's status and `shipping: null` for an untaxed method", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true });
		const seen: TaxRequest[] = [];
		const calc: TaxCalculator = {
			id: "acme.tax",
			async calculate(req) {
				seen.push(req);
				return {
					ok: true,
					currency: req.currency,
					lines: req.lines.map((l) => ({
						lineId: l.lineId,
						rateBps: 0,
						label: "T",
						taxCents: cents(0),
					})),
					shipping: null,
				};
			},
		};
		const q = await computeQuote(
			{ ...deps, taxCalculator: calc },
			cart("m-untaxed", "shipping_only"),
		);
		expect(q.ok).toBe(true);
		expect(seen[0]?.lines[0]?.taxStatus).toBe("shipping_only");
		expect(seen[0]?.shipping).toBeNull();
	});

	test("an outside calculator taxing shipping on an untaxed method ⇒ TAX_UNAVAILABLE", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true });
		const calc: TaxCalculator = {
			id: "acme.tax",
			async calculate(req) {
				return {
					ok: true,
					currency: req.currency,
					lines: req.lines.map((l) => ({
						lineId: l.lineId,
						rateBps: 0,
						label: "T",
						taxCents: cents(0),
					})),
					shipping: { rateBps: 1800, label: "T", taxCents: cents(180) },
				};
			},
		};
		const q = await computeQuote({ ...deps, taxCalculator: calc }, cart("m-untaxed"));
		expect(q).toMatchObject({ ok: false, reason: "TAX_UNAVAILABLE" });
	});

	test("an outside calculator taxing a 'none' line ⇒ TAX_UNAVAILABLE", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true });
		const calc: TaxCalculator = {
			id: "acme.tax",
			async calculate(req) {
				return {
					ok: true,
					currency: req.currency,
					lines: req.lines.map((l) => ({
						lineId: l.lineId,
						rateBps: 1800,
						label: "T",
						taxCents: cents(180),
					})),
					shipping: null,
				};
			},
		};
		const q = await computeQuote({ ...deps, taxCalculator: calc }, cart("m-taxed", "none"));
		expect(q).toMatchObject({ ok: false, reason: "TAX_UNAVAILABLE" });
	});
});
