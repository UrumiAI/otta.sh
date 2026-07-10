import type { CommerceProductKind, ProductCommerce } from "../product-commerce/commerce-client.js";
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

export interface ProductDataWidgetState {
	/** `event.isNew` / absence of `content.id` on the editor side (plan §5). */
	hasProductId: boolean;
	commerce?: ProductCommerce | null;
}

/**
 * Builds the "Product data" panel's Block Kit element tree (plan §5/§6 step
 * 8). Pure function of state — no React (DEVELOPMENT.md §5), no capability
 * use, so it is trivially testable both directly and via the sandbox's
 * `panel-state` route.
 *
 * "Create then price", UX layer (plan §1 case 3): a brand-new unsaved
 * product (`!hasProductId`) renders every field disabled with a "save the
 * product first" notice and NO save action — no commercial write is
 * reachable from here at all (the server-side `MISSING_PRODUCT_ID` guard in
 * the route is the second, API-level layer).
 *
 * The Stock field is create-only (plan §5/§8 Risk 4): once a sku already
 * exists it becomes a disabled/read-only display — further stock changes go
 * exclusively through Phase 3's reserve/commit/release/adjust, never a
 * blind overwrite here.
 */
export function buildProductDataElements(state: ProductDataWidgetState): Element[] {
	if (!state.hasProductId) {
		return [
			{
				type: "text_input",
				action_id: "sku",
				label: "SKU",
				placeholder: "Save the product first to add pricing",
				disabled: true,
			},
			{
				type: "button",
				action_id: "save",
				label: "Save the product first to add pricing",
				disabled: true,
			},
		];
	}

	const commerce = state.commerce ?? null;
	const hasSku = commerce?.sku !== null && commerce?.sku !== undefined;

	const elements: Element[] = [
		{
			type: "text_input",
			action_id: "sku",
			label: "SKU",
			...(commerce?.sku !== null && commerce?.sku !== undefined
				? { initial_value: commerce.sku }
				: {}),
		},
		{
			type: "number_input",
			action_id: "price",
			label: "Price (integer minor units)",
			...(commerce?.price !== null && commerce?.price !== undefined
				? { initial_value: commerce.price.amount }
				: {}),
		},
		{
			type: "select",
			action_id: "currency",
			label: "Currency",
			options: CURRENCY_OPTIONS,
			...(commerce?.price !== null && commerce?.price !== undefined
				? { initial_value: commerce.price.currency }
				: {}),
		},
		{
			type: "number_input",
			action_id: "onHand",
			label: hasSku ? "Stock (on hand) — managed via inventory once set" : "Stock (on hand)",
			// Create-only: once a sku already exists this becomes read-only.
			disabled: hasSku,
		},
		{
			type: "select",
			action_id: "productKind",
			label: "Product kind",
			options: PRODUCT_KIND_OPTIONS,
			initial_value: commerce?.productKind ?? "physical",
		},
		{
			type: "text_input",
			action_id: "taxClass",
			label: "Tax class",
			...(commerce?.taxClass !== null && commerce?.taxClass !== undefined
				? { initial_value: commerce.taxClass }
				: {}),
		},
		{
			type: "number_input",
			action_id: "weightGrams",
			label: "Weight (g)",
			...(commerce?.weightGrams !== null && commerce?.weightGrams !== undefined
				? { initial_value: commerce.weightGrams }
				: {}),
		},
		{
			type: "number_input",
			action_id: "lengthMm",
			label: "Length (mm)",
			...(commerce?.lengthMm !== null && commerce?.lengthMm !== undefined
				? { initial_value: commerce.lengthMm }
				: {}),
		},
		{
			type: "number_input",
			action_id: "widthMm",
			label: "Width (mm)",
			...(commerce?.widthMm !== null && commerce?.widthMm !== undefined
				? { initial_value: commerce.widthMm }
				: {}),
		},
		{
			type: "number_input",
			action_id: "heightMm",
			label: "Height (mm)",
			...(commerce?.heightMm !== null && commerce?.heightMm !== undefined
				? { initial_value: commerce.heightMm }
				: {}),
		},
		{ type: "button", action_id: "save", label: "Save" },
	];
	return elements;
}

/** The manifest-declared widget config — the default (disabled, "create
 *  then price") state, per `FieldWidgetConfig`'s static shape. The live,
 *  state-aware tree is served by the `panel-state` route
 *  (plan §8 Risk 5 — Block Kit action→route plumbing spike). */
export const productDataWidget: FieldWidgetConfig = {
	name: "product-data",
	label: "Product data",
	fieldTypes: ["json"],
	elements: buildProductDataElements({ hasProductId: false }),
};
