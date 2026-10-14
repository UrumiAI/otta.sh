/**
 * Itemized tax rows (issue #422): an order's frozen tax snapshot (ADR-0030) as
 * one display row per tax — the ONE view model behind the buyer's order pages,
 * the order emails and the admin order detail, so the three cannot disagree.
 * Pure: the snapshot in, rows out; formatting money is each surface's own job.
 *
 * WooCommerce's model (`WC_Abstract_Order::get_tax_totals`): one row per tax,
 * product and shipping tax together, shown itemized or as one "Tax" row by
 * `woocommerce_tax_total_display` on the buyer's pages and emails. Otta's
 * snapshot keys each taxed line by its LABEL (one rate per line), so a row is a
 * label; the same grouping the checkout quote uses ({@link itemizeTaxLines}), so
 * the order page shows exactly the rows the buyer saw at checkout.
 */
import type { TaxLine } from "../pricing/tax-calculator.js";
import type { TaxSettings } from "../pricing/tax-settings.js";
import type { OrderTotals } from "./model.js";
import { readOrderTaxSnapshot, type TaxTotalsDisplay } from "./order-tax-snapshot.js";

/** One tax row: its label (merchant or calculator text — render it escaped,
 *  never as HTML) and the tax under it, in integer minor units. */
export interface TaxRow {
	label: string;
	amountCents: number;
}

/**
 * Taxed lines → one row per label, in first-seen order, amounts summed; a zero
 * amount adds no row (an untaxed line, a 0% rate). The checkout quote and the
 * order snapshot both itemize through this.
 */
export function itemizeTaxLines(lines: Iterable<Pick<TaxLine, "label" | "taxCents">>): TaxRow[] {
	const rows: TaxRow[] = [];
	for (const line of lines) {
		if (line.taxCents === 0) continue;
		const row = rows.find((r) => r.label === line.label);
		if (row === undefined) rows.push({ label: line.label, amountCents: line.taxCents });
		else row.amountCents += line.taxCents;
	}
	return rows;
}

/**
 * The order's tax rows, or `null` when the surface must show today's single "Tax"
 * row for `totals.tax`:
 *  - no v1 snapshot — the Phase-4 stub, a malformed value, or a pre-ADR-0030 (v0)
 *    snapshot, which holds amounts but no label to name a row by;
 *  - no tax in it at all;
 *  - a blank label — nothing honest to print as the row's name;
 *  - rows that do not add up to `totals.tax`. They always do for an order this
 *    code wrote (`totals.tax` IS the sum of the snapshot's line and shipping tax;
 *    round-at-subtotal allocates its rounded total back to the lines), so a
 *    mismatch means a record edited by hand. `totals.tax` is authoritative
 *    (ADR-0030), so the rows are DROPPED rather than adjusted: no cent is ever
 *    invented or moved between rows, and no breakdown is shown that contradicts
 *    the total the buyer paid.
 */
export function orderTaxRows(totals: Pick<OrderTotals, "tax" | "taxBreakdown">): TaxRow[] | null {
	const snapshot = readOrderTaxSnapshot(totals.taxBreakdown);
	if (snapshot === null || snapshot.v !== 1) return null;
	const rows = itemizeTaxLines(
		snapshot.shipping === null ? snapshot.lines : [...snapshot.lines, snapshot.shipping],
	);
	if (rows.length === 0) return null;
	if (rows.some((r) => r.label.trim().length === 0)) return null;
	const sum = rows.reduce((s, r) => s + r.amountCents, 0);
	return sum === totals.tax ? rows : null;
}

/**
 * Whether the buyer's surfaces show the rows or one "Tax" row: the saved
 * "Display tax totals" option (ADR-0032). Nothing saved ⇒ "single": an order with
 * tax to itemize was charged by a store that already charged tax, which the
 * upgrade rule (`effectiveTaxSettings`) keeps on today's single row. (The admin
 * always itemizes, as WooCommerce's order screen does — the merchant files by it.)
 */
export function taxTotalsDisplayOf(saved: TaxSettings | undefined): "itemized" | "single" {
	return saved?.totalsDisplay ?? "single";
}

/**
 * The "Display tax totals" the order was placed under (#478), frozen on its v1
 * snapshot, or `undefined` for an order placed before it was recorded (or with
 * no v1 snapshot) — the caller then falls back to the live option
 * ({@link taxTotalsDisplayOf}), today's behaviour for those orders.
 */
export function recordedTaxTotalsDisplay(
	totals: Pick<OrderTotals, "taxBreakdown">,
): TaxTotalsDisplay | undefined {
	const snapshot = readOrderTaxSnapshot(totals.taxBreakdown);
	return snapshot?.v === 1 ? snapshot.totalsDisplay : undefined;
}
