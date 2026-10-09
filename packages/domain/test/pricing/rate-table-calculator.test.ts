import { describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import type { TaxClass, TaxRate, TaxRulesStore } from "../../src/ports/tax-rules-store.js";
import {
	createRateTableCalculator,
	RATE_TABLE_CALCULATOR_ID,
} from "../../src/pricing/rate-table-calculator.js";
import type { TaxRequest, TaxResult } from "../../src/pricing/tax-calculator.js";

/**
 * The built-in `otta.rate-table` calculator over a store that lists rates in
 * the order given — the emdash store lists by id ascending (S/emdash-tax-rules-
 * store.ts), so "the last listed" is "the highest id". It pins main's
 * behaviour, including the duplicate-rate rule, rather than fixing it.
 */
function storeWith(rates: Array<Omit<TaxRate, "zoneId">>, classes: TaxClass[] = []) {
	const reads: string[] = [];
	const store = {
		async listRatesForZone(zoneId: string) {
			reads.push(`rates:${zoneId}`);
			return rates.map((r) => ({ ...r, zoneId }));
		},
		async listClasses() {
			reads.push("classes");
			return classes;
		},
	} as unknown as TaxRulesStore;
	return { store, reads };
}

function request(over: Partial<TaxRequest> = {}): TaxRequest {
	return {
		purpose: "quote",
		currency: currency("USD"),
		pricesIncludeTax: false,
		lines: [
			{
				lineId: "0",
				quantity: 2,
				unitPriceCents: cents(5000),
				amountCents: cents(10_000),
				taxClassId: "standard",
				taxStatus: "taxable",
				requiresShipping: true,
			},
			{
				lineId: "1",
				quantity: 1,
				unitPriceCents: cents(999),
				amountCents: cents(999),
				taxClassId: "reduced",
				taxStatus: "taxable",
				requiresShipping: true,
			},
		],
		shipping: { amountCents: cents(500), methodId: "m-1" },
		origin: null,
		destination: { country: "US", region: "CA", postalCode: "90001", city: "LA" },
		zoneId: "z",
		...over,
	};
}

async function calc(store: TaxRulesStore, req: TaxRequest = request()): Promise<TaxResult> {
	const res = await createRateTableCalculator(store).calculate(req);
	if (!res.ok) throw new Error("the built-in never refuses");
	return res;
}

describe("createRateTableCalculator (otta.rate-table)", () => {
	test("its id is otta.rate-table; labels are class names, rates whole bps", async () => {
		const { store } = storeWith(
			[
				{ id: "a", taxClassId: "standard", rateBps: 725, appliesToShipping: true },
				{ id: "b", taxClassId: "reduced", rateBps: 300, appliesToShipping: false },
			],
			[
				{ id: "standard", name: "Standard rate" },
				{ id: "reduced", name: "Reduced rate" },
			],
		);
		expect(createRateTableCalculator(store).id).toBe(RATE_TABLE_CALCULATOR_ID);
		expect(RATE_TABLE_CALCULATOR_ID).toBe("otta.rate-table");
		expect(await calc(store)).toEqual({
			ok: true,
			currency: "USD",
			lines: [
				{ lineId: "0", rateBps: 725, label: "Standard rate", taxCents: 725 },
				{ lineId: "1", rateBps: 300, label: "Reduced rate", taxCents: 30 },
			],
			// 500 × 7.25% = 36.25 → 36
			shipping: { rateBps: 725, label: "Standard rate", taxCents: 36 },
		});
	});

	test("a class with no rate in the zone is 0% — never a refusal", async () => {
		const { store } = storeWith([
			{ id: "a", taxClassId: "standard", rateBps: 1000, appliesToShipping: false },
		]);
		const res = await calc(store);
		expect(res.lines[1]).toEqual({ lineId: "1", rateBps: 0, label: "reduced", taxCents: 0 });
		expect(res.shipping).toBeNull();
	});

	test("duplicate (class, zone) rates: the LAST listed wins (= highest id on emdash)", async () => {
		const { store } = storeWith([
			{ id: "a", taxClassId: "standard", rateBps: 500, appliesToShipping: false },
			{ id: "b", taxClassId: "standard", rateBps: 2000, appliesToShipping: false },
		]);
		expect((await calc(store)).lines[0]).toMatchObject({ rateBps: 2000, taxCents: 2000 });
	});

	test("two shipping-flagged rates: the last listed one's class taxes shipping", async () => {
		const { store } = storeWith([
			{ id: "a", taxClassId: "standard", rateBps: 1000, appliesToShipping: true },
			{ id: "b", taxClassId: "reduced", rateBps: 2000, appliesToShipping: true },
		]);
		expect((await calc(store)).shipping).toEqual({
			rateBps: 2000,
			label: "reduced",
			taxCents: 100,
		});
	});

	test("no matched zone (digital-only, or no zones): no tax and no store read", async () => {
		const { store, reads } = storeWith([
			{ id: "a", taxClassId: "standard", rateBps: 1000, appliesToShipping: true },
		]);
		const res = await calc(store, request({ zoneId: null, shipping: null, destination: null }));
		expect(res.lines.map((l) => l.taxCents)).toEqual([0, 0]);
		expect(res.shipping).toBeNull();
		expect(reads).toEqual([]);
	});

	test("no shipping line requested ⇒ no shipping tax line, even when flagged", async () => {
		const { store } = storeWith([
			{ id: "a", taxClassId: "standard", rateBps: 1000, appliesToShipping: true },
		]);
		expect((await calc(store, request({ shipping: null }))).shipping).toBeNull();
	});

	test("a class name that is not a valid label falls back to the class id", async () => {
		const { store } = storeWith(
			[{ id: "a", taxClassId: "standard", rateBps: 1000, appliesToShipping: false }],
			[
				{ id: "standard", name: "Bad\u0007name" },
				{ id: "reduced", name: "x".repeat(201) },
			],
		);
		expect((await calc(store)).lines.map((l) => l.label)).toEqual(["standard", "reduced"]);
	});
});

/**
 * Review 2a B4: a fixed shipping tax class that does not exist (never did, or was
 * deleted since) must not silently stop shipping tax. The built-in falls back to
 * "based on cart items" — the class the cart's own lines pick — which taxes
 * shipping whenever a shipping line's class has a flagged rate (ADR-0032).
 */
describe("a fixed shipping tax class that no longer exists", () => {
	const rates = [
		{ id: "a", taxClassId: "standard", rateBps: 1000, appliesToShipping: true },
		{ id: "b", taxClassId: "reduced", rateBps: 500, appliesToShipping: false },
	];
	const classes = [
		{ id: "standard", name: "Standard" },
		{ id: "reduced", name: "Reduced" },
	];

	test("falls back to 'based on cart items': shipping is taxed at the cart's class", async () => {
		const { store } = storeWith(rates, classes);
		const res = await createRateTableCalculator(store, {
			shippingTaxClass: { kind: "fixed", taxClassId: "gone" },
		}).calculate(request());
		if (!res.ok) throw new Error("the built-in never refuses");
		// A standard line ships ⇒ inherit picks standard, flagged at 10% ⇒ 50 on 500.
		expect(res.shipping?.taxCents).toBe(50);
	});

	test("an existing fixed class is still used as set — even when it taxes nothing", async () => {
		const { store } = storeWith(rates, classes);
		const res = await createRateTableCalculator(store, {
			shippingTaxClass: { kind: "fixed", taxClassId: "reduced" },
		}).calculate(request());
		if (!res.ok) throw new Error("the built-in never refuses");
		expect(res.shipping).toBeNull();
	});
});
