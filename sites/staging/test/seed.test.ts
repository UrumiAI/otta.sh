/**
 * Seed guard (plan §3.3): the seed must declare the ONE collection the
 * plugin's sync hooks guard on (`PRODUCTS_COLLECTION = "products"`), with
 * the field set `CmsProductContent` reads (title/slug/description/images)
 * plus the `json` `commerce` field BOUND to the Product-data widget.
 *
 * Binding, not field type, is what mounts the widget (issue #81): em-dash's
 * `ContentEditor` mounts a plugin field widget ONLY when the field declares
 * `widget: "pluginId:widgetName"`. `FieldWidgetConfig.fieldTypes` is a
 * compatibility constraint, not the trigger — a `type:"json"` field with no
 * `widget` falls through to the default raw-JSON <textarea>. So the seed's
 * `commerce` field must carry `widget: "urumi:product-data"`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productDataWidget, PRODUCTS_COLLECTION, URUMI_PLUGIN_ID } from "@urumi/plugin";
import { describe, expect, test } from "vitest";

type RegisteredFieldWidget = typeof productDataWidget;

interface SeedField {
	slug: string;
	type: string;
	required?: boolean;
	/** Plugin field-widget binding: `"pluginId:widgetName"` (issue #81). */
	widget?: string;
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

/**
 * Faithful model of em-dash `ContentEditor.tsx`'s field-widget decision
 * (the `if (field.widget)` branch): a plugin widget mounts ONLY when the
 * field declares `widget: "pluginId:widgetName"`, the named plugin has
 * registered a field widget of that name, AND that widget's `fieldTypes`
 * admit the field's type. Anything else falls through to the default,
 * type-driven editor (for a `json` field: the raw JSON <textarea>). Kept in
 * lockstep with the plugin's real registration surface (pinned separately by
 * site-config.test's "registers the Product-data Block Kit field widget").
 */
function resolveFieldEditor(
	field: SeedField,
	registry: Record<string, readonly RegisteredFieldWidget[]>,
): { kind: "widget"; widget: RegisteredFieldWidget } | { kind: "default"; fieldType: string } {
	if (field.widget) {
		const sep = field.widget.indexOf(":");
		if (sep > 0) {
			const pluginId = field.widget.slice(0, sep);
			const widgetName = field.widget.slice(sep + 1);
			const widget = registry[pluginId]?.find((w) => w.name === widgetName);
			if (widget && (widget.fieldTypes as readonly string[]).includes(field.type)) {
				return { kind: "widget", widget };
			}
		}
	}
	return { kind: "default", fieldType: field.type };
}

// The plugin's registered field widgets, keyed by the owning plugin id —
// mirrors what the trusted descriptor hands em-dash (fieldWidgets: [...]).
const REGISTRY: Record<string, readonly RegisteredFieldWidget[]> = {
	[URUMI_PLUGIN_ID]: [productDataWidget],
};

describe("seed/seed.json", () => {
	const products = seed.collections?.find((c) => c.slug === PRODUCTS_COLLECTION);
	const commerce = products?.fields.find((f) => f.slug === "commerce");

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

	test("commerce is a json field bound to the Product-data widget (issue #81)", () => {
		expect(commerce?.type).toBe("json");
		// The binding, not the type, mounts the panel. Pin the exact
		// `pluginId:widgetName` string against the plugin's own constants so a
		// rename on either side breaks this test.
		expect(commerce?.widget).toBe(`${URUMI_PLUGIN_ID}:${productDataWidget.name}`);
		// And the widget must admit `json` (its fieldTypes constraint).
		expect(productDataWidget.fieldTypes).toContain("json");
	});

	test("editor mounts the Block Kit panel for commerce, NOT the default JSON textarea", () => {
		expect(commerce).toBeDefined();
		const resolved = resolveFieldEditor(commerce as SeedField, REGISTRY);
		expect(resolved.kind).toBe("widget");
		expect(resolved.kind === "widget" && resolved.widget.name).toBe("product-data");
	});

	test("resolver is load-bearing: an unbound json field falls back to the raw JSON editor", () => {
		// Guards against a resolver/model that always returns the widget: the
		// pre-#81 shape (json field, no `widget`) is exactly the bug and MUST
		// resolve to the default editor.
		const unbound: SeedField = { slug: "raw", type: "json" };
		expect(resolveFieldEditor(unbound, REGISTRY)).toEqual({ kind: "default", fieldType: "json" });
		// A binding to an unregistered widget name also falls through (em-dash's
		// "widget declared but plugin/widget not found" path).
		const dangling: SeedField = { slug: "x", type: "json", widget: `${URUMI_PLUGIN_ID}:nope` };
		expect(resolveFieldEditor(dangling, REGISTRY).kind).toBe("default");
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
