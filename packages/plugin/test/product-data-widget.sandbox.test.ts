import { describe, expect, test } from "vitest";
import { buildProductDataElements, productDataWidget } from "../src/admin/product-data-widget.js";
import { URUMI_PLUGIN_CAPABILITIES } from "../src/manifest.js";

// The ONLY element types em-dash's `BlockKitFieldWidget` renders — anything
// else (notably `button`) shows as "Unsupported widget element type"
// (`~/em-dash` packages/admin/src/components/BlockKitFieldWidget.tsx). The
// whole rework exists because the old tree emitted a `button` here.
const FIELD_WIDGET_SUPPORTED_TYPES = new Set([
	"text_input",
	"number_input",
	"toggle",
	"select",
	"media_picker",
]);

describe('"Product data" field widget — inline inputs, no button (issue #81 rework)', () => {
	test("the widget declares Block Kit elements (no React), all with an action_id", () => {
		expect(productDataWidget.name).toBe("product-data");
		expect(productDataWidget.fieldTypes).toContain("json");
		expect(Array.isArray(productDataWidget.elements)).toBe(true);
		// No React entry — sandboxed widgets render from `elements`, never `entry`.
		expect("entry" in productDataWidget).toBe(false);
		// em-dash filters out elements without an action_id (they can't map to a
		// value) — every element must carry one.
		for (const el of productDataWidget.elements) {
			expect(typeof el.action_id).toBe("string");
			expect(el.action_id.length).toBeGreaterThan(0);
		}
	});

	test("EVERY element is a field-widget-SUPPORTED type — no `button`, no unsupported element (the crux)", () => {
		const els = buildProductDataElements();
		for (const el of els) {
			expect(FIELD_WIDGET_SUPPORTED_TYPES.has(el.type)).toBe(true);
		}
		// Belt-and-braces: the failure mode this rework fixes is specifically a
		// `button` in a field widget.
		expect(els.some((el) => el.type === "button")).toBe(false);
		expect(productDataWidget.elements.some((el) => el.type === "button")).toBe(false);
	});

	test("the tree carries the full commercial field layout keyed by action_id", () => {
		const actionIds = buildProductDataElements().map((el) => el.action_id);
		expect(actionIds).toEqual(
			expect.arrayContaining([
				"sku",
				"price",
				"currency",
				"onHand",
				"productKind",
				"taxClass",
				"weightGrams",
				"lengthMm",
				"widthMm",
				"heightMm",
			]),
		);
	});

	test("price is a number_input labelled as integer MINOR units, with an explicit whole-number hint; currency + kind are selects with options", () => {
		const els = buildProductDataElements();
		const price = els.find((el) => el.action_id === "price");
		expect(price?.type).toBe("number_input");
		const priceLabel = (price as { label?: string }).label ?? "";
		expect(priceLabel).toMatch(/minor units/i);
		// em-dash's BlockKitFieldWidget drops any `min`/`step` an element declares,
		// so the label is the only client-side affordance we have against the
		// decimal-entry P1. `content:beforeSave` is the actual guard.
		expect(priceLabel).toMatch(/whole number/i);
		expect(priceLabel).toMatch(/no decimals/i);

		const currency = els.find((el) => el.action_id === "currency");
		expect(currency?.type).toBe("select");
		expect((currency as { options?: unknown[] }).options?.length).toBeGreaterThan(0);

		const kind = els.find((el) => el.action_id === "productKind");
		expect(kind?.type).toBe("select");
		expect((kind as { options?: Array<{ value: string }> }).options?.map((o) => o.value)).toEqual(
			expect.arrayContaining(["physical", "digital"]),
		);
	});

	test("the widget tree is STATIC — em-dash fills values from the stored `commerce` JSON, so the builder is deterministic", () => {
		// No live-state fetch / no state argument: two calls are structurally
		// identical (values live in the field JSON the editor loaded, not here).
		expect(buildProductDataElements()).toEqual(buildProductDataElements());
	});

	test("sandbox-clean guard: the manifest declares EXACTLY content:read + content:write + network:request, no storage/db surface", () => {
		// `content:write` is MANDATORY, not optional tidiness: em-dash's
		// `HookPipeline.registerPluginHook` maps `content:beforeSave →
		// content:write` and silently SKIPS a hook whose capability is absent, so
		// without it the price-validation hook is dead code in production
		// (ADR-0012). It is broader than what we use — in trusted mode it grants
		// hook-free transactional write access to every collection — and is bounded
		// compile-time by `PluginContext` having no `content` member, plus the
		// handler's `collection !== "products"` early return.
		expect(URUMI_PLUGIN_CAPABILITIES).toEqual(["content:read", "content:write", "network:request"]);
		expect(URUMI_PLUGIN_CAPABILITIES).not.toContain("network:request:unrestricted");
		for (const cap of URUMI_PLUGIN_CAPABILITIES) {
			expect(cap.startsWith("storage")).toBe(false);
			expect(cap.startsWith("kv")).toBe(false);
			expect(cap.startsWith("db")).toBe(false);
		}
		// The complementary static guard — no DB/storage/filesystem import
		// anywhere in packages/plugin/src — is the `plugin-is-sandbox-clean`
		// dependency-cruiser rule, wired into `pnpm lint` (.dependency-cruiser.cjs).
	});
});
