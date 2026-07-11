import { type Cents, cents } from "../money/cents.js";
import { allocateCents } from "./allocate.js";
import { computeCouponDiscount } from "./coupon.js";
import { resolveShippingRate } from "./shipping.js";
import { computeLineTax } from "./tax.js";
import type { TotalsBreakdown, TotalsInput, TotalsLineBreakdown } from "./types.js";

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
 */
export function computeTotals(input: TotalsInput): TotalsBreakdown {
	const { currency, lines, coupon, rules } = input;

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
	const discountedLines = allocateCents(discountedTotal, lineSubtotals);

	// 5. Shipping fee — free-shipping threshold checked against the discounted subtotal.
	const shipping = resolveShippingRate(rules.shippingMethod, discountedTotal);

	// 6. Per-line tax on the discounted line amount, each rounded independently.
	let perLineTax = 0;
	const lineBreakdown: TotalsLineBreakdown[] = lines.map((l, i) => {
		const rateBps = rules.taxRatesByClass[l.taxClassId] ?? 0;
		const discountedCents = discountedLines[i] as Cents;
		const taxCents = computeLineTax(discountedCents, rateBps);
		perLineTax += taxCents;
		return { taxClassId: l.taxClassId, discountedCents, taxCents };
	});

	// 7. Shipping tax (§ case 5).
	const shippingTax = rules.shippingTaxable
		? computeLineTax(shipping, rules.taxRatesByClass[rules.shippingTaxClassId] ?? 0)
		: cents(0);

	// 8. Tax total, 9. grand total.
	const tax = cents(perLineTax + shippingTax);
	const total = cents(discountedTotal + shipping + tax);

	const breakdown: TotalsBreakdown = {
		currency,
		subtotalCents: subtotal,
		discountCents: discount,
		shippingCents: shipping,
		taxCents: tax,
		totalCents: total,
		lineBreakdown,
		shippingTaxCents: shippingTax,
	};
	if (coupon !== undefined && discount > 0) {
		breakdown.appliedCouponCode = coupon.code;
	}
	return breakdown;
}
