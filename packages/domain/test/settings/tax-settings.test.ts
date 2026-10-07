import {
	effectiveTaxSettings,
	idempotencyKey,
	InvalidSettingsError,
	LEGACY_TAX_SETTINGS,
	NEW_STORE_TAX_SETTINGS,
	readTaxSettings,
	type TaxSettings,
	updateSettings,
} from "@otta-sh/domain";
import { InMemorySettingsStore } from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";

/**
 * PR 2a: the `tax` block of the operational settings (SPEC §4). Defaults are
 * WooCommerce's (woo-facts-verified, option defaults table); an existing store
 * with rates and nothing saved keeps today's behaviour (DECISIONS 4).
 */
describe("tax settings defaults", () => {
	test("a new store: tax off, prices without tax, shipping address, based on cart items, per line, excl, itemized", () => {
		expect(NEW_STORE_TAX_SETTINGS).toEqual({
			enabled: false,
			pricesIncludeTax: false,
			basedOn: "shipping",
			baseAddress: null,
			shippingTaxClass: { kind: "inherit" },
			roundAtSubtotal: false,
			displayCart: "excl",
			totalsDisplay: "itemized",
		});
	});

	test("an existing store: on, with the legacy shipping class and a single tax row (today's page)", () => {
		expect(LEGACY_TAX_SETTINGS).toEqual({
			...NEW_STORE_TAX_SETTINGS,
			enabled: true,
			shippingTaxClass: { kind: "legacy" },
			totalsDisplay: "single",
		});
	});

	test("the upgrade rule: saved wins; else rates ⇒ legacy; else the new-store defaults", () => {
		const saved: TaxSettings = { ...NEW_STORE_TAX_SETTINGS, enabled: true };
		expect(effectiveTaxSettings(saved, true)).toBe(saved);
		expect(effectiveTaxSettings(undefined, true)).toEqual(LEGACY_TAX_SETTINGS);
		expect(effectiveTaxSettings(undefined, false)).toEqual(NEW_STORE_TAX_SETTINGS);
	});
});

describe("readTaxSettings — a stored block, whatever its age", () => {
	test("absent or malformed ⇒ undefined (= never saved)", () => {
		expect(readTaxSettings(undefined)).toBeUndefined();
		expect(readTaxSettings(null)).toBeUndefined();
		expect(readTaxSettings("on")).toBeUndefined();
	});

	test("a complete block reads back as written", () => {
		const block: TaxSettings = {
			enabled: true,
			pricesIncludeTax: true,
			basedOn: "base",
			baseAddress: { country: "GB", region: null },
			shippingTaxClass: { kind: "fixed", taxClassId: "reduced" },
			roundAtSubtotal: true,
			displayCart: "incl",
			totalsDisplay: "single",
		};
		expect(readTaxSettings(JSON.parse(JSON.stringify(block)))).toEqual(block);
	});

	test("a field missing or invalid in a stored block falls back to the new-store default", () => {
		expect(readTaxSettings({ enabled: true, displayCart: "sideways" })).toEqual({
			...NEW_STORE_TAX_SETTINGS,
			enabled: true,
		});
	});
});

describe("updateSettings validates the tax block before it reaches the store", () => {
	const ok: TaxSettings = { ...NEW_STORE_TAX_SETTINGS, enabled: true };

	test("a valid block is stored and read back; the address is normalised", async () => {
		const store = new InMemorySettingsStore();
		const result = await updateSettings(
			store,
			{ tax: { ...ok, baseAddress: { country: " us ", region: "ny" } } },
			idempotencyKey("k1"),
		);
		expect(result.tax?.baseAddress).toEqual({ country: "US", region: "NY" });
		expect((await store.get()).tax).toEqual(result.tax);
	});

	test.each<[string, unknown]>([
		["enabled", { ...ok, enabled: "yes" }],
		["pricesIncludeTax", { ...ok, pricesIncludeTax: 1 }],
		["basedOn", { ...ok, basedOn: "billing" }],
		["baseAddress", { ...ok, baseAddress: { country: "XX", region: null } }],
		["baseAddress", { ...ok, baseAddress: { country: "US", region: "ZZ" } }],
		["shippingTaxClass", { ...ok, shippingTaxClass: { kind: "fixed", taxClassId: "" } }],
		["shippingTaxClass", { ...ok, shippingTaxClass: "inherit" }],
		["roundAtSubtotal", { ...ok, roundAtSubtotal: null }],
		["displayCart", { ...ok, displayCart: "both" }],
		["totalsDisplay", { ...ok, totalsDisplay: "none" }],
		["tax", null],
	])("refuses a bad %s", async (field, tax) => {
		const store = new InMemorySettingsStore();
		const attempt = updateSettings(store, { tax: tax as TaxSettings }, idempotencyKey("k1"));
		await expect(attempt).rejects.toBeInstanceOf(InvalidSettingsError);
		await expect(attempt).rejects.toMatchObject({ field: `tax.${field}`.replace("tax.tax", "tax") });
		expect((await store.get()).tax).toBeUndefined();
	});

	test("a patch without `tax` keeps the saved block", async () => {
		const store = new InMemorySettingsStore();
		await updateSettings(store, { tax: ok }, idempotencyKey("k1"));
		const next = await updateSettings(store, { lowStockThreshold: 9 }, idempotencyKey("k2"));
		expect(next.tax).toEqual(ok);
	});
});
