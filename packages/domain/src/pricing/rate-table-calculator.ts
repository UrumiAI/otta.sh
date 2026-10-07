import { type Cents, cents } from "../money/cents.js";
import type { TaxRate, TaxRulesStore } from "../ports/tax-rules-store.js";
import { allocateCents } from "./allocate.js";
import { mulDivRoundHalfUpAny } from "./round.js";
import { computeLineTax } from "./tax.js";
import {
	isValidTaxLabel,
	TAX_RATE_BPS_MAX,
	type TaxCalculator,
	type TaxLine,
	type TaxRequest,
	type TaxResult,
} from "./tax-calculator.js";
import type { ShippingTaxClassSetting } from "./tax-settings.js";
import type { TaxClassId } from "./types.js";

/** The built-in calculator's id, recorded on every order it prices. */
export const RATE_TABLE_CALCULATOR_ID = "otta.rate-table";

/** One zone's rates, reduced to what the arithmetic reads. */
export interface RateTable {
	ratesByClass: ReadonlyMap<TaxClassId, number>;
	/** Whether any rate in the zone applies to shipping. */
	shippingTaxable: boolean;
	/** The class whose rate taxes shipping (the LAST flagged rate's). */
	shippingTaxClassId: TaxClassId;
	/** Per class, whether ITS rate (the one in `ratesByClass`) applies to
	 *  shipping. Read only by the "inherit"/"fixed" rules; absent ⇒ none does. */
	shipsByClass?: ReadonlyMap<TaxClassId, boolean>;
}

/** The store's tax options the built-in applies (ADR-0031). Omitted ⇒ main's maths. */
export interface RateTableOptions {
	/** Default `legacy`: the class of the zone's last shipping-flagged rate. */
	shippingTaxClass?: ShippingTaxClassSetting;
	/** Round per class over the lines' sum, then allocate back; default per line. */
	roundAtSubtotal?: boolean;
}

/**
 * The zone's rates as main has always read them: in the store's order (the
 * emdash store lists by id ascending), each rate overwrites its class — so with
 * duplicate (class, zone) rates the LAST listed wins — and the last
 * shipping-flagged rate names the shipping tax class (default `standard`).
 * Pinned, not fixed, by PR 1: see the ADR's follow-ups.
 */
export function rateTableOf(zoneRates: readonly TaxRate[]): RateTable {
	const ratesByClass = new Map<TaxClassId, number>();
	const shipsByClass = new Map<TaxClassId, boolean>();
	let shippingTaxable = false;
	let shippingTaxClassId: TaxClassId = "standard";
	for (const r of zoneRates) {
		ratesByClass.set(r.taxClassId, r.rateBps);
		shipsByClass.set(r.taxClassId, r.appliesToShipping);
		if (r.appliesToShipping) {
			shippingTaxable = true;
			shippingTaxClassId = r.taxClassId;
		}
	}
	return { ratesByClass, shippingTaxable, shippingTaxClassId, shipsByClass };
}

/**
 * The rate-table arithmetic. Each line at its class's rate (no rate ⇒ 0%, never
 * a refusal — WooCommerce's rule):
 *  - prices WITHOUT tax: `round_half_up(amount × bps / 10000)` (main's maths);
 *  - prices WITH tax: the tax inside the gross, `round_half_up(G × bps / (10000 + bps))`;
 *  - at subtotal: the same formula once per class over the class's summed amount,
 *    allocated back to its lines by amount (largest remainder).
 * Shipping is ALWAYS entered without tax (WooCommerce, woo-facts-verified Q1), at
 * the class the shipping-tax-class setting picks. `labels` maps a class to its
 * display name; a class without a usable one is labelled by its id.
 */
export function applyRateTable(
	request: TaxRequest,
	table: RateTable,
	labels: ReadonlyMap<TaxClassId, string>,
	options: RateTableOptions = {},
): TaxResult {
	const rateOf = (classId: TaxClassId) => table.ratesByClass.get(classId) ?? 0;
	// The tax is computed at the STORED rate; only the display rate is capped, so a
	// rate written outside the admin (> 1000%) still charges as before.
	const lineOf = (classId: TaxClassId, taxCents: Cents): TaxLine => ({
		rateBps: Math.min(rateOf(classId), TAX_RATE_BPS_MAX),
		label: labelOf(classId, labels),
		taxCents,
	});
	const taxes = lineTaxes(request, rateOf, options.roundAtSubtotal === true);
	const shippingClass = shippingTaxClassOf(request, table, labels, options.shippingTaxClass);
	const shipping: TaxLine | null =
		shippingClass !== null && request.shipping !== null
			? lineOf(shippingClass, computeLineTax(request.shipping.amountCents, rateOf(shippingClass)))
			: null;
	return {
		ok: true,
		currency: request.currency,
		lines: request.lines.map((l, i) => ({
			lineId: l.lineId,
			...lineOf(l.taxClassId, taxes[i] as Cents),
		})),
		shipping,
	};
}

