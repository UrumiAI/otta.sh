/**
 * The plugin-side commercial read model (Phase 2 §4.2) and its ONE parse
 * boundary. The wire item (`ProductCommerceBatchItem`, plain JSON numbers)
 * is branded HERE, immediately after transport: `cents()` runtime-rejects a
 * float/negative off the wire and `currency()` rejects a non-ISO-4217 code,
 * so everything downstream of the transport (join, formatMoney, JSON-LD)
 * handles only `Cents`+`Currency` — a raw `number` reaching those layers is
 * a compile error (DEVELOPMENT.md §4).
 */
import { cents, currency, type Cents, type Currency } from "../presentation/money.js";
import type { ProductCommerceBatchItem } from "../product-commerce/commerce-client.js";

export interface CatalogProductCommerce {
	productId: string;
	sku: string;
	price: { amount: Cents; currency: Currency };
	/** Coarse display-only signal (`on_hand > 0` at the service's read time,
	 *  plan §8 risk 5) — NOT reservation-aware; Phase 3's `reserve` is the
	 *  authority on whether a purchase actually succeeds. */
	inStock: boolean;
}

export function parseCommerceBatchItem(item: ProductCommerceBatchItem): CatalogProductCommerce {
	return {
		productId: item.productId,
		sku: item.sku,
		price: { amount: cents(item.price.amount), currency: currency(item.price.currency) },
		inStock: item.inStock === true,
	};
}
