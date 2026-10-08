import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import { idempotencyKey } from "../../src/money/ids.js";
import { computeQuote, type QuoteCommand, type QuoteDeps } from "../../src/pricing/quote.js";
import type { TaxCalculator, TaxRequest } from "../../src/pricing/tax-calculator.js";
import {
	LEGACY_TAX_SETTINGS,
	NEW_STORE_TAX_SETTINGS,
	TAX_DISABLED_CALCULATOR_ID,
	type TaxSettings,
} from "../../src/pricing/tax-settings.js";
import { CountingIdGen, FixedClock } from "../../src/testing/deterministic.js";
import { InMemoryCouponStore } from "../../src/testing/in-memory-coupon-store.js";
import { InMemorySettingsStore } from "../../src/testing/in-memory-settings-store.js";
import { InMemoryShippingRulesStore } from "../../src/testing/in-memory-shipping-rules-store.js";
import { InMemoryTaxRulesStore } from "../../src/testing/in-memory-tax-rules-store.js";

/**
 * PR 2a: the `tax` settings block drives `computeQuote` (SPEC §4, DECISIONS 4–5).
 * Everything still flows through the ONE calculator call; these cases pin what
 * the settings change around it.
 */
const USD = currency("USD");
let deps: QuoteDeps;
let taxRules: InMemoryTaxRulesStore;
let settings: InMemorySettingsStore;
let couponStore: InMemoryCouponStore;
let seq = 0;

beforeEach(async () => {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const shippingRules = new InMemoryShippingRulesStore();
	taxRules = new InMemoryTaxRulesStore();
	settings = new InMemorySettingsStore();
	couponStore = new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock });
	deps = { shippingRules, taxRules, couponStore, clock, settings };
	// Two zones: the US (where the shop is) and the UK.
	await shippingRules.createZone({ id: "z-us", name: "US", regions: ["US"] });
	await shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
	for (const z of ["z-us", "z-gb"]) {
		await shippingRules.createMethod({ id: `m-${z}`, zoneId: z, name: "Flat", type: "flat_rate" });
		await shippingRules.createRate({
			methodId: `m-${z}`,
			currency: USD,
			amountCents: cents(500),
			minSubtotalCents: null,
		});
	}
	await taxRules.createClass({ id: "standard", name: "Sales tax" });
	await taxRules.createRate({
		id: "t-us",
		taxClassId: "standard",
		zoneId: "z-us",
		rateBps: 1000,
		appliesToShipping: true,
	});
	await taxRules.createRate({
		id: "t-gb",
		taxClassId: "standard",
		zoneId: "z-gb",
		rateBps: 2000,
		appliesToShipping: true,
	});
});

async function save(tax: TaxSettings): Promise<void> {
	await settings.update({ tax }, idempotencyKey(`k-${seq++}`));
}

const physical: QuoteCommand = {
	currency: USD,
	lines: [{ unitPriceCents: cents(1200), qty: 1, taxClassId: "standard", requiresShipping: true }],
	requiresShipping: true,
	destination: { country: "GB", region: null },
	methodId: "m-z-gb",
};

const digital: QuoteCommand = {
	currency: USD,
	lines: [{ unitPriceCents: cents(1000), qty: 1, taxClassId: "standard", requiresShipping: false }],
	requiresShipping: false,
};

function spy(): TaxCalculator & { seen: TaxRequest[] } {
	const seen: TaxRequest[] = [];
	return {
		id: "acme.tax",
		seen,
		async calculate(req) {
			seen.push(req);
			return {
				ok: true,
				currency: req.currency,
				lines: req.lines.map((l) => ({
					lineId: l.lineId,
					rateBps: 0,
					label: "X",
					taxCents: cents(0),
				})),
				shipping: null,
			};
		},
	};
}

