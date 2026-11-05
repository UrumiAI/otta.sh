/**
 * The cart page's notice for a cart left in the OLD currency after the operator
 * switched the store currency (#440).
 *
 * A cart is never rewritten, so it keeps the currency it was started in, and
 * nothing the shop now prices in the new currency can be checked out of it —
 * the plugin quotes such a line CURRENCY_MISMATCH. The cart read says so
 * (`staleCurrency`), and this is what the page tells the shopper, beside the one
 * way out: a new cart in the store currency (`POST /cart/switch-currency`).
 *
 * The body says what the action COSTS before it is clicked: the items are not
 * moved across — they are released, and the shopper adds them again at the
 * shop's current prices. No price is ever converted, and the copy never
 * suggests one was.
 */
import type { CartStaleCurrencyWire } from "@urumi.ai/otta-plugin";

export interface StaleCurrencyNotice {
	/** What happened, in one sentence — the notice's lead. */
	lead: string;
	/** Why the cart cannot check out, and what the action does. */
	body: string;
	/** The button's label. */
	action: string;
}

export function staleCurrencyNotice(stale: CartStaleCurrencyWire): StaleCurrencyNotice {
	const { cartCurrency, storeCurrency } = stale;
	return {
		lead: `This shop now sells in ${storeCurrency}.`,
		body: `Your cart was started in ${cartCurrency}, so it can't check out items priced in ${storeCurrency}. Start a new cart in ${storeCurrency} and add your items again at today's prices — the items in this cart will be released.`,
		action: `Start a new cart in ${storeCurrency}`,
	};
}
