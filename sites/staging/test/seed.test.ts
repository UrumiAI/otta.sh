/**
 * Seed guard (plan §3.3): the seed must declare the ONE collection the
 * plugin's sync hooks guard on (`PRODUCTS_COLLECTION = "products"`), with
 * the field set `CmsProductContent` reads (title/description/images) plus the
 * variants repeater (ADR-0016) — and NOTHING commercial.
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

interface SeedSubField {
	slug: string;
	type: string;
	required?: boolean;
}

interface SeedField {
	slug: string;
	type: string;
	required?: boolean;
	/** Plugin field-widget binding: `"pluginId:widgetName"`. The products
	 *  collection must declare NONE — the plugin registers no field widget. */
	widget?: string;
	/** em-dash puts a repeater's sub-field declarations inside `validation`
	 *  (`FieldValidation.subFields`), not in a sibling `fields` array. */
	validation?: { subFields?: SeedSubField[]; maxItems?: number };
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
		expect(slugs).toEqual(["title", "description", "images", "variants"]);
	});

	// -- the variant repeater (ADR-0016) -------------------------------------
	// A variant's NAME is content: translated, and the label a storefront picker
	// renders. It lives here, beside the product's own title, and the commerce
	// side caches it through the one sync channel — the same shape ADR-0013
	// established for the product title, one level down.
	test("the variants field is a repeater of exactly a key and a name", () => {
		const variants = products?.fields.find((f) => f.slug === "variants");
		expect(variants?.type).toBe("repeater");
		const subFields = variants?.validation?.subFields ?? [];
		// EXACTLY TWO, AND THIS IS THE LOAD-BEARING ASSERTION. The repeater is
		// the CMS's statement of which sizes exist and what each is called; a
		// third sub-field is how a price or a sku gets back into the content
		// document and makes the CMS a second writer again — the whole failure
		// PR 1b removed at product grain and ADR-0016 forbids at variant grain.
		expect(subFields.map((f) => f.slug)).toEqual(["key", "name"]);
		for (const subField of subFields) {
			expect(subField.type).toBe("string");
			// BOTH sub-fields are required. The key is the variant's identity and a
			// row without one declares nothing; the name is what a picker renders and
			// what an order line freezes, so an editor that let a merchant save a
			// nameless size would be shipping blank labels to customers. The sync
			// still tolerates a missing name (it clears the cache rather than
			// refusing the size), because non-editor clients — an import, a CLI or
			// API write, a seed — bypass this validation.
			expect(subField.required).toBe(true);
		}
	});

	test("the repeater carries a deliberate fan-out bound", () => {
		// Every declared row is one request on every save of the document, and the
		// drop-set read is one more. The bound is a decision rather than a limit
		// discovered in production: 50 sizes is far past any real garment or
		// hardware range, and it caps a single save's variant fan-out at a number
		// that stays comfortable on a fire-and-forget hook with no retry.
		const variants = products?.fields.find((f) => f.slug === "variants");
		expect(variants?.validation?.maxItems).toBe(50);
	});

	test("the seed stays INERT for the live catalogue — no sample entry declares a variant", () => {
		// The sync reads `data.variants` and does nothing at all when the key is
		// absent, so every existing product syncs exactly as it did before
		// variants existed — not one extra request. Seeding a variant row here
		// would silently change that for the demo catalogue.
		for (const entry of seed.content?.[PRODUCTS_COLLECTION] ?? []) {
			expect(entry.data).not.toHaveProperty("variants");
		}
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
