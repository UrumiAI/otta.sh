import { type Cents, cents, type Currency } from "../money/cents.js";
import { allocateCents } from "./allocate.js";
import { computeCouponDiscount } from "./coupon.js";
import { applyRateTable } from "./rate-table-calculator.js";
import { resolveShippingRate } from "./shipping.js";
import type { TaxRequestLine, TaxResult } from "./tax-calculator.js";
import type {
	Coupon,
	ShippingMethodSnapshot,
	TotalsBreakdown,
	TotalsInput,
	TotalsLineBreakdown,
	TotalsLineInput,
} from "./types.js";

/**
 * The Phase-6 totals pipeline (§4) — a pure, deterministic function of its
 * input, in integer minor units throughout. No float, no clock, no store, no
 * randomness: calling it twice on the same input is bit-identical.
 *
 * Ordering (§4):
 *   subtotal → discount (clamped) → pro-rata discounted lines → shipping fee
 *   (free-shipping threshold vs the DISCOUNTED subtotal) → per-line tax on the
 *   discounted line amount → shipping tax (if the zone taxes shipping) → total.
 *
 * The sum-of-parts identity `subtotal − discount + shipping + tax === total`
 * holds **by construction**: `allocateCents` reconciles the discount across
 * lines exactly, so per-line tax sums back without rounding leftover.
 *
 * Since ADR-0030 the tax step is a calculator's: `computeQuote` runs
 * {@link computePreTax}, asks the calculator, then {@link assembleTotals}. This
 * function is that same pipeline with the built-in rate table applied to a
 * pre-fetched `RulesSnapshot` — kept for callers and suites that price pure data.
 */
export function computeTotals(input: TotalsInput): TotalsBreakdown {
	const { rules } = input;
	const preTax = computePreTax({
		currency: input.currency,
		lines: input.lines,
		...(input.coupon !== undefined ? { coupon: input.coupon } : {}),
		shippingMethod: rules.shippingMethod,
	});
	const ratesByClass = new Map(Object.entries(rules.taxRatesByClass));
	const result = applyRateTable(
		{
			purpose: "quote",
			currency: input.currency,
			pricesIncludeTax: false,
			lines: taxRequestLinesOf(preTax),
			shipping: { amountCents: preTax.shippingCents, methodId: rules.shippingMethod.methodId },
			origin: null,
			destination: null,
			zoneId: rules.shippingMethod.zoneId,
		},
		{
			ratesByClass,
			shippingTaxable: rules.shippingTaxable,
			shippingTaxClassId: rules.shippingTaxClassId,
		},
		new Map(),
	);
	return assembleTotals(preTax, result);
}

export interface PreTaxInput {
	currency: Currency;
	lines: ReadonlyArray<TotalsLineInput>;
	/** Already validated/loaded (dates, min-subtotal, exhaustion) — pure data. */
	coupon?: Coupon;
	shippingMethod: ShippingMethodSnapshot;
}

/** Everything the pipeline knows before tax: steps 1–5 of §4. */
export interface PreTaxTotals {
	currency: Currency;
	lines: ReadonlyArray<TotalsLineInput>;
	subtotalCents: Cents;
	discountCents: Cents;
	/** Each line's share of the discounted subtotal — the tax base. */
	discountedLineCents: readonly Cents[];
	shippingCents: Cents;
	appliedCouponCode?: string;
}

export function computePreTax(input: PreTaxInput): PreTaxTotals {
	const { currency, lines, coupon } = input;

	// 1–2. Per-line subtotal (snapshot unit price × qty) and cart subtotal.
	const lineSubtotals: number[] = lines.map((l) => {
		if (!Number.isSafeInteger(l.qty) || l.qty <= 0) {
			throw new RangeError(`computeTotals requires a positive integer qty, got ${String(l.qty)}`);
		}
		return l.unitPriceCents * l.qty;
	});
	const subtotal = cents(lineSubtotals.reduce((a, b) => a + b, 0));

	// 3. Discount, clamped to [0, subtotal] by computeCouponDiscount.
	const discount =
		coupon === undefined ? cents(0) : computeCouponDiscount(subtotal, currency, coupon);
	const discountedTotal = cents(subtotal - discount);

	// 4. Pro-rata: allocate the discounted subtotal across lines by their weight,
	//    so per-class tax is computed on the base the discount actually reduces.
	const discountedLineCents = allocateCents(discountedTotal, lineSubtotals);

	// 5. Shipping fee — free-shipping threshold checked against the discounted subtotal.
	const shipping = resolveShippingRate(input.shippingMethod, discountedTotal);

	return {
		currency,
		lines,
		subtotalCents: subtotal,
		discountCents: discount,
		discountedLineCents,
		shippingCents: shipping,
		...(coupon !== undefined && discount > 0 ? { appliedCouponCode: coupon.code } : {}),
	};
}

/** The request lines for a calculator: `lineId` is the line's index. A line
 *  that does not say whether it ships takes `cartRequiresShipping`. */
export function taxRequestLinesOf(
	preTax: PreTaxTotals,
	cartRequiresShipping = true,
): TaxRequestLine[] {
	return preTax.lines.map((l, i) => ({
		lineId: String(i),
		quantity: l.qty,
		unitPriceCents: l.unitPriceCents,
		amountCents: preTax.discountedLineCents[i] as Cents,
		taxClassId: l.taxClassId,
		taxStatus: l.taxStatus ?? "taxable",
		requiresShipping: l.requiresShipping ?? cartRequiresShipping,
	}));
}

/**
 * Steps 6–9 from a VALIDATED calculator answer (`validateTaxResult`: one line
 * per request line, in request order). Tax = Σ line + shipping; total =
 * discounted subtotal + shipping + tax — except when prices were entered WITH
 * tax (ADR-0032): the line tax is already inside the discounted subtotal, so
 * only the shipping tax is added (`totalCents` is what the buyer pays either way,
 * and `taxCents` is still the whole tax).
 */
export function assembleTotals(
	preTax: PreTaxTotals,
	tax: TaxResult,
	pricesIncludeTax = false,
): TotalsBreakdown {
	let perLineTax = 0;
	const lineBreakdown: TotalsLineBreakdown[] = preTax.lines.map((l, i) => {
		const taxCents = tax.lines[i]?.taxCents;
		if (taxCents === undefined) throw new RangeError(`no tax line for line ${String(i)}`);
		perLineTax += taxCents;
		return {
			taxClassId: l.taxClassId,
			discountedCents: preTax.discountedLineCents[i] as Cents,
			taxCents,
		};
	});
	const shippingTax = tax.shipping?.taxCents ?? cents(0);
	const taxTotal = cents(perLineTax + shippingTax);
	const discountedTotal = preTax.subtotalCents - preTax.discountCents;

	const breakdown: TotalsBreakdown = {
		currency: preTax.currency,
		subtotalCents: preTax.subtotalCents,
		discountCents: preTax.discountCents,
		shippingCents: preTax.shippingCents,
		taxCents: taxTotal,
		totalCents: cents(
			discountedTotal + preTax.shippingCents + (pricesIncludeTax ? shippingTax : taxTotal),
		),
		lineBreakdown,
		shippingTaxCents: shippingTax,
	};
	if (preTax.appliedCouponCode !== undefined) {
		breakdown.appliedCouponCode = preTax.appliedCouponCode;
	}
	return breakdown;
}
