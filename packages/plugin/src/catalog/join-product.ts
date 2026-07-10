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
	 * The ONE computed sellability truth (§4.2 — "purchasable: false iff
	 * commerce === null (or explicitly inactive)"): price slot, JSON-LD
	 * builder, and Phase 3's add-to-cart gate all read THIS flag — none
	 * re-derives "is this thing sellable" from nullable parts. One function,
	 * one truth, one test.
	 */
	purchasable: boolean;
}

/**
 * `purchasable ⟺ commerce !== null && commerce.active` — §4.2's exact rule
 * ("purchasable: false iff commerce === null (or explicitly inactive)").
 *
 * `commerce === null` covers, indistinguishably and deliberately: no
 * `product_commerce` row synced yet ("create, then price" unfinished), a
 * soft-deleted commerce record (Phase 1 afterDelete), or the batch simply
 * omitting an id it doesn't have (the endpoint omits, never 404s — "no
 * status-code-as-logic"). An INACTIVE (unpublished) commerce row renders
 * exactly like the no-commerce case downstream: flagged not-purchasable, no
 * price, no Offer. Either way the product still renders its content — a
 * CMS product that isn't sellable is "hidden from purchase," not "hidden
 * from the catalog" (§4.5). Honest current state: the afterPublish→activate
 * wiring is deferred (its own follow-up task), so every synced row is
 * active=false and the whole catalog renders not-purchasable until it lands.
 */
export function joinProduct(
	content: CmsProductContent,
	commerce: CatalogProductCommerce | null,
): JoinedProduct {
	return { content, commerce, purchasable: commerce !== null && commerce.active };
}
