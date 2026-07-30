/**
 * Seed guard (plan §3.3): the seed must declare the ONE collection the
 * plugin's sync hooks guard on (`PRODUCTS_COLLECTION = "products"`), with
 * the field set `CmsProductContent` reads (title/description/images) — and
 * NOTHING commercial.
 *
 * ONE HOME PER FIELD (PR 1b): the collection used to carry a `json` field
 * called `commerce`, bound to a "Product data" Block Kit widget, holding sku /
 * price / currency / stock / kind / tax class / dimensions. That made the CMS
 * content document a SECOND writer of `product_commerce`'s columns, and every
 * publish reverted whatever the admin console had edited. The field, the
 * widget and its binding are gone; commercial fields are edited only in the
 * admin's Pricing & inventory page. The "no commerce field" test below is the
 * regression guard — re-adding one anywhere in this collection recreates the
 * second writer.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTS_COLLECTION } from "@otta-sh/plugin";
import { describe, expect, test } from "vitest";

interface SeedField {
	slug: string;
	type: string;
	required?: boolean;
	/** Plugin field-widget binding: `"pluginId:widgetName"`. The products
	 *  collection must declare NONE — the plugin registers no field widget. */
	widget?: string;
}

interface SeedCollection {
	slug: string;
	description?: string;
	fields: SeedField[];
}

interface SeedFile {
	version: string;
	collections?: SeedCollection[];
	content?: Record<string, { slug: string; status?: string; data: Record<string, unknown> }[]>;
}

const seedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed/seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as SeedFile;

describe("seed/seed.json", () => {
	const products = seed.collections?.find((c) => c.slug === PRODUCTS_COLLECTION);

	test("declares the products collection (the sync hooks' guard slug)", () => {
		expect(seed.version).toBe("1");
		expect(products).toBeDefined();
	});

	test("carries the CmsProductContent field set", () => {
		const bySlug = new Map(products?.fields.map((f) => [f.slug, f]));
		expect(bySlug.get("title")).toMatchObject({ type: "string", required: true });
		expect(bySlug.get("description")?.type).toBe("text");
		expect(bySlug.get("images")?.type).toBe("image");
		// NOTE: no `slug` FIELD — "slug" is in em-dash's RESERVED_FIELD_SLUGS
		// (every entry carries a built-in slug; seed entries set it top-level).
		expect(bySlug.has("slug")).toBe(false);
	});

	test("the collection description signposts where pricing moved to", () => {
		// After PR 1b the products editor shows title/description/images and
		// nothing else, and a merchant who used to price here has no in-product
		// pointer to where it went. This is the only signpost the seed format can
		// carry — `SeedField` has no `description` key, only `SeedCollection` does
		// — and em-dash surfaces it on Admin → Content Types, not in the editor.
		// Weak, but better than a repo README a store operator never reads.
		expect(products?.description).toMatch(/Pricing & inventory/);
	});

	test("declares NO commerce field — the CMS stores no commercial data (PR 1b)", () => {
		const slugs = products?.fields.map((f) => f.slug) ?? [];
		expect(slugs).not.toContain("commerce");
		// Exactly the content field set, nothing else: a differently-named bag
		// would be the same bug wearing a different hat.
		expect(slugs).toEqual(["title", "description", "images"]);
	});

	test("binds NO plugin field widget — the plugin registers none (PR 1b)", () => {
		// The binding, not the field type, is what mounts a plugin widget in
		// em-dash's `ContentEditor` (`if (field.widget)`). With no binding
		// anywhere, no widget can mount, so the content editor cannot become a
		// commerce editor again by accident.
		for (const field of products?.fields ?? []) {
			expect(field.widget).toBeUndefined();
		}
	});

	test("sample entries (browsable catalog on first boot) are published products", () => {
		const entries = seed.content?.[PRODUCTS_COLLECTION] ?? [];
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry.slug.length).toBeGreaterThan(0);
			expect(typeof entry.data["title"]).toBe("string");
			// The demo entries carry CONTENT only. They get their commerce rows
			// from `scripts/seed-demo-commerce.ts`, because em-dash's seed applier
			// writes through `ContentRepository` directly and fires no content
			// hooks — so nothing in this file can ever produce a priced product.
			expect(entry.data).not.toHaveProperty("commerce");
		}
	});
});
