/**
 * The store's tax options (PR 2a, ADR-0032) — WooCommerce core's Tax tab, minus
 * what Otta has no data for yet (billing address; shop-page display). Stored
 * whole as the `tax` block of the operational settings; ABSENT means "never
 * saved", which is what the upgrade rule keys on.
 *
 * Defaults are WooCommerce's option defaults (woo-facts-verified, 11.1.2).
 */
import { normalizeCountryCode, normalizeSubdivision } from "./region-codes.js";
import { isValidTaxLabel } from "./tax-calculator.js";
import type { TaxClassId } from "./types.js";

/** How shipping's tax class is chosen. */
export type ShippingTaxClassSetting =
	/** WooCommerce's "based on cart items" (`inherit`). */
	| { kind: "inherit" }
	/** Otta before 2a: the class of the zone's last rate flagged "applies to
	 *  shipping". Set only for stores that already had rates (DECISIONS 4). */
	| { kind: "legacy" }
	| { kind: "fixed"; taxClassId: TaxClassId };

/** The shop's own address, for "based on shop base address" and digital goods. */
export interface TaxBaseAddress {
	/** ISO 3166-1 alpha-2, uppercased. */
	country: string;
	/** ISO 3166-2 subdivision suffix, or null. */
	region: string | null;
}

export interface TaxSettings {
	/** "Enable tax rates and calculations". */
	enabled: boolean;
	/** Prices are entered with tax. Never applies to shipping costs. */
	pricesIncludeTax: boolean;
	/** "Calculate tax based on" — the customer's shipping address or the shop's. */
	basedOn: "shipping" | "base";
	baseAddress: TaxBaseAddress | null;
	shippingTaxClass: ShippingTaxClassSetting;
	/** Round tax at subtotal level (per class) instead of per line. */
	roundAtSubtotal: boolean;
	/** Cart and checkout show prices with or without tax. */
	displayCart: "excl" | "incl";
	/** Tax totals as one row per tax, or a single row. */
	totalsDisplay: "itemized" | "single";
}

/** What a new store gets: WooCommerce's defaults — tax OFF, and no rates ship. */
export const NEW_STORE_TAX_SETTINGS: TaxSettings = Object.freeze({
	enabled: false,
	pricesIncludeTax: false,
	basedOn: "shipping",
	baseAddress: null,
	shippingTaxClass: Object.freeze({ kind: "inherit" }),
	roundAtSubtotal: false,
	displayCart: "excl",
	totalsDisplay: "itemized",
}) as TaxSettings;

/**
 * What a store that had rates before 2a, and has saved no tax options since,
 * keeps: exactly today's maths and today's single "Tax" row. What customers pay
 * must not change silently (DECISIONS 4).
 */
export const LEGACY_TAX_SETTINGS: TaxSettings = Object.freeze({
	...NEW_STORE_TAX_SETTINGS,
	enabled: true,
	shippingTaxClass: Object.freeze({ kind: "legacy" }),
	totalsDisplay: "single",
}) as TaxSettings;

/** The id a quote with tax switched off records — no calculator was asked. */
export const TAX_DISABLED_CALCULATOR_ID = "otta.tax-disabled";

/**
 * The upgrade rule: a saved block wins; else the store already charges tax ⇒
 * legacy; else a new store. "Already charges tax" is: rates exist, OR an outside
 * calculator is registered (ADR-0030 — such a store has no rates by design).
 */
export function effectiveTaxSettings(
	saved: TaxSettings | undefined,
	hasAnyRate: boolean,
): TaxSettings {
	if (saved !== undefined) return saved;
	return hasAnyRate ? LEGACY_TAX_SETTINGS : NEW_STORE_TAX_SETTINGS;
}

/** A refused field: `field` is the dotted path (`tax.basedOn`). */
export type TaxSettingsProblem = { field: string; message: string };

/**
 * Validate and normalise a block an operator submitted. Every field is required:
 * the block is replaced whole, so an omitted key would silently reset a setting.
 */
