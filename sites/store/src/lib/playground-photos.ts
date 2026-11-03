/**
 * Photographs for the three sample products.
 *
 * The files live in `public/playground-products/` and are served as static
 * assets, so the playground does not need the paid Cloudflare Images binding.
 * The image field stores `provider: "external"` with this `src`. EmDash keeps
 * `src` on an external value, and the storefront's `productImage` renders it
 * directly as a plain `<img>`.
 *
 * EmDash's own media library is a separate path. Its initializer inserts
 * seven demo rows, and its storage adapter loads each file from the Worker's
 * static assets at `/playground-media/<storageKey>` (see
 * `public/playground-media/`). That adapter refuses uploads, so a product
 * photograph cannot be pushed into the library; it stays an external image.
 *
 * The shots are the Otta products from the marketing page: a black tee, a
 * cream speckled mug, and a sticker sheet, each carrying the OTTA wordmark.
 * See `public/playground-products/CREDITS.txt`.
 *
 * A session with no picture, or with this same `src` but an older alt, gets
 * the shipped value written onto the row. A different `src` is a picture the
 * visitor set, and is left alone.
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
		alt: "A black heavyweight tee with the white OTTA wordmark",
		filename: "otta-tee.jpg",
		mimeType: "image/jpeg",
	},
	"otta-mug": {
		provider: "external",
		id: "playground-otta-mug",
		src: "/playground-products/otta-mug.jpg",
		alt: "A cream speckled ceramic mug with the black OTTA wordmark",
		filename: "otta-mug.jpg",
		mimeType: "image/jpeg",
	},
	"otta-stickers": {
		provider: "external",
		id: "playground-otta-stickers",
		src: "/playground-products/otta-stickers.jpg",
		alt: "A sheet of die-cut stickers with the OTTA wordmark",
		filename: "otta-stickers.jpg",
		mimeType: "image/jpeg",
	},
};

/** The picture URL already stored on a CMS product, if it has one. */
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

/** Whether the playground should write `photo` onto this product row.
 *  Missing pictures are filled. The shipped `src` is refreshed when the
 *  stored alt is still the previous one. Any other URL is left alone. */
export function shouldAttachPlaygroundPhoto(data: unknown, photo: PlaygroundProductPhoto): boolean {
	const src = contentImageSrc(data);
	if (src !== null && src !== photo.src) return false;
	if (typeof data !== "object" || data === null) return true;
	const images = (data as { images?: unknown }).images;
	if (typeof images !== "object" || images === null) return true;
	const record = images as Record<string, unknown>;
	return (
		record["provider"] !== photo.provider ||
		record["id"] !== photo.id ||
		record["src"] !== photo.src ||
		record["alt"] !== photo.alt ||
		record["filename"] !== photo.filename ||
		record["mimeType"] !== photo.mimeType
	);
}
