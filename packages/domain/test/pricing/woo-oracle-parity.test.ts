import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import { allocateCents } from "../../src/pricing/allocate.js";
import { applyRateTable, rateTableOf } from "../../src/pricing/rate-table-calculator.js";
import type { TaxRequest } from "../../src/pricing/tax-calculator.js";
import type { ShippingTaxClassSetting } from "../../src/pricing/tax-settings.js";

/**
 * The built-in calculator against an INDEPENDENT WooCommerce answer key: 39
 * scenarios computed from WooCommerce 11.1.2 source (commit 2316335b) without
 * reading Otta (`reports/global-tax/woo-oracle.md`). Every in-scope scenario must
 * match, except the divergences listed in {@link KNOWN_DIVERGENCES}.
 *
 * The coupon scenarios feed WooCommerce's OWN per-line discount (`expected.lines[].discount`)
 * to the calculator: Otta's coupon allocation is a different, unchanged rule (pinned below).
 */
interface OracleItem {
	unit_cents: number;
	qty: number;
	tax_class: string;
	tax_status: "taxable" | "shipping" | "none";
	needs_shipping: boolean;
}
interface OracleScenario {
	id: string;
	kind: string;
	inputs: {
		prices_include_tax: boolean;
		round_at_subtotal: boolean;
		shipping_tax_class_option: string;
		tax_classes: Record<string, { name: string; rate_bps: number }>;
		items: OracleItem[];
		shipping: { cost_cents: number; method_taxable: boolean } | null;
		coupon: unknown;
	};
	expected: {
		lines: Array<{ discount: number; line_tax: number | string }>;
		shipping_tax: number | string;
		total_tax: number;
		grand_total: number;
	};
}

const ORACLE = JSON.parse(
	readFileSync(new URL("./fixtures/woo-oracle-11.1.2.json", import.meta.url), "utf8"),
) as OracleScenario[];

/** Out of scope, so not run: shop-page price display (a follow-up, DECISIONS 6). */
const OUT_OF_SCOPE: Record<string, string> = {
	"DP-01": "shop-page price display (follow-up)",
	"DP-02": "shop-page price display (follow-up)",
};

/**
 * Where Otta deliberately differs. RD-07: rounding at subtotal, WooCommerce rounds
 * the GRAND total once from unrounded parts (725) while its tax total rounds the
 * shipping tax on its own (120); Otta keeps `subtotal − discount + shipping + tax =
 * total` exact, so its total is 102 + 502 + 120 = 724.
 */
const KNOWN_DIVERGENCES: Record<string, { grand_total: number }> = {
	"RD-07": { grand_total: 724 },
};

/** WooCommerce's product `tax_status` → Otta's (PR 2b). */
const TAX_STATUS = { taxable: "taxable", shipping: "shipping_only", none: "none" } as const;

/** WooCommerce's standard class is "" — Otta's is `standard`. */
const classId = (woo: string) => (woo === "" ? "standard" : woo);

