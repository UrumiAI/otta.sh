import type { CommerceProductKind } from "../product-commerce/commerce-client.js";
import type { Element, FieldWidgetConfig } from "../types.js";

const CURRENCY_OPTIONS = [
	{ value: "USD", label: "USD" },
	{ value: "EUR", label: "EUR" },
	{ value: "GBP", label: "GBP" },
];

const PRODUCT_KIND_OPTIONS: Array<{ value: CommerceProductKind; label: string }> = [
	{ value: "physical", label: "Physical" },
	{ value: "digital", label: "Digital" },
];

/**
 * Builds the "Product data" field-widget's Block Kit element tree (issue #81
 * rework). Pure function, no state, no React (DEVELOPMENT.md §5).
 *
 * ── Why this is INLINE INPUTS with NO button (the crux of the rework) ──────
 * em-dash renders a sandboxed field widget through `BlockKitFieldWidget`
 * (`packages/admin/src/components/BlockKitFieldWidget.tsx`), which:
 *   1. supports ONLY `text_input` / `number_input` / `toggle` / `select` /
 *      `media_picker` — ANY other element type (notably `button`) renders as
 *      "Unsupported widget element type", so the old button-bearing tree died
 *      on the first unsupported element and Price/Currency/Stock never showed;
 *   2. has ONLY an `onChange` contract (NO `onAction`/button round-trip): it
 *      decomposes the field's stored JSON into per-`action_id` values and
 *      recomposes on every change (`onChange({ ...obj, [action_id]: value })`),
 *      persisting the whole object as the content document's `commerce` field.
 * So there is nothing for a Save button to POST to, and no way to render one.
 * Instead every commercial value is a supported inline input whose `action_id`
 * is the key it lands under in the `commerce` JSON; the editor's NATIVE Save
 * persists that field, and the sync hooks (sync/hooks.ts) derive
 * `product_commerce` from it.
 *
 * WHEN those values go live depends on the content's state (publish atomicity,
 * plan §2): for a product that is NOT yet live, `content:afterSave` derives and
 * upserts immediately (and does not activate — nothing is published). For a
 * product that IS live, the editor stages the edit as a pending draft, so the
 * save pushes NOTHING and `content:afterPublish` derives, upserts and activates
 * when the merchant clicks "Publish changes" — price and content change in the
 * same operation, never one ahead of the other.
 *
 * ── Why there is deliberately NO title input ───────────────────────────────
 * The product title an order line snapshots is the collection's own Title
 * FIELD, which the merchant edits at the top of this same editor — `sync/hooks.ts`
 * reads it from the content record (`data.title`) on every upsert. A title input
 * HERE would be a second place to type the product name, and the two would
 * drift: the buyer would see one name on the PDP and a different one on the
 * order/receipt. One field, one source of truth.
 *
 * ── Why the tree is STATIC (values are NOT read here) ──────────────────────
 * em-dash renders the widget from the manifest's static `elements` and fills
 * each input's value from the STORED `commerce` field JSON keyed by
 * `action_id` — it ignores element `initial_value`/`disabled`. So there is no
 * live-state fetch and nothing state-dependent to build: the current values
 * come from the persisted field the editor already loaded. (The Stock field's
 * create-only semantics can therefore NOT be enforced in the UI; they are
 * enforced server-side — the service treats `initialOnHand` as a
 * create-if-absent seed that never clobbers an existing/decremented `on_hand`,
 * see `@urumi/domain` `upsertProductCommerce` + `InventoryStore.seedOnHand`.)
 *
 * Help/guidance is carried in labels + placeholders because a non-input block
 * (header/section/banner) is unsupported by the field widget and would render
 * as "Unsupported element". The old "priced but not active" indicator is
 * dropped: pricing a product and publishing it activates the row in the same
 * operation, so the priced-but-inactive window it warned about largely no
 * longer opens. (Merchant-facing copy naming "Publish changes" as the moment
 * pricing goes live is a deliberate follow-up — it would churn localized
 * strings this change does not otherwise touch.)
 */
export function buildProductDataElements(): Element[] {
	return [
		{
			type: "text_input",
			action_id: "sku",
			label: "SKU",
			placeholder: "Stock-keeping unit — required to make the product sellable",
		},
		{
			type: "number_input",
			action_id: "price",
			// Money is integer MINOR units (CLAUDE.md non-negotiable): a decimal
			// entry is rejected at the afterSave derive boundary, never coerced.
			label: "Price (integer minor units — e.g. 1999 = $19.99)",
		},
		{
			type: "select",
			action_id: "currency",
			label: "Currency (ISO-4217)",
			options: CURRENCY_OPTIONS,
		},
		{
			type: "number_input",
			action_id: "onHand",
			// Create-only server-side: sets the INITIAL stock when the row is first
			// created; a re-save never overwrites an existing/decremented on_hand
			// (inventory-managed thereafter via reserve/commit/release/adjust).
			label: "Initial stock on hand (set once; managed via inventory after)",
		},
		{
			type: "select",
			action_id: "productKind",
			label: "Product kind",
			options: PRODUCT_KIND_OPTIONS,
		},
		{
			type: "text_input",
			action_id: "taxClass",
			label: "Tax class",
			placeholder: "Optional tax class code",
		},
		{
			type: "number_input",
			action_id: "weightGrams",
			label: "Weight (g)",
		},
		{
			type: "number_input",
			action_id: "lengthMm",
			label: "Length (mm)",
		},
		{
			type: "number_input",
			action_id: "widthMm",
			label: "Width (mm)",
		},
		{
			type: "number_input",
			action_id: "heightMm",
			label: "Height (mm)",
		},
	];
}

/** The manifest-declared widget config (em-dash `FieldWidgetConfig`). em-dash
 *  renders THESE static `elements` for the sandboxed field widget and fills
 *  their values from the stored `commerce` JSON — there is no live/state-aware
 *  variant (see `buildProductDataElements`). Bound to the products collection's
 *  `json` `commerce` field via `widget: "urumi:product-data"`. */
export const productDataWidget: FieldWidgetConfig = {
	name: "product-data",
	label: "Product data",
	fieldTypes: ["json"],
	elements: buildProductDataElements(),
};
