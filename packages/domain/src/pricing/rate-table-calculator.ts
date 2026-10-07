import { type Cents, cents } from "../money/cents.js";
import type { TaxRate, TaxRulesStore } from "../ports/tax-rules-store.js";
import { allocateCents } from "./allocate.js";
import { mulDivRoundHalfDownAny } from "./round.js";
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
 *  - prices WITH tax: the tax inside the gross, `round_half_down(G × bps / (10000 + bps))`
 *    (WooCommerce's rounding for tax-inclusive stores — see {@link taxOn});
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

/**
 * One line's tax. Prices WITHOUT tax round half UP (main's maths). Prices WITH tax
 * round the tax inside the gross half DOWN — WooCommerce's `WC_TAX_ROUNDING_MODE`
 * for tax-inclusive stores (woo-oracle IN-02: 999 at 20% → 166), which is what
 * keeps `net + tax = gross` with the net rounded half up.
 */
function taxOn(amount: number, rateBps: number, inclusive: boolean): Cents {
	return inclusive
		? cents(mulDivRoundHalfDownAny(amount, rateBps, 10_000 + rateBps))
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
	return taxRoundedAtSubtotal(request, rateOf, inclusive);
}

/**
 * WooCommerce's "round tax at subtotal level": the lines' EXACT taxes, across every
 * class, are summed and rounded ONCE (half up, or half down for prices with tax).
 * The rounded total is then split back so the per-line figures still add up: to
 * the classes by largest remainder of their exact tax (ties by first line), then
 * within a class by line amount. All in exact integer arithmetic.
 */
function taxRoundedAtSubtotal(
	request: TaxRequest,
	rateOf: (classId: TaxClassId) => number,
	inclusive: boolean,
): Cents[] {
	const classes = new Map<TaxClassId, number[]>();
	request.lines.forEach((l, i) => {
		const group = classes.get(l.taxClassId);
		if (group === undefined) classes.set(l.taxClassId, [i]);
		else group.push(i);
	});
	const groups = [...classes].map(([classId, indexes]) => {
		const amounts: number[] = indexes.map((i) => request.lines[i]?.amountCents ?? 0);
		const rate = BigInt(rateOf(classId));
		const num = BigInt(amounts.reduce((a, b) => a + b, 0)) * rate;
		const den = inclusive ? 10_000n + rate : 10_000n;
		return { indexes, amounts, num, den, floor: num / den, rem: num % den };
	});
	// Σ num/den over a common denominator, rounded once.
	const common = groups.reduce((l, g) => (l % g.den === 0n ? l : l * g.den), 1n);
	const sum = groups.reduce((n, g) => n + g.num * (common / g.den), 0n);
	const rounded = inclusive
		? (2n * sum + common - 1n) / (2n * common)
		: (2n * sum + common) / (2n * common);
	let extra = rounded - groups.reduce((n, g) => n + g.floor, 0n);
	const byRemainder = groups
		.map((g, order) => ({ g, order }))
		.toSorted((a, b) => {
			const diff = b.g.rem * a.g.den - a.g.rem * b.g.den;
			return diff > 0n ? 1 : diff < 0n ? -1 : a.order - b.order;
		});
	const classTax = new Map<(typeof groups)[number], bigint>();
	for (const { g } of byRemainder) {
		const bump = extra > 0n && g.rem > 0n ? 1n : 0n;
		extra -= bump;
		classTax.set(g, g.floor + bump);
	}
	const out: Cents[] = request.lines.map(() => cents(0));
	for (const g of groups) {
		allocateCents(cents(Number(classTax.get(g) ?? 0n)), g.amounts).forEach((t, k) => {
			out[g.indexes[k] as number] = t;
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
 *    declared classes (`names`), falling back to `standard`. Names compare
 *    case-insensitively, as MySQL's default collation does; names equal but for
 *    case go to the lower id, so the pick never depends on listing order.
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
	const ordered = [...names].toSorted(([idA, a], [idB, b]) => {
		const la = a.toLowerCase();
		const lb = b.toLowerCase();
		if (la !== lb) return la < lb ? -1 : 1;
		return idA < idB ? -1 : idA > idB ? 1 : 0;
	});
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
 *
 * A FIXED shipping tax class that is not among the store's classes (never
 * existed, or deleted since) falls back to "based on cart items" rather than
 * silently untaxing shipping (ADR-0031 §5): the cart's own classes pick, so
 * shipping is taxed whenever a shipping line's class has a flagged rate.
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
			const names = new Map(classes.map((c) => [c.id, c.name]));
			const setting = options.shippingTaxClass;
			const effective: RateTableOptions =
				setting?.kind === "fixed" && !names.has(setting.taxClassId)
					? { ...options, shippingTaxClass: { kind: "inherit" } }
					: options;
			return applyRateTable(request, rateTableOf(zoneRates), names, effective);
		},
	};
}
