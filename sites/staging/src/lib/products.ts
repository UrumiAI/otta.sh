/**
 * CMS entry → `CmsProductContent` mapping (the tier-① boundary shape,
 * ADR-0003): the theme runs the CMS query and hands the plugin routes a
 * validated page of content; this module owns that projection in one
 * place for PLP and PDP.
 */
import type { CmsProductContent } from "@otta-sh/plugin";

/** The `products` entry data shape (see emdash-env.d.ts + seed/seed.json). */
export interface ProductEntryData {
	id: string;
	slug: string | null;
	title: string;
	description?: string;
	images?: { src?: string; url?: string } | null;
}

/** The id fallback for null-slug entries is valid: em-dash's live loader
 *  resolves entries with `WHERE (c.slug = :id OR c.id = :id)` (loadEntry,
 *  packages/core/src/loader.ts) — getEmDashEntry accepts either. */
export function productPath(slug: string | null, id: string): string {
	return `/products/${slug ?? id}`;
}

/**
 * The entry's image, or `null` when it has none.
 *
 * TWO spellings, and both reach a page: em-dash's media value normalizes to
 * `{ src }` locally and arrives as `{ url }` from an external source. The rule
 * lives here rather than at each call site because the cart page had grown its
 * own copy of it, and a second copy is how one of them silently stops
 * resolving the day a third spelling appears.
 */
export function productImage(data: ProductEntryData): string | null {
	return data.images?.src ?? data.images?.url ?? null;
}

export function toCmsProductContent(data: ProductEntryData): CmsProductContent {
	const image = productImage(data);
	return {
		// The EmDash content id — THE join key (product_commerce.product_id).
		id: data.id,
		title: data.title,
		...(data.slug !== null ? { slug: data.slug } : {}),
		...(data.description !== undefined ? { description: data.description } : {}),
		...(image !== null ? { images: [image] } : {}),
		url: productPath(data.slug, data.id),
	};
}
