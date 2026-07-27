/**
 * The cart page's money cells (storefront-checkout plan §5).
 *
 * A bare "—" in a price column is indistinguishable from three different
 * things: a free item, an outage, and a line the store simply cannot price
 * here. The reported "every money column shows —" symptom was the third case —
 * legacy cart lines carrying `product_id = NULL`, which `buildCartPricing`
 * short-circuits SILENTLY (`degraded` stays false, so no banner renders) — and
 * it was indistinguishable from the second, which is the whole problem.
 *
 * A visually identical failure comes from a stale worker bundle, where
 * `result.pricing` is `undefined` and the page's `pricing?.degraded` check
 * quietly evaluates to nothing. Treating ABSENT pricing as degraded closes that
 * one.
 *
 * This is the same rule the checkout's "Not calculated" totals follow: say
 * which of the three it is, or say nothing that looks like a number.
 */
import type { CartPricingWire } from "@urumi/plugin";

/** The line is real and orderable-looking, but no live price could be joined
 *  here. (Such a line in fact cannot be ordered — checkout answers
 *  `PRODUCT_NOT_PRICED` — but the cart is not the place to litigate that.) */
export const PRICED_AT_CHECKOUT_LABEL = "priced at checkout";

/** The whole pricing lookup failed; the page's banner explains it, so the cell
 *  stays quiet rather than repeating an outage per row. */
export const UNAVAILABLE_LABEL = "—";

/** `undefined`/`null` pricing is degraded, not "no prices": absent is the
 *  stale-bundle case the page used to swallow. */
export function isCartPricingDegraded(pricing: CartPricingWire | null | undefined): boolean {
	return pricing === null || pricing === undefined || pricing.degraded;
}

export function cartMoneyCell(
	formatted: string | null | undefined,
	pricingDegraded: boolean,
): string {
	if (formatted !== null && formatted !== undefined) return formatted;
	return pricingDegraded ? UNAVAILABLE_LABEL : PRICED_AT_CHECKOUT_LABEL;
}
