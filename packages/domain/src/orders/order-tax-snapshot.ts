import type { Cents } from "../money/cents.js";
import type { TaxLine, TaxResult } from "../pricing/tax-calculator.js";
import type { TotalsBreakdown } from "../pricing/types.js";

/**
 * The tax an order was charged, frozen into `order_totals.taxBreakdown` ONCE at
 * creation (ADR-0030) and never recomputed: a later rate edit, class rename or
 * calculator change never rewrites an existing order. `totals.tax` stays the
 * authoritative total for every order.
 */
export interface OrderTaxSnapshotV1 {
	v: 1;
	/** Which calculator priced it: `otta.rate-table`, or a registered one's id. */
	calculatorId: string;
	pricesIncludeTax: boolean;
	/** One per order line, in order-line order (`lineIndex` indexes `order.lines`). */
	lines: Array<{ lineIndex: number; taxClassId: string; taxableCents: Cents } & TaxLine>;
	shipping: ({ taxableCents: Cents } & TaxLine) | null;
}

/** An order written before ADR-0030: amounts only — no rate, label or calculator. */
export interface OrderTaxSnapshotV0 {
	v: 0;
	calculatorId: "legacy";
	lines: Array<{
		lineIndex: number;
		taxClassId: string;
		taxableCents: Cents;
		taxCents: Cents;
		rateBps: null;
		label: null;
	}>;
	shippingTaxCents: Cents;
}

export type OrderTaxSnapshot = OrderTaxSnapshotV1 | OrderTaxSnapshotV0;

/** The v1 snapshot for an order priced by `breakdown`, from the calculator's answer. */
export function buildOrderTaxSnapshot(
	breakdown: TotalsBreakdown,
	tax: { calculatorId: string; result: TaxResult; pricesIncludeTax?: boolean },
): OrderTaxSnapshotV1 {
	return {
		v: 1,
		calculatorId: tax.calculatorId,
		pricesIncludeTax: tax.pricesIncludeTax === true,
		lines: breakdown.lineBreakdown.map((line, lineIndex) => {
			const answered = tax.result.lines[lineIndex];
			if (answered === undefined) throw new RangeError(`no tax line for line ${String(lineIndex)}`);
			return {
				lineIndex,
				taxClassId: line.taxClassId,
				taxableCents: line.discountedCents,
				rateBps: answered.rateBps,
				label: answered.label,
				taxCents: answered.taxCents,
			};
		}),
		shipping:
			tax.result.shipping === null
				? null
				: {
						taxableCents: breakdown.shippingCents,
						rateBps: tax.result.shipping.rateBps,
						label: tax.result.shipping.label,
						taxCents: tax.result.shipping.taxCents,
					},
	};
}

/**
 * Read a stored `taxBreakdown`, whatever its age: a v1 snapshot as written; the
 * pre-ADR-0030 shape `{lines:[{taxClassId,discountedCents,taxCents}],
 * shippingTaxCents}` as v0 (rate and label `null` — never guessed); `null`
 * (the Phase-4 stub) or anything malformed as `null`.
 */
export function readOrderTaxSnapshot(raw: unknown): OrderTaxSnapshot | null {
	if (!isRecord(raw)) return null;
	if (raw["v"] === 1) return readV1(raw);
	if (!("v" in raw)) return readLegacy(raw);
	return null;
}

function readV1(raw: Record<string, unknown>): OrderTaxSnapshotV1 | null {
	const { calculatorId, pricesIncludeTax, lines, shipping } = raw;
	if (typeof calculatorId !== "string" || typeof pricesIncludeTax !== "boolean") return null;
	if (!Array.isArray(lines)) return null;
	const out: OrderTaxSnapshotV1["lines"] = [];
	for (const item of lines as unknown[]) {
		if (!isRecord(item) || !isCount(item["lineIndex"]) || typeof item["taxClassId"] !== "string") {
			return null;
		}
		const line = taxedOf(item);
		if (line === null) return null;
		out.push({ lineIndex: item["lineIndex"], taxClassId: item["taxClassId"], ...line });
	}
	let ship: OrderTaxSnapshotV1["shipping"] = null;
	if (shipping !== null) {
		if (!isRecord(shipping)) return null;
		ship = taxedOf(shipping);
		if (ship === null) return null;
	}
	return { v: 1, calculatorId, pricesIncludeTax, lines: out, shipping: ship };
}

function taxedOf(item: Record<string, unknown>): ({ taxableCents: Cents } & TaxLine) | null {
	const { taxableCents, rateBps, label, taxCents } = item;
	if (!isCount(taxableCents) || !isCount(rateBps) || !isCount(taxCents)) return null;
	if (typeof label !== "string") return null;
	return {
		taxableCents: taxableCents as Cents,
		rateBps,
		label,
		taxCents: taxCents as Cents,
	};
}

function readLegacy(raw: Record<string, unknown>): OrderTaxSnapshotV0 | null {
	const { lines, shippingTaxCents } = raw;
	if (!Array.isArray(lines) || !isCount(shippingTaxCents)) return null;
	const out: OrderTaxSnapshotV0["lines"] = [];
	for (const [lineIndex, item] of (lines as unknown[]).entries()) {
		if (!isRecord(item) || typeof item["taxClassId"] !== "string") return null;
		const { discountedCents, taxCents } = item;
		if (!isCount(discountedCents) || !isCount(taxCents)) return null;
		out.push({
			lineIndex,
			taxClassId: item["taxClassId"],
			taxableCents: discountedCents as Cents,
			taxCents: taxCents as Cents,
			rateBps: null,
			label: null,
		});
	}
	return { v: 0, calculatorId: "legacy", lines: out, shippingTaxCents: shippingTaxCents as Cents };
}

/** A safe non-negative integer. */
function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
