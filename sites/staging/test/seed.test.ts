/**
 * Seed guard (plan §3.3): the seed must declare the ONE collection the
 * plugin's sync hooks guard on (`PRODUCTS_COLLECTION = "products"`), with
 * the field set `CmsProductContent` reads (title/slug/description/images)
 * plus a `json` field so the Product-data widget can attach
 * (`productDataWidget.fieldTypes === ["json"]`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productDataWidget, PRODUCTS_COLLECTION } from "@urumi/plugin";
import { describe, expect, test } from "vitest";

interface SeedField {
	slug: string;
	type: string;
	required?: boolean;
}

interface SeedCollection {
	slug: string;
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

	test("carries a json field the Product-data widget can attach to", () => {
		const jsonFields = products?.fields.filter((f) => f.type === "json") ?? [];
		expect(jsonFields.length).toBeGreaterThan(0);
		// The widget attaches by field TYPE — pin the assumption to the
		// plugin's own declaration so a widget change breaks this test.
		expect(productDataWidget.fieldTypes).toContain("json");
	});

	test("sample entries (browsable catalog on first boot) are published products", () => {
		const entries = seed.content?.[PRODUCTS_COLLECTION] ?? [];
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry.slug.length).toBeGreaterThan(0);
			expect(typeof entry.data["title"]).toBe("string");
		}
	});
});
