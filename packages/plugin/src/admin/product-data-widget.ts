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
	/**
	 * Whether the CMS content being priced is CURRENTLY PUBLISHED (issue #82).
	 * Baked into the Save button's `value` so the panel Save round-trips it back
	 * to the `product-commerce` route (em-dash `ButtonElement.value` →
	 * `BlockAction.value`), which then activates the just-priced row in the same
	 * operation — no manual unpublish→republish. Undefined ⇒ the host did not
	 * thread a publish signal ⇒ the button carries none ⇒ the route does not
	 * activate (the row stays inactive until `content:afterPublish`).
	 */
	published?: boolean;
	/** The content's `updatedAt` ordering watermark paired with `published`
	 *  (issue #82) — carried alongside it in the Save button `value`. */
	contentUpdatedAt?: string;
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
	const hasPrice = commerce?.price !== null && commerce?.price !== undefined;

	const elements: Element[] = [];

	// Issue #82 (option 2): a lightweight "priced but not active" indicator.
	// When the row is commerce-complete (sku + price set) yet `active=false`, the
	// storefront PDP shows "Not currently available" with no admin signal — a
	// narrow re-creation of #82 whenever activation is lost (e.g. a best-effort
	// activate failed, or the host never carried the publish signal). Surface it
	// so the merchant knows the remedy (publish / re-publish). Rendered as a
	// disabled input because a sandboxed field widget only renders input-like
	// elements (a static banner would show as "Unsupported element"); it carries
	// no editable value and the route ignores its `action_id`.
	if (hasSku && hasPrice && commerce?.active === false) {
		elements.push({
			type: "text_input",
			action_id: "pricedInactiveNotice",
			label: "⚠ Priced but not active — not yet purchasable",
			placeholder: "Publish (or re-publish) this product to make it available on the storefront.",
			disabled: true,
		});
	}

	elements.push(
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
		{
			type: "button",
			action_id: "save",
			label: "Save",
			// Issue #82: carry the CURRENT publish state back to the product-commerce
			// route so a "publish first, price later" product is activated on save
			// (no republish). Only attached when the host threaded a publish signal;
			// absent ⇒ the route does not activate.
			...(state.published !== undefined
				? {
						value: {
							contentPublished: state.published,
							...(state.contentUpdatedAt !== undefined
								? { contentUpdatedAt: state.contentUpdatedAt }
								: {}),
						},
					}
				: {}),
		},
	);
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
