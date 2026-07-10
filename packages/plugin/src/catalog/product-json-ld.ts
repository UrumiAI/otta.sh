/**
 * schema.org Product/Offer JSON-LD (Phase 2 §7 step 8) — pure builder over
 * the joined view. Per ADR-0003 the graph rides the storefront route's JSON
 * view model; the theme page injects it as
 * `<script type="application/ld+json">`.
 *
 * Offer emission is gated on `purchasable` and ONLY on it (§1 case 3): a
 * non-purchasable product emits a Product node with the `offers` key ABSENT
 * — omission, never `offers: null` or a null price.
 *
 * `availability` is the COARSE `inStock` boolean (plan §8 risk 5,
 * pre-approved): `inventory.on_hand > 0` at the service's read time, not
 * reservation-aware — it can say InStock moments before a concurrent buyer
 * takes the last unit. It is a display/SEO convenience, NOT a stronger
 * guarantee; Phase 3's `reserve` is the authority on purchase success.
 *
 * Additive by construction (risk 8): a plain object literal — later fields
 * (`aggregateRating` from tier-① reviews) spread in without a redesign.
 */
import { majorUnits } from "../presentation/format-money.js";
import type { JoinedProduct } from "./join-product.js";

const SCHEMA_ORG_IN_STOCK = "https://schema.org/InStock";
const SCHEMA_ORG_OUT_OF_STOCK = "https://schema.org/OutOfStock";

export function buildProductJsonLd(joined: JoinedProduct): Record<string, unknown> {
	const { content, commerce } = joined;

	const product: Record<string, unknown> = {
		"@context": "https://schema.org",
		"@type": "Product",
		name: content.title,
	};
	if (content.description !== undefined) product["description"] = content.description;
	if (content.images !== undefined && content.images.length > 0) {
		product["image"] = content.images;
	}
	if (content.url !== undefined) product["url"] = content.url;

	if (commerce !== null) {
		product["sku"] = commerce.sku;
		product["offers"] = {
			"@type": "Offer",
			// Major units as an exact STRING (integer math in majorUnits) —
			// never a float that could re-round.
			price: majorUnits(commerce.price.amount, commerce.price.currency),
			priceCurrency: commerce.price.currency,
			availability: commerce.inStock ? SCHEMA_ORG_IN_STOCK : SCHEMA_ORG_OUT_OF_STOCK,
		};
	}

	return product;
}
