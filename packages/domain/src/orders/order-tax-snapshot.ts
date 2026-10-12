import type { Cents } from "../money/cents.js";
import { isProductTaxStatus, type ProductTaxStatus } from "../ports/product-commerce-store.js";
import type { TaxLine, TaxResult } from "../pricing/tax-calculator.js";
import { finerRatePpm } from "../pricing/tax-rate-precision.js";
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
	/**
	 * The tax was really calculated for a place (ADR-0032): a tax location matched
	 * a zone — the shipping zone, or the shop base address for a digital-only cart
	 * or a "based on the shop" store, which leaves the order with no shipping zone —
	 * or an outside calculator charged tax with no zone at all (#436).
	 * Written by every order since; ABSENT on a v1 snapshot written before it, which
	 * reads as not located, so those orders keep deciding "was tax calculated?" off
	 * the shipping zone alone, exactly as before.
	 */
	located?: boolean;
	/**
	 * One per order line, in order-line order (`lineIndex` indexes `order.lines`).
	 * A line (and `shipping`) taxed at a rate finer than a basis point also records
	 * that exact rate as `ratePpm` (#425, `TaxLine`); `rateBps` keeps its meaning,
	 * so a snapshot written before — which never has `ratePpm` — reads unchanged.
	 */
	lines: Array<
		{
			lineIndex: number;
			taxClassId: string;
			/**
			 * The product's tax status at checkout (#427), so the order can still
			 * explain why the line was or was not taxed after the product changes.
			 * Written by every order since; ABSENT on a line written before it (or
			 * holding a value this reader does not know), which reads as unknown —
			 * never guessed as "taxable".
			 */
			taxStatus?: ProductTaxStatus;
			taxableCents: Cents;
		} & TaxLine
	>;
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
	/** The quote's `taxLocated`: a tax location matched a zone, or tax was charged without one. */
	located: boolean,
	/** Each line's product tax status, as the calculator was asked (line order). */
	taxStatuses: readonly ProductTaxStatus[],
): OrderTaxSnapshotV1 {
	return {
		v: 1,
		calculatorId: tax.calculatorId,
		pricesIncludeTax: tax.pricesIncludeTax === true,
		located,
		lines: breakdown.lineBreakdown.map((line, lineIndex) => {
			const answered = tax.result.lines[lineIndex];
			if (answered === undefined) throw new RangeError(`no tax line for line ${String(lineIndex)}`);
			const taxStatus = taxStatuses[lineIndex];
			if (taxStatus === undefined) {
				throw new RangeError(`no tax status for line ${String(lineIndex)}`);
			}
			return {
				lineIndex,
				taxClassId: line.taxClassId,
				taxStatus,
				taxableCents: line.discountedCents,
				rateBps: answered.rateBps,
				...ratePpmOf(answered),
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
						...ratePpmOf(tax.result.shipping),
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
	const { calculatorId, pricesIncludeTax, located, lines, shipping } = raw;
	if (typeof calculatorId !== "string" || typeof pricesIncludeTax !== "boolean") return null;
	// Optional: a snapshot from before the field omits it (read as not located).
	if (located !== undefined && typeof located !== "boolean") return null;
	if (!Array.isArray(lines)) return null;
	const out: OrderTaxSnapshotV1["lines"] = [];
	for (const item of lines as unknown[]) {
		if (!isRecord(item) || !isCount(item["lineIndex"]) || typeof item["taxClassId"] !== "string") {
			return null;
		}
		// Optional and display-only (#427): a line from before the field omits it,
		// and a value this code does not know (a future status, read after a
		// rollback) is DROPPED — the line reads as unknown — rather than nulling a
		// snapshot the storefront, account pages and emails still lay tax out from.
		const rawStatus = item["taxStatus"];
		const taxStatus = isProductTaxStatus(rawStatus) ? rawStatus : undefined;
		const line = taxedOf(item);
		if (line === null) return null;
		out.push({
			lineIndex: item["lineIndex"],
			taxClassId: item["taxClassId"],
			...(taxStatus !== undefined ? { taxStatus } : {}),
			...line,
		});
	}
	let ship: OrderTaxSnapshotV1["shipping"] = null;
	if (shipping !== null) {
		if (!isRecord(shipping)) return null;
		ship = taxedOf(shipping);
		if (ship === null) return null;
	}
	return {
		v: 1,
		calculatorId,
		pricesIncludeTax,
		...(located !== undefined ? { located } : {}),
		lines: out,
		shipping: ship,
	};
}

/** A line's exact rate (#425), only when it has one: a snapshot of a whole-bps
 *  rate — and every snapshot written before #425 — carries no `ratePpm` key. */
function ratePpmOf(line: TaxLine): { ratePpm?: number } {
	return line.ratePpm === undefined ? {} : { ratePpm: line.ratePpm };
}

function taxedOf(item: Record<string, unknown>): ({ taxableCents: Cents } & TaxLine) | null {
	const { taxableCents, rateBps, ratePpm, label, taxCents } = item;
	if (!isCount(taxableCents) || !isCount(rateBps) || !isCount(taxCents)) return null;
	if (typeof label !== "string") return null;
	// Only a consistent finer rate is part of the line (the store's own rule, #425);
	// anything else under that key is ignored, as an unknown key always was.
	const finer = finerRatePpm({ rateBps, ratePpm });
	return {
		taxableCents: taxableCents as Cents,
		rateBps,
		...(finer === undefined ? {} : { ratePpm: finer }),
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
