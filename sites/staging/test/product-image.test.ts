/**
 * A product's image URL (`lib/products.ts` `productImage`).
 *
 * An image uploaded in the admin is stored by EmDash as a LOCAL media value
 * that carries no `src`: EmDash's save-time normalizer deletes `src` from every
 * `provider: "local"` value and keeps the file's `meta.storageKey` instead (the
 * live loader only rebuilds `src` for legacy values that still have one). The
 * storefront has to build the URL from the key, the way EmDash's own `<Image>`
 * does (`buildRenderMediaUrl`): storage key, else a pre-baked URL, else the
 * bare media id, all through the `/_emdash/api/media/file/` route.
 */
import { describe, expect, test } from "vitest";
import { productImage, toCmsProductContent } from "../src/lib/products.js";

/** Exactly what EmDash 0.38 stored for a PNG uploaded through the product editor. */
const UPLOADED = {
	id: "01M3Y5KWQD0EYKTQFAK66W55WC",
	provider: "local",
	filename: "test-product.png",
	mimeType: "image/png",
	width: 400,
	height: 500,
	alt: "",
	meta: { storageKey: "01M3Y5KWQDKC9X79MMW41TF862.01M3Y5KWT16WA9YTWBJ2CZZ5F6.png" },
};

const entry = (images: unknown) =>
	({ id: "p-1", slug: "tee", title: "Tee", images }) as Parameters<typeof productImage>[0];

describe("a product's image URL", () => {
	test("an image uploaded in the admin (no src, only a storage key) resolves to the media route", () => {
		expect(productImage(entry(UPLOADED))).toBe(
			"/_emdash/api/media/file/01M3Y5KWQDKC9X79MMW41TF862.01M3Y5KWT16WA9YTWBJ2CZZ5F6.png",
		);
	});

	test("the uploaded image reaches the content the plugin routes receive", () => {
		expect(toCmsProductContent(entry(UPLOADED)).images).toEqual([
			"/_emdash/api/media/file/01M3Y5KWQDKC9X79MMW41TF862.01M3Y5KWT16WA9YTWBJ2CZZ5F6.png",
		]);
	});

	test("a value that already carries a src or url keeps it", () => {
		expect(productImage(entry({ provider: "local", src: "/_emdash/api/media/file/a.png" }))).toBe(
			"/_emdash/api/media/file/a.png",
		);
		expect(productImage(entry({ provider: "external", url: "https://cdn.example/a.jpg" }))).toBe(
			"https://cdn.example/a.jpg",
		);
	});

	test("a local value with only an id falls back to the id route", () => {
		expect(productImage(entry({ provider: "local", id: "01M3Y5KWQD0EYKTQFAK66W55WC" }))).toBe(
			"/_emdash/api/media/file/01M3Y5KWQD0EYKTQFAK66W55WC",
		);
	});

	test("a storage key that could leave the media route is not used", () => {
		expect(
			productImage(entry({ provider: "local", id: "abc", meta: { storageKey: "../secret" } })),
		).toBe("/_emdash/api/media/file/abc");
		expect(productImage(entry({ provider: "local", meta: { storageKey: "a/b.png" } }))).toBeNull();
	});

	test("no image is null", () => {
		expect(productImage(entry(null))).toBeNull();
		expect(productImage(entry(undefined))).toBeNull();
		expect(productImage(entry({}))).toBeNull();
	});
});