describe("the upgrade rule (no saved tax settings)", () => {
	test("rates exist ⇒ tax stays ON with the legacy shipping class (today's maths)", async () => {
		const q = await computeQuote(deps, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(q.taxSettings).toEqual(LEGACY_TAX_SETTINGS);
		expect(q.breakdown.taxCents).toBe(240 + 100);
	});

	test("no rates and no outside calculator ⇒ the new-store defaults: tax OFF", async () => {
		const empty = new InMemoryTaxRulesStore();
		const q = await computeQuote({ ...deps, taxRules: empty }, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(q.taxSettings).toEqual(NEW_STORE_TAX_SETTINGS);
		expect(q.breakdown.taxCents).toBe(0);
		expect(q.tax.calculatorId).toBe(TAX_DISABLED_CALCULATOR_ID);
	});

	test("no rates but an outside calculator registered ⇒ tax stays ON and the calculator is asked", async () => {
		// The calculator replaces the rate table, so such a store has no rates; it
		// charged tax before ADR-0032 and must keep charging it with nothing saved.
		const empty = new InMemoryTaxRulesStore();
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
						rateBps: 1000,
						label: "VAT",
						taxCents: cents(120),
					})),
					shipping: null,
				};
			},
		};
		const q = await computeQuote({ ...deps, taxRules: empty, taxCalculator: calc }, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(q.taxSettings).toEqual(LEGACY_TAX_SETTINGS);
		expect(seen.map((r) => r.purpose)).toEqual(["quote"]);
		expect(q.tax.calculatorId).toBe("acme.tax");
		expect(q.breakdown.taxCents).toBe(120);
	});

	test("an outside calculator does not override saved options that switch tax off", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS });
		const calc = spy();
		const q = await computeQuote({ ...deps, taxCalculator: calc }, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(calc.seen).toHaveLength(0);
		expect(q.tax.calculatorId).toBe(TAX_DISABLED_CALCULATOR_ID);
	});

	test("no settings store wired (pure callers) behaves as 'nothing saved'", async () => {
		const { settings: _omit, ...bare } = deps;
		const q = await computeQuote(bare, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(340);
	});
});

describe("tax on/off", () => {
	test("disabled ⇒ zero tax, the outside calculator is never asked, prices are never tax-inclusive", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, pricesIncludeTax: true });
		const calc = spy();
		const q = await computeQuote({ ...deps, taxCalculator: calc }, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(calc.seen).toHaveLength(0);
		expect(q.breakdown.taxCents).toBe(0);
		expect(q.breakdown.totalCents).toBe(1200 + 500);
		expect(q.tax.pricesIncludeTax).toBe(false);
		expect(q.tax.result.lines).toEqual([{ lineId: "0", rateBps: 0, label: "Tax", taxCents: 0 }]);
	});

	test("enabled with the new-store defaults taxes at the shipping address", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true });
		const q = await computeQuote(deps, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(240 + 100);
	});
});

describe("prices entered with tax", () => {
	test("inclusive 20%: the buyer pays the entered gross; shipping tax is added (example 5)", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true, pricesIncludeTax: true });
		const q = await computeQuote(deps, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(200 + 100);
		expect(q.breakdown.totalCents).toBe(1200 + 500 + 100);
		expect(q.tax.pricesIncludeTax).toBe(true);
	});

	test("inclusive 20% with a 10% coupon: discounted gross 1080 → tax 180 (example 4)", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true, pricesIncludeTax: true });
		await couponStore.create({
			id: "c-ten",
			code: "TEN",
			type: "percentage",
			rateBps: 1000,
			amountCents: null,
			capCents: null,
			currency: null,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
		const q = await computeQuote(deps, { ...physical, couponCode: "TEN" });
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.lineBreakdown[0]?.taxCents).toBe(180);
		expect(q.breakdown.totalCents).toBe(1080 + 500 + 100);
	});

	test("the calculator is told prices include tax", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true, pricesIncludeTax: true });
		const calc = spy();
		await computeQuote({ ...deps, taxCalculator: calc }, physical);
		expect(calc.seen[0]?.pricesIncludeTax).toBe(true);
	});
});