export function parseTaxSettings(raw: unknown): TaxSettings | TaxSettingsProblem {
	if (!isRecord(raw)) return problem("tax", "must be an object");
	for (const key of ["enabled", "pricesIncludeTax", "roundAtSubtotal"] as const) {
		if (typeof raw[key] !== "boolean") return problem(`tax.${key}`, "must be true or false");
	}
	const basedOn = oneOf(raw["basedOn"], ["shipping", "base"] as const);
	if (basedOn === undefined) return problem("tax.basedOn", "must be shipping or base");
	const displayCart = oneOf(raw["displayCart"], ["excl", "incl"] as const);
	if (displayCart === undefined) return problem("tax.displayCart", "must be excl or incl");
	const totalsDisplay = oneOf(raw["totalsDisplay"], ["itemized", "single"] as const);
	if (totalsDisplay === undefined) {
		return problem("tax.totalsDisplay", "must be itemized or single");
	}
	const baseAddress = parseBaseAddress(raw["baseAddress"]);
	if (baseAddress === undefined) {
		return problem("tax.baseAddress", "must be null or an ISO country with a valid region");
	}
	const shippingTaxClass = parseShippingTaxClass(raw["shippingTaxClass"]);
	if (shippingTaxClass === undefined) {
		return problem("tax.shippingTaxClass", "must be inherit, legacy, or a fixed tax class");
	}
	return {
		enabled: raw["enabled"] as boolean,
		pricesIncludeTax: raw["pricesIncludeTax"] as boolean,
		basedOn,
		baseAddress,
		shippingTaxClass,
		roundAtSubtotal: raw["roundAtSubtotal"] as boolean,
		displayCart,
		totalsDisplay,
	};
}

/**
 * Read a STORED block: absent, not an object, or with ANY field missing or
 * malformed ⇒ `undefined` (never saved), so the upgrade rule decides. Otta writes
 * the block whole and normalised, so a bad field means a damaged document — and
 * reading it field by field would turn `enabled: "true"` into tax OFF on a store
 * with rates (review 2a B3). Never saved fails toward what the store charged
 * before: rates ⇒ legacy, on.
 */
export function readTaxSettings(raw: unknown): TaxSettings | undefined {
	const parsed = parseTaxSettings(raw);
	return "field" in parsed ? undefined : parsed;
}

/** Two blocks are the same when every field is — compared in one fixed order. */
export function sameTaxSettings(a: TaxSettings, b: TaxSettings): boolean {
	return JSON.stringify(taxSettingsFields(a)) === JSON.stringify(taxSettingsFields(b));
}

function taxSettingsFields(s: TaxSettings): unknown[] {
	const cls = s.shippingTaxClass;
	return [
		s.enabled,
		s.pricesIncludeTax,
		s.basedOn,
		s.baseAddress === null ? null : [s.baseAddress.country, s.baseAddress.region],
		cls.kind === "fixed" ? [cls.kind, cls.taxClassId] : [cls.kind],
		s.roundAtSubtotal,
		s.displayCart,
		s.totalsDisplay,
	];
}

/** `null` is "no base address"; `undefined` is invalid. */
function parseBaseAddress(raw: unknown): TaxBaseAddress | null | undefined {
	if (raw === null) return null;
	if (!isRecord(raw) || typeof raw["country"] !== "string") return undefined;
	const country = normalizeCountryCode(raw["country"]);
	if (country === null) return undefined;
	const regionRaw = raw["region"];
	if (regionRaw !== null && regionRaw !== undefined && typeof regionRaw !== "string") {
		return undefined;
	}
	const region = normalizeSubdivision(country, regionRaw);
	return region.ok ? { country, region: region.code } : undefined;
}

function parseShippingTaxClass(raw: unknown): ShippingTaxClassSetting | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw["kind"] === "inherit") return { kind: "inherit" };
	if (raw["kind"] === "legacy") return { kind: "legacy" };
	const id = raw["taxClassId"];
	// A class id has the bounds of a tax label: 1–200 chars, no control characters.
	if (raw["kind"] === "fixed" && isValidTaxLabel(id) && id.trim() === id) {
		return { kind: "fixed", taxClassId: id };
	}
	return undefined;
}

function oneOf<T extends string>(raw: unknown, options: readonly T[]): T | undefined {
	return typeof raw === "string" && (options as readonly string[]).includes(raw)
		? (raw as T)
		: undefined;
}

function problem(field: string, message: string): TaxSettingsProblem {
	return { field, message: `${field} ${message}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