function taxOn(amount: number, rateBps: number, inclusive: boolean): Cents {
	return inclusive
		? cents(mulDivRoundHalfUpAny(amount, rateBps, 10_000 + rateBps))
		: computeLineTax(cents(amount), rateBps);
}

function lineTaxes(
	request: TaxRequest,
	rateOf: (classId: TaxClassId) => number,
	roundAtSubtotal: boolean,
): Cents[] {
	const inclusive = request.pricesIncludeTax;
	if (!roundAtSubtotal) {
		return request.lines.map((l) => taxOn(l.amountCents, rateOf(l.taxClassId), inclusive));
	}
	const out: Cents[] = request.lines.map(() => cents(0));
	const byClass = new Map<TaxClassId, number[]>();
	request.lines.forEach((l, i) => {
		const group = byClass.get(l.taxClassId);
		if (group === undefined) byClass.set(l.taxClassId, [i]);
		else group.push(i);
	});
	for (const [classId, indexes] of byClass) {
		const amounts: number[] = indexes.map((i) => request.lines[i]?.amountCents ?? 0);
		const total = taxOn(
			amounts.reduce((a, b) => a + b, 0),
			rateOf(classId),
			inclusive,
		);
		allocateCents(total, amounts).forEach((t, k) => {
			out[indexes[k] as number] = t;
		});
	}
	return out;
}

/** The class whose rate taxes shipping, or null ⇒ shipping is untaxed. */
function shippingTaxClassOf(
	request: TaxRequest,
	table: RateTable,
	labels: ReadonlyMap<TaxClassId, string>,
	setting: ShippingTaxClassSetting = { kind: "legacy" },
): TaxClassId | null {
	if (setting.kind === "legacy") {
		return table.shippingTaxable ? table.shippingTaxClassId : null;
	}
	const classId =
		setting.kind === "fixed" ? setting.taxClassId : inheritShippingTaxClass(request.lines, labels);
	// WooCommerce finds only rates flagged "shipping" for the class (`find_shipping_rates`).
	return classId !== null && table.shipsByClass?.get(classId) === true ? classId : null;
}

/**
 * WooCommerce's "shipping tax class based on cart items"
 * (`WC_Tax::get_shipping_tax_class_from_cart_items`, woo-facts-verified Q2). Only
 * lines that ship AND are taxable or shipping-only count:
 *  - none ⇒ null (no shipping tax);
 *  - any in `standard` ⇒ `standard`;
 *  - one class ⇒ that class;
 *  - else the first by class NAME (WooCommerce's `ORDER BY name`) among the
 *    declared classes (`names`), falling back to `standard`.
 */
export function inheritShippingTaxClass(
	lines: TaxRequest["lines"],
	names: ReadonlyMap<TaxClassId, string>,
): TaxClassId | null {
	const found = new Set<TaxClassId>();
	for (const l of lines) {
		if (l.requiresShipping && l.taxStatus !== "none") found.add(l.taxClassId);
	}
	if (found.size === 0) return null;
	if (found.has("standard")) return "standard";
	if (found.size === 1) return [...found][0] as TaxClassId;
	const ordered = [...names].toSorted(([idA, a], [idB, b]) =>
		a === b ? (idA < idB ? -1 : 1) : a < b ? -1 : 1,
	);
	return ordered.find(([id]) => found.has(id))?.[0] ?? "standard";
}

function labelOf(classId: TaxClassId, labels: ReadonlyMap<TaxClassId, string>): string {
	const name = labels.get(classId);
	if (isValidTaxLabel(name)) return name;
	return isValidTaxLabel(classId) ? classId : "Tax";
}

/**
 * The built-in `otta.rate-table` calculator over the merchant's tax rules. It
 * reads the matched zone's rates and the class names (for labels) — nothing at
 * all when no zone matched (a digital-only cart, or no zones configured), which
 * is then untaxed, exactly as before.
 */
export function createRateTableCalculator(
	taxRules: TaxRulesStore,
	options: RateTableOptions = {},
): TaxCalculator {
	return {
		id: RATE_TABLE_CALCULATOR_ID,
		async calculate(request) {
			if (request.zoneId === null) {
				return applyRateTable(request, rateTableOf([]), new Map(), options);
			}
			const [zoneRates, classes] = await Promise.all([
				taxRules.listRatesForZone(request.zoneId),
				taxRules.listClasses(),
			]);
			return applyRateTable(
				request,
				rateTableOf(zoneRates),
				new Map(classes.map((c) => [c.id, c.name])),
				options,
			);
		},
	};
}
