import type { TaxRate, TaxRulesStore } from "../ports/tax-rules-store.js";
import { computeLineTax } from "./tax.js";
import { effectiveTaxRates } from "./tax-rate-uniqueness.js";
import {
	isValidTaxLabel,
	TAX_RATE_BPS_MAX,
	type TaxCalculator,
	type TaxLine,
	type TaxRequest,
	type TaxResult,
} from "./tax-calculator.js";
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
}

/**
 * The zone's rates as main has always read them: in the store's order (the
 * emdash store lists by id ascending), each rate sets its class, and the last
 * shipping-flagged rate names the shipping tax class (default `standard`).
 * Duplicate (class, zone) rates written before the store refused them are
 * reduced first to the one that applies (`effectiveTaxRates`: the greatest id —
 * the rate the last-listed overwrite always charged), so an ignored duplicate is
 * ignored entirely, its shipping flag included, exactly as the admin shows it.
 */
export function rateTableOf(zoneRates: readonly TaxRate[]): RateTable {
	const ratesByClass = new Map<TaxClassId, number>();
	let shippingTaxable = false;
	let shippingTaxClassId: TaxClassId = "standard";
	for (const r of effectiveTaxRates(zoneRates)) {
		ratesByClass.set(r.taxClassId, r.rateBps);
		if (r.appliesToShipping) {
			shippingTaxable = true;
			shippingTaxClassId = r.taxClassId;
		}
	}
	return { ratesByClass, shippingTaxable, shippingTaxClassId };
}

/**
 * The rate-table arithmetic: each line `round_half_up(amount × bps / 10000)` at
 * its class's rate (no rate ⇒ 0%, never a refusal — WooCommerce's rule), and the
 * shipping charge the same way at the shipping class's rate when the zone taxes
 * shipping. `labels` maps a class to its display name; a class without a usable
 * one is labelled by its id.
 */
export function applyRateTable(
	request: TaxRequest,
	table: RateTable,
	labels: ReadonlyMap<TaxClassId, string>,
): TaxResult {
	const lineOf = (classId: TaxClassId, amount: TaxRequest["lines"][number]["amountCents"]) => {
		const rateBps = table.ratesByClass.get(classId) ?? 0;
		// The tax is main's arithmetic at the STORED rate; only the display rate is
		// capped, so a rate written outside the admin (> 1000%) still charges as before.
		return {
			rateBps: Math.min(rateBps, TAX_RATE_BPS_MAX),
			label: labelOf(classId, labels),
			taxCents: computeLineTax(amount, rateBps),
		};
	};
	const shipping: TaxLine | null =
		table.shippingTaxable && request.shipping !== null
			? lineOf(table.shippingTaxClassId, request.shipping.amountCents)
			: null;
	return {
		ok: true,
		currency: request.currency,
		lines: request.lines.map((l) => ({ lineId: l.lineId, ...lineOf(l.taxClassId, l.amountCents) })),
		shipping,
	};
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
export function createRateTableCalculator(taxRules: TaxRulesStore): TaxCalculator {
	return {
		id: RATE_TABLE_CALCULATOR_ID,
		async calculate(request) {
			if (request.zoneId === null) {
				return applyRateTable(request, rateTableOf([]), new Map());
			}
			const [zoneRates, classes] = await Promise.all([
				taxRules.listRatesForZone(request.zoneId),
				taxRules.listClasses(),
			]);
			return applyRateTable(
				request,
				rateTableOf(zoneRates),
				new Map(classes.map((c) => [c.id, c.name])),
			);
		},
	};
}
