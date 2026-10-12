/**
 * Shop-page prices with or without tax (#423) — the join, re-priced for DISPLAY.
 *
 * The PDP and PLP apply this to the joined product before building the view
 * model and the JSON-LD, so the price, the was-price and the structured-data
 * offer all show the same figure. The arithmetic is the domain's
 * `shopDisplayPrice` — the checkout's own rate-table maths — never a formula
 * here. Display only: the cart and checkout read the stored price, untouched.
 */
import {
	cents as domainCents,
	currency as domainCurrency,
	shopDisplayPrice,
} from "@otta-sh/domain";
import { cents } from "../presentation/money.js";
import type { ShopPriceDisplayWire } from "../product-commerce/commerce-client.js";
import type { CatalogProductCommerce } from "./commerce-view.js";
import type { JoinedProduct } from "./join-product.js";

type Money = CatalogProductCommerce["price"];

/** `joined` with its prices as the shop shows them; the same object when nothing changes. */
export function withShopDisplayPrice(
	joined: JoinedProduct,
	display: ShopPriceDisplayWire,
): JoinedProduct {
	const commerce = joined.commerce;
	if (display.mode === "entered" || commerce === null) return joined;
	// The two `Cents` brands are deliberately not cross-assignable (presentation/
	// money.ts): re-minted on the way in and on the way out.
	const shown = (money: Money): Money => ({
		currency: money.currency,
		amount: cents<number>(
			shopDisplayPrice(display, {
				currency: domainCurrency(money.currency),
				unitPriceCents: domainCents<number>(money.amount),
				// Read exactly as checkout reads the row (`quoteCommandFor`).
				taxClassId: commerce.taxClass ?? "standard",
				taxStatus: commerce.taxStatus ?? "taxable",
			}),
		),
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