function run(s: OracleScenario) {
	const { inputs, expected } = s;
	const lines = inputs.items.map((item, i) => {
		const gross = item.unit_cents * item.qty;
		return {
			lineId: String(i),
			quantity: item.qty,
			unitPriceCents: cents(item.unit_cents),
			amountCents: cents(gross - (expected.lines[i]?.discount ?? 0)),
			taxClassId: classId(item.tax_class),
			taxStatus: TAX_STATUS[item.tax_status],
			requiresShipping: item.needs_shipping,
		};
	});
	const request: TaxRequest = {
		purpose: "quote",
		currency: currency("USD"),
		pricesIncludeTax: inputs.prices_include_tax,
		lines,
		// A method that is not taxable is asked about as no shipping at all (quote.ts).
		shipping:
			inputs.shipping === null || !inputs.shipping.method_taxable
				? null
				: { amountCents: cents(inputs.shipping.cost_cents), methodId: "m" },
		origin: null,
		destination: null,
		zoneId: "z",
	};
	// One rate per class, every rate flagged for shipping (the oracle's assumption).
	const table = rateTableOf(
		Object.entries(inputs.tax_classes).map(([id, c]) => ({
			id: `r-${classId(id)}`,
			taxClassId: classId(id),
			zoneId: "z",
			rateBps: c.rate_bps,
			appliesToShipping: true,
		})),
	);
	const names = new Map(Object.entries(inputs.tax_classes).map(([id, c]) => [classId(id), c.name]));
	const shippingTaxClass: ShippingTaxClassSetting =
		inputs.shipping_tax_class_option === "inherit"
			? { kind: "inherit" }
			: { kind: "fixed", taxClassId: classId(inputs.shipping_tax_class_option) };
	const result = applyRateTable(request, table, names, {
		shippingTaxClass,
		roundAtSubtotal: inputs.round_at_subtotal,
	});
	const lineTax = result.lines.reduce((sum, l) => sum + l.taxCents, 0);
	const shippingTax = result.shipping?.taxCents ?? 0;
	const amounts = lines.reduce((sum, l) => sum + l.amountCents, 0);
	const shippingCost = inputs.shipping?.cost_cents ?? 0;
	return {
		lineTaxes: result.lines.map((l) => l.taxCents),
		shippingTax,
		totalTax: lineTax + shippingTax,
		grandTotal: inputs.prices_include_tax
			? amounts + shippingCost + shippingTax
			: amounts + shippingCost + lineTax + shippingTax,
	};
}

describe("the built-in calculator against WooCommerce 11.1.2 (independent oracle)", () => {
	const inScope = ORACLE.filter((s) => !(s.id in OUT_OF_SCOPE));

	test("the oracle holds 39 scenarios, 37 of them in scope", () => {
		expect(ORACLE).toHaveLength(39);
		expect(inScope).toHaveLength(37);
	});

	test.each(inScope.map((s) => [s.id, s] as const))("%s", (_id, s) => {
		const got = run(s);
		expect(got.totalTax).toBe(s.expected.total_tax);
		expect(got.grandTotal).toBe(KNOWN_DIVERGENCES[s.id]?.grand_total ?? s.expected.grand_total);
		// The shipping tax always rounds half up on its own, in either rounding mode.
		expect(got.shippingTax).toBe(Math.round(Number(s.expected.shipping_tax)));
		// Per line, each line's tax is WooCommerce's; at subtotal WooCommerce keeps no
		// rounded line figure, so only the totals above are compared.
		if (!s.inputs.round_at_subtotal) {
			expect(got.lineTaxes).toEqual(s.expected.lines.map((l) => Number(l.line_tax)));
		}
	});
});

/**
 * Not a parity claim: Otta's coupon allocation is unchanged by 2a (pro rata over
 * line subtotals, largest remainder), and WooCommerce's is per unit, highest price
 * first. Pinned so the difference is visible.
 */
describe("coupon cent distribution — Otta vs WooCommerce (reported, not changed)", () => {
	test("EX-07 (10% of 1999 + 2×1001): WooCommerce 200/200; Otta 200/200", () => {
		const lineSubtotals = [1999, 2002];
		const discount = Math.round((4001 * 1000) / 10_000); // 400 (computeCouponDiscount: half up)
		const after = allocateCents(cents(4001 - discount), lineSubtotals);
		expect(lineSubtotals.map((l, i) => l - (after[i] ?? 0))).toEqual([200, 200]);
	});

	test("EX-08 (fixed 1000 over 2000 + 2×1000): WooCommerce 334/666; Otta 500/500", () => {
		const lineSubtotals = [2000, 2000];
		const after = allocateCents(cents(4000 - 1000), lineSubtotals);
		// Otta allocates the DISCOUNTED subtotal 3000 pro rata → 1500/1500 ⇒ 500/500
		expect(lineSubtotals.map((l, i) => l - (after[i] ?? 0))).toEqual([500, 500]);
	});
});
