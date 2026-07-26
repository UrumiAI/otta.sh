/**
 * Cart informational pricing (Phase 3 group E follow-up — the deferred join
 * `cart-routes.ts`'s read-handler doc names: "a price-annotated cart read is
 * now REACHABLE … deferred as a separate [Service]/[Plugin] follow-up (join
 * in `GET /carts/:cartId`, or a plugin-side batch join)"). This is that
 * plugin-side batch join: `createCartReadRouteHandler` loads the cart's
 * distinct `productId`s through the SAME request-scoped `CommerceBatchLoader`
 * PDP/PLP use (one batch HTTP call per render, never N), then hands the
 * resolved map here.
 *
 * Pure — no `ctx`, no IO — so it is trivially unit-testable and keeps the
 * cart-line wire's own invariant untouched: `CartWire`/`CartLineWire` are
 * NOT modified (a cart line snapshots no price, `commerce-client.ts`'s
 * documented domain invariant); this is an ADDITIVE sibling view built
 * alongside the cart, never a field grafted onto it.
 *
 * A line is priced only when: it carries a non-null `productId`, a commerce
 * row was found for it, that row is `active`, AND its currency matches the
 * cart's own currency (defensive — single-currency site assumed; a
 * mismatched-currency line degrades to unpriced rather than fabricating a
 * converted number — out of scope, see the plan). The cart `total` sums only
 * the priced lines' totals (partial total, never all-or-nothing) and
 * `allLinesPriced` tells the theme whether to caveat the total.
 */
import { formatMoney } from "../presentation/format-money.js";
import { cents } from "../presentation/money.js";
import type { Currency } from "../presentation/money.js";
import type { CatalogProductCommerce } from "../catalog/commerce-view.js";
import type { CartLineWire } from "../product-commerce/commerce-client.js";

export interface CartMoneyWire {
	amount: number;
	currency: string;
	formatted: string;
}

export interface CartLinePricing {
	lineId: string;
	/** null when this line isn't priceable (no productId, unsynced commerce,
	 *  inactive, or a currency mismatch) — never a fabricated number. */
	unitPrice: CartMoneyWire | null;
	lineTotal: CartMoneyWire | null;
}

export interface CartPricingWire {
	/** true iff the commerce batch lookup itself failed (transport/parse
	 *  error) — the cart still renders; only pricing is unavailable. */
	degraded: boolean;
	lines: CartLinePricing[];
	/** Sum of priced lines' totals; null when nothing on the cart is priced
	 *  (empty cart, all-legacy-bare-add lines, or a degraded lookup). */
	total: CartMoneyWire | null;
	/** false whenever at least one line has no price — the theme's signal to
	 *  caveat the total as partial. */
	allLinesPriced: boolean;
}

function money(amount: number, currencyCode: Currency, locale: string): CartMoneyWire {
	return {
		amount,
		currency: currencyCode,
		formatted: formatMoney(cents(amount), currencyCode, locale),
	};
}

/**
 * Builds the cart's informational pricing view. `commerceById` is exactly
 * the shape `CommerceBatchLoader.loadMany` returns (missing id ⇒ absent/
 * `null` entry, PLP's pattern) — an empty map (no batch call made, e.g. a
 * cart of only legacy bare-add lines) degrades every line to unpriced, not
 * an error.
 */
export function buildCartPricing(
	lines: CartLineWire[],
	commerceById: Map<string, CatalogProductCommerce | null>,
	cartCurrency: string,
	locale: string,
): CartPricingWire {
	let allLinesPriced = true;
	let totalAmount = 0;
	let totalCurrency: Currency | null = null;

	const linePricing: CartLinePricing[] = lines.map((line) => {
		const commerce = line.productId !== null ? (commerceById.get(line.productId) ?? null) : null;
		const priced =
			commerce !== null && commerce.active && (commerce.price.currency as string) === cartCurrency;
		if (!priced || commerce === null) {
			allLinesPriced = false;
			return { lineId: line.lineId, unitPrice: null, lineTotal: null };
		}

		const lineAmount = commerce.price.amount * line.qty;
		totalAmount += lineAmount;
		totalCurrency = commerce.price.currency;

		return {
			lineId: line.lineId,
			unitPrice: money(commerce.price.amount, commerce.price.currency, locale),
			lineTotal: money(lineAmount, commerce.price.currency, locale),
		};
	});

	const total = totalCurrency === null ? null : money(totalAmount, totalCurrency, locale);

	return { degraded: false, lines: linePricing, total, allLinesPriced };
}

/** Returned when the batch lookup itself failed — the cart still renders
 *  (hold/qty/remove all still work); only pricing is unavailable. */
export const DEGRADED_CART_PRICING: CartPricingWire = {
	degraded: true,
	lines: [],
	total: null,
	allLinesPriced: false,
};
