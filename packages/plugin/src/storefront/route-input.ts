/**
 * Boundary validation for the storefront routes' input (ADR-0003: the
 * routes are PUBLIC — anything can POST to them, so the shape is validated
 * by hand here, mirroring the admin route's style; the plugin has no
 * schema-library dependency). Strict on the load-bearing fields (`id` — the
 * join key — and `title`), lenient-drop on cosmetic optionals.
 */
import type { CmsProductContent } from "../catalog/join-product.js";

export function parseCmsProductContent(value: unknown): CmsProductContent | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v["id"] !== "string" || v["id"].length === 0) return null;
	if (typeof v["title"] !== "string" || v["title"].length === 0) return null;

	const content: CmsProductContent = { id: v["id"], title: v["title"] };
	if (typeof v["slug"] === "string") content.slug = v["slug"];
	if (typeof v["description"] === "string") content.description = v["description"];
	if (typeof v["url"] === "string") content.url = v["url"];
	if (Array.isArray(v["images"])) {
		const images = v["images"].filter((image): image is string => typeof image === "string");
		if (images.length > 0) content.images = images;
	}
	return content;
}

export const DEFAULT_LOCALE = "en";

/**
 * A garbage/absent locale must degrade the render's FORMATTING, never fail
 * the render: fall back to the default instead of letting
 * `Intl.NumberFormat` throw a RangeError mid-page.
 */
export function sanitizeLocale(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return DEFAULT_LOCALE;
	try {
		// Throws RangeError on a malformed tag; returns the canonical form.
		return new Intl.Locale(value).toString();
	} catch {
		return DEFAULT_LOCALE;
	}
}
