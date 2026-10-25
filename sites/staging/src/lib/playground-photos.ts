/**
 * Photographs for the three sample products.
 *
 * The files live in `public/playground-products/` and are served as static
 * assets, so the playground does not need the paid Cloudflare Images binding
 * or the playground's bundled media library (that library only has EmDash's
 * own demo pictures, and its storage refuses uploads). The image field stores
 * `provider: "external"` with this `src`. EmDash keeps `src` on an external
 * value, and the storefront's `productImage` renders it directly.
 *
 * A session created before these files existed has no image on the row. The
 * playground gate writes this same value onto that row. A session created
 * after already has it from the seed, and the write is skipped.
 */
export interface PlaygroundProductPhoto {
	provider: "external";
	id: string;
	src: string;
	alt: string;
	filename: string;
	mimeType: "image/jpeg";
}

export const PLAYGROUND_PRODUCT_PHOTOS: Record<string, PlaygroundProductPhoto> = {
	"otta-tee": {
		provider: "external",
		id: "playground-otta-tee",
		src: "/playground-products/otta-tee.jpg",
		alt: "A white cotton t-shirt on a hanger",
		filename: "otta-tee.jpg",
		mimeType: "image/jpeg",
	},
	"otta-mug": {
		provider: "external",
		id: "playground-otta-mug",
		src: "/playground-products/otta-mug.jpg",
		alt: "A white ceramic mug on a wooden table",
		filename: "otta-mug.jpg",
		mimeType: "image/jpeg",
	},
	"otta-stickers": {
		provider: "external",
		id: "playground-otta-stickers",
		src: "/playground-products/otta-stickers.jpg",
		alt: "A pile of die-cut stickers",
		filename: "otta-stickers.jpg",
		mimeType: "image/jpeg",
	},
};

/** The picture URL already stored on a CMS product, if it has one.
 *  A visitor who set a different picture is left alone; only a missing
 *  picture is filled with the shipped photograph. */
export function contentImageSrc(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const images = (data as { images?: unknown }).images;
	if (typeof images === "string" && images.length > 0) return images;
	if (typeof images !== "object" || images === null) return null;
	const record = images as { src?: unknown; url?: unknown };
	if (typeof record.src === "string" && record.src.length > 0) return record.src;
	if (typeof record.url === "string" && record.url.length > 0) return record.url;
	return null;
}
