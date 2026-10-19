/**
 * Prices with or without tax for DISPLAY (#423): the shop pages (`displayShop`)
 * and the cart page's lines (`displayCart`).
 *
 * The PDP and PLP apply {@link withShopDisplayPrice} to the joined product before
 * building the view model and the JSON-LD, so the price, the was-price and the
 * structured-data offer all show the same figure; the cart page prices its lines
 * through {@link displayAmount}. The arithmetic is the domain's
 * `shopDisplayPrice` — the checkout's own rate-table maths — never a formula
 * here. Display only: what checkout charges is the quote's, untouched.
 */
import {
	cents as domainCents,
	currency as domainCurrency,
	type ShopDisplayItem,
	type ShopPriceDisplay,
	shopDisplayPrice,
	shopDisplayPrices,
} from "@urumi.ai/otta-domain";
import { type Cents, cents } from "../presentation/money.js";
import type { ShopPriceDisplayWire } from "../product-commerce/commerce-client.js";
import type { CatalogProductCommerce } from "./commerce-view.js";
import type { JoinedProduct } from "./join-product.js";

type Money = CatalogProductCommerce["price"];

/** Show the stored price, unchanged. */
export const PRICES_AS_ENTERED: ShopPriceDisplayWire = Object.freeze({ mode: "entered" });

// The hand-rolled wire type and the domain's must stay the same shape: a field
// added to one and not the other fails the typecheck here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ShopPriceDisplayWireMatchesDomain = Assert<
	Same<ShopPriceDisplayWire, ShopPriceDisplay>
>;

/**
 * The price display, or — when reading it fails (a tax-rules or settings hiccup)
 * — prices as entered, with a warning: a page that cannot work out the tax shows
 * the stored price rather than failing.
 */
export async function priceDisplayOrEntered(
	route: string,
	read: () => Promise<ShopPriceDisplayWire>,
): Promise<ShopPriceDisplayWire> {
	try {
		return await read();
	} catch (err) {
		console.warn(`[otta] ${route} price display unavailable; showing prices as entered:`, err);
		return PRICES_AS_ENTERED;
	}
}

type Priced = Pick<CatalogProductCommerce, "taxClass" | "taxStatus">;

// The two `Cents` brands are deliberately not cross-assignable (presentation/
// money.ts): re-minted on the way in and on the way out.
function displayItem(commerce: Priced, money: Money, quantity: number): ShopDisplayItem {
	return {
		currency: domainCurrency(money.currency),
		unitPriceCents: domainCents<number>(money.amount),
		quantity,
		// Read exactly as checkout reads the row (`quoteCommandFor`).
		taxClassId: commerce.taxClass ?? "standard",
		taxStatus: commerce.taxStatus ?? "taxable",
	};
}

/** `quantity` units of a product at `money`, as `display` shows them. */
export function displayAmount(
	commerce: Priced,
	money: Money,
	quantity: number,
	display: ShopPriceDisplayWire,
): Cents {
	if (display.mode === "entered") return cents<number>(money.amount * quantity);
	return cents<number>(shopDisplayPrice(display, displayItem(commerce, money, quantity)));
}

/**
 * Several cart lines (one currency), as `display` shows them, priced TOGETHER as
 * checkout prices the cart (#478): with "round at subtotal" the tax is rounded
 * once over the lines, so they sum to what checkout shows. Rounding per line,
 * each is exactly {@link displayAmount}.
 */
export function displayAmounts(
	lines: ReadonlyArray<{ commerce: Priced; money: Money; quantity: number }>,
	display: ShopPriceDisplayWire,
): Cents[] {
	if (display.mode === "entered") {
		return lines.map((l) => cents<number>(l.money.amount * l.quantity));
	}
	return shopDisplayPrices(
		display,
		lines.map((l) => displayItem(l.commerce, l.money, l.quantity)),
	).map((amount) => cents<number>(amount));
}

/** `joined` with its prices as the shop shows them; the same object when nothing changes. */
export function withShopDisplayPrice(
	joined: JoinedProduct,
	display: ShopPriceDisplayWire,
): JoinedProduct {
	const commerce = joined.commerce;
	if (display.mode === "entered" || commerce === null) return joined;
	const shown = (money: Money): Money => ({
		currency: money.currency,
		amount: displayAmount(commerce, money, 1, display),
	});
	return {
		...joined,
		commerce: {
			...commerce,
			price: shown(commerce.price),
			compareAtPrice: commerce.compareAtPrice === null ? null : shown(commerce.compareAtPrice),
		},
	};
}