describe("calculate tax based on", () => {
	test("'base' taxes at the shop's address, whatever the ship-to", async () => {
		await save({
			...NEW_STORE_TAX_SETTINGS,
			enabled: true,
			basedOn: "base",
			baseAddress: { country: "US", region: "NY" },
		});
		const calc = spy();
		const q = await computeQuote(deps, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(120 + 50); // the US 10%, not the UK 20%
		await computeQuote({ ...deps, taxCalculator: calc }, physical);
		expect(calc.seen[0]?.zoneId).toBe("z-us");
		expect(calc.seen[0]?.destination).toEqual({
			country: "US",
			region: "NY",
			postalCode: null,
			city: null,
		});
		expect(calc.seen[0]?.origin).toEqual({
			country: "US",
			region: "NY",
			postalCode: null,
			city: null,
		});
	});

	test("'base' with no base address set falls back to the shipping address", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true, basedOn: "base" });
		const q = await computeQuote(deps, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(240 + 100);
	});

	test("a base address no zone matches ⇒ no rate ⇒ 0% (never a refusal)", async () => {
		await save({
			...NEW_STORE_TAX_SETTINGS,
			enabled: true,
			basedOn: "base",
			baseAddress: { country: "FR", region: null },
		});
		const q = await computeQuote(deps, physical);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(0);
	});
});

describe("digital-only carts (DECISIONS 5)", () => {
	test("with a shop base address: taxed at the base address", async () => {
		await save({
			...NEW_STORE_TAX_SETTINGS,
			enabled: true,
			baseAddress: { country: "GB", region: null },
		});
		const q = await computeQuote(deps, digital);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(200);
		expect(q.taxLocated).toBe(true);
	});

	test("NO SILENT CHANGE: no base address ⇒ untaxed, exactly as before", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true });
		const q = await computeQuote(deps, digital);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(0);
		expect(q.taxLocated).toBe(false);
	});

	test("NO SILENT CHANGE: an existing store (nothing saved) leaves digital carts untaxed", async () => {
		const q = await computeQuote(deps, digital);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(0);
	});
});

describe("shipping tax class and rounding settings reach the built-in", () => {
	beforeEach(async () => {
		await taxRules.createClass({ id: "reduced", name: "Reduced rate" });
		await taxRules.createRate({
			id: "t-gb-reduced",
			taxClassId: "reduced",
			zoneId: "z-gb",
			rateBps: 500,
			appliesToShipping: false,
		});
	});
	const mixed: QuoteCommand = {
		...physical,
		lines: [{ unitPriceCents: cents(1200), qty: 1, taxClassId: "reduced", requiresShipping: true }],
	};

	test("legacy: the last flagged rate's class (standard) taxes shipping at 20%", async () => {
		await save({ ...LEGACY_TAX_SETTINGS });
		const q = await computeQuote(deps, mixed);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.shippingTaxCents).toBe(100);
	});

	test("inherit: the cart's only class (reduced) is not flagged for shipping ⇒ untaxed", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true });
		const q = await computeQuote(deps, mixed);
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.shippingTaxCents).toBe(0);
	});

	test("round at subtotal", async () => {
		await save({ ...NEW_STORE_TAX_SETTINGS, enabled: true, roundAtSubtotal: true });
		const q = await computeQuote(deps, {
			...physical,
			lines: [
				{ unitPriceCents: cents(199), qty: 1, taxClassId: "standard", requiresShipping: true },
				{ unitPriceCents: cents(199), qty: 1, taxClassId: "standard", requiresShipping: true },
				{ unitPriceCents: cents(199), qty: 1, taxClassId: "standard", requiresShipping: true },
			],
		});
		if (!q.ok) throw new Error(q.reason);
		// per line 39.8 → 40 each (120); at subtotal 597 × 20% = 119.4 → 119, allocated 40/40/39
		expect(q.breakdown.lineBreakdown.map((l) => l.taxCents)).toEqual([40, 40, 39]);
	});
});
