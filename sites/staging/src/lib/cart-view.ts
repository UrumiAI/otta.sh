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
import { moneyCellText } from "./totals.js";

/** The line is real and orderable-looking, but no live price could be joined
 *  here. (Such a line in fact cannot be ordered — checkout answers
 *  `PRODUCT_NOT_PRICED` — but the cart is not the place to litigate that.) */
export const PRICED_AT_CHECKOUT_LABEL = "priced at checkout";

/**
 * The whole pricing lookup failed.
 *
 * This is a SENTINEL, not a thing to print. It is what `cartMoneyCell` returns
 * for the degraded case, and §7 forbids putting it on a screen: a lone dash is
 * indistinguishable from a free item and from a line this store cannot price.
 * Every caller is expected to pass it through `moneyCellText` with prose of its
 * own — `lineMoneyText` below is the cart's, and it prints
 * `PRICE_UNAVAILABLE_CELL` per row.
 *
 * Per-row prose beside a banner reads as repetition, and an earlier draft of
 * this comment defended the dash on that ground. It is wrong: the money column
 * is where a shopper looks for the figure, and "—" there says a price EXISTS
 * and is this. Do not restore it.
 */
export const UNAVAILABLE_LABEL = "—";

/**
 * The two labels above, in the form a money CELL prints them.
 *
 * `PRICED_AT_CHECKOUT_LABEL` is lower-case because it is also read inside a
 * sentence ("Some items are priced at checkout…"). In the money column it is a
 * cell of its own, sitting beside "At checkout" and "Confirmed at checkout",
 * and TEMPERED.md §10 is sentence case everywhere except the mono eyebrow
 * labels. So the casing is a separate constant rather than a change to the
 * shared one — nothing that reads the label mid-sentence is re-cased behind its
 * back.
 */
export const PRICED_AT_CHECKOUT_CELL = "Priced at checkout";
export const PRICE_UNAVAILABLE_CELL = "Price unavailable";

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

/**
 * The ONE path a money string takes to the cart page's screen.
 *
 * Three steps, and they only mean anything together: `cartMoneyCell` decides
 * WHICH of the three "no figure" cases this is, this function's casing map puts
 * the answer in the page's voice, and §7's `moneyCellText` is the last gate —
 * it refuses anything that does not say something, which is what turns
 * `UNAVAILABLE_LABEL`'s bare dash into real prose.
 *
 * It lives here rather than in `cart/index.astro` so a test can execute the
 * whole composition. A test that runs the pieces in a different order asserts a
 * rule the page does not follow: the earlier one dropped the casing map and
 * pinned the LOWER-case label as the cart's output, which is the opposite of
 * what renders.
 */
export function lineMoneyText(
	formatted: string | null | undefined,
	pricingDegraded: boolean,
): string {
	const cell = cartMoneyCell(formatted, pricingDegraded);
	return moneyCellText(
		cell === PRICED_AT_CHECKOUT_LABEL ? PRICED_AT_CHECKOUT_CELL : cell,
		PRICE_UNAVAILABLE_CELL,
	);
}
