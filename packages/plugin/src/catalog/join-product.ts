/**
 * The content+commerce join (Phase 2 §4.2) — pure, no `ctx`, transport-
 * agnostic. CMS content (EmDash's DB) and commercial data (the commerce
 * service's DB) live in SEPARATE databases and are never joined in SQL
 * across them (design-decisions §4); they meet here, in app code, keyed by
 * `productId = CMS content id` (Phase 1's link key).
 */
import type { CatalogProductCommerce } from "./commerce-view.js";

/**
 * The CMS-side slice one catalog card/page needs (title, description,
 * images, url) — deliberately narrow. Per ADR-0003 the tier-① CMS query
 * (all-products / taxonomy / FTS) runs OUTSIDE the plugin and its page of
 * content arrives on the storefront route's input; this type is that
 * boundary's validated shape.
 */
export interface CmsProductContent {
	/** The EmDash content id — THE join key (`product_commerce.product_id`). */
	id: string;
	title: string;
	slug?: string;
	description?: string;
	images?: string[];
	url?: string;
}

export interface JoinedProduct {
	content: CmsProductContent;
	commerce: CatalogProductCommerce | null;
	/**
	 * The ONE computed sellability truth (§4.2): price slot, JSON-LD builder,
	 * and Phase 3's add-to-cart gate all read THIS flag — none re-derives
	 * "is this thing sellable" from nullable parts. One function, one truth,
	 * one test.
	 */
	purchasable: boolean;
}

/**
 * `commerce === null` covers, indistinguishably and deliberately (§4.2):
 * no `product_commerce` row synced yet ("create, then price" unfinished), a
 * soft-deleted commerce record (Phase 1 afterDelete), or the batch simply
 * omitting an id it doesn't have (the endpoint omits, never 404s — "no
 * status-code-as-logic"). The product still renders its content either way
 * — a CMS product without a commerce record is "hidden from purchase," not
 * "hidden from the catalog" (§4.5). Note `active` is not consulted:
 * afterPublish is deferred (Phase 1 handoff), so every synced row is
 * active=false today; the store-side read (port doc) owns that decision.
 */
export function joinProduct(
	content: CmsProductContent,
	commerce: CatalogProductCommerce | null,
): JoinedProduct {
	return { content, commerce, purchasable: commerce !== null };
}
