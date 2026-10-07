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
	images?: {
		src?: string;
		url?: string;
		id?: string;
		provider?: string;
		meta?: { storageKey?: string } | null;
	} | null;
}

/**
 * A product's own identity key: its slug, or its id when it has none. ONE
 * rule, because several things must agree on it — the catalog card's `slug`,
 * the product page's `art`, a bag line's `artKey` and every product path —
 * and a theme that ties them together (e.g. a card → product → bag morph
 * that names all three alike) breaks silently the day one of them drifts.
 */
export function productKey(entry: { readonly slug?: string | null; readonly id: string }): string {
	return entry.slug ?? entry.id;
}

/** The id fallback for null-slug entries is valid: em-dash's live loader
 *  resolves entries with `WHERE (c.slug = :id OR c.id = :id)` (loadEntry,
 *  packages/core/src/loader.ts) — getEmDashEntry accepts either. */
export function productPath(slug: string | null, id: string): string {
	return `/products/${productKey({ slug, id })}`;
}

/** EmDash's own route for a locally stored media file. */
const MEDIA_FILE_ROUTE = "/_emdash/api/media/file/";
/** A storage key or media id that stays inside that route: the upload
 *  pipeline's `{ulid}.{ext}` shape — no slash, `?`, `#` or `%`. */
const SAFE_MEDIA_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * The entry's image URL, or `null` when it has none.
 *
 * An image uploaded in the admin is a LOCAL media value with NO `src`: EmDash's
 * save-time normalizer deletes `src` from every `provider: "local"` value and
 * keeps the file's `meta.storageKey`. So the URL is built the way EmDash's own
 * `<Image>` builds it (`buildRenderMediaUrl`): a pre-baked `src`/`url` when the
 * value has one (a legacy local value, an external image), else the storage
 * key, else the bare media id — the last two through the media file route.
 *
 * The rule lives here rather than at each call site because the cart page had
 * grown its own copy of it, and a second copy is how one of them silently stops
 * resolving the day a third spelling appears.
 */
export function productImage(data: ProductEntryData): string | null {
	const image = data.images;
	if (image === null || image === undefined) return null;
	const baked = image.src ?? image.url;
	if (typeof baked === "string" && baked.length > 0) return baked;
	for (const key of [image.meta?.storageKey, image.id]) {
		if (typeof key === "string" && SAFE_MEDIA_KEY.test(key)) return `${MEDIA_FILE_ROUTE}${key}`;
	}
	return null;
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
