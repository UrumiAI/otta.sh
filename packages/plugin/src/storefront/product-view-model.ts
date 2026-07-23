/**
 * The storefront view model (Phase 2 steps 9/10, shape per ADR-0003): the
 * plugin's public routes return THIS as JSON; a thin theme/template Astro
 * page renders it to HTML (in-process via
 * `locals.emdash.handlePublicPluginApiRoute`, like em-dash's forms plugin).
 * All storefront intelligence lives here in the sandbox-tested plugin — the
 * theme shim maps view model → markup and nothing else.
 *
 * Localization: `price.formatted` is real `Intl` output for the requested
 * locale (RTL-safe by construction — never hand-assembled symbol+number
 * strings), and `availability` is a SEMANTIC TOKEN, not display text — the
 * theme translates tokens through its own i18n layer, so no English string
 * is baked into the plugin's output.
 */
import type { JoinedProduct } from "../catalog/join-product.js";
import { formatMoney } from "../presentation/format-money.js";
import { STOREFRONT_CART_LINE_ADD_ROUTE } from "./cart-routes.js";
import type { ButtonElement, Element, NumberInputElement } from "../types.js";

export type AvailabilityToken = "in_stock" | "out_of_stock";

/**
 * Phase 3 group E's add-to-cart affordance — Block Kit (not React,
 * DEVELOPMENT.md §5), rendered ONLY for a `purchasable` product (the gate is
 * this view model's own `purchasable` flag; this function does not
 * re-derive it, per this task's mandate).
 *
 * `idempotencyKey` (plan §8 Risk 8): a FRESH UUID generated here, at view-
 * model build time — i.e. once per PDP render, not once per process/module
 * load. Verified generation point: `buildProductViewModel` runs inside the
 * PDP route handler's `renderGuard` closure (`pdp-route.ts`), which executes
 * fresh on every `invokeRoute` call under the workerd sandbox (there is no
 * cross-request memoization anywhere in this path — `createCommerceLoader`
 * is already documented request-scoped) — so a page reload mints a new key.
 * A double-click on the SAME rendered button reuses the SAME key (idempotent
 * double-submit safety, the property Risk 8 asks for); a fresh page load
 * mints a new one. `crypto.randomUUID()` is the Web Crypto global — present
 * under workerd and Node, no capability declaration needed (it is pure
 * computation, not IO; the sandbox-clean guard only polices network egress).
 */
export interface AddToCartSlot {
	/** The plugin's public route this affordance submits to
	 *  (`cart-routes.ts`) — echoed here so a theme shim needs no hardcoded
	 *  knowledge of the route name. */
	route: typeof STOREFRONT_CART_LINE_ADD_ROUTE;
	sku: string;
	/** The CMS content id (the join key to `product_commerce`) — issue #80. The
	 *  add-to-cart path MUST forward this so the created cart line carries a
	 *  non-null `product_id`; without it the line cannot be priced and every
	 *  `POST /checkout/quote` 409s `PRODUCT_NOT_PRICED`. */
	productId: string;
	idempotencyKey: string;
	/** Block Kit elements — a qty stepper + submit button. The button's
	 *  `value` carries the payload a click must forward verbatim (`sku`,
	 *  `productId`, `idempotencyKey`) — Block Kit `ButtonElement.value` is echoed
	 *  back on click by design (`types.ts`), the mechanism plan §8 Risk 5 relies on. */
	elements: Element[];
}

function buildAddToCartSlot(sku: string, productId: string): AddToCartSlot {
	const idempotencyKey = crypto.randomUUID();
	const qtyInput: NumberInputElement = {
		type: "number_input",
		action_id: "urumi_add_to_cart_qty",
		label: "Quantity",
		initial_value: 1,
	};
	const submitButton: ButtonElement = {
		type: "button",
		action_id: "urumi_add_to_cart_submit",
		label: "Add to cart",
		value: { route: STOREFRONT_CART_LINE_ADD_ROUTE, sku, productId, idempotencyKey },
	};
	return {
		route: STOREFRONT_CART_LINE_ADD_ROUTE,
		sku,
		productId,
		idempotencyKey,
		elements: [qtyInput, submitButton],
	};
}

export interface ProductPriceViewModel {
	/** Integer minor units + ISO-4217 — for themes that need the raw value.
	 *  (Brands live in the plugin's typed layers; JSON erases them.) */
	amount: number;
	currency: string;
	/** Locale-formatted display string (the §4.6 boundary's output). */
	formatted: string;
}

export interface ProductViewModel {
	id: string;
	title: string;
	slug?: string;
	description?: string;
	images?: string[];
	url?: string;
	/** THE sellability flag (§4.2) — one truth for price slot, JSON-LD, and
	 *  Phase 3's add-to-cart gate alike. */
	purchasable: boolean;
	sku: string | null;
	/** null when not purchasable: no price, no formatted-money string (§4.5). */
	price: ProductPriceViewModel | null;
	/** Semantic token (theme localizes); null when not purchasable. Coarse,
	 *  display-only (plan §8 risk 5) — never the purchase authority. */
	availability: AvailabilityToken | null;
	/**
	 * Phase 3 group E's add-to-cart affordance (formerly the P3-GROUP-E
	 * extension seam Phase 2 always rendered `null`): a Block Kit fragment
	 * gated on THIS view model's `purchasable` flag — `null` whenever the
	 * product isn't purchasable (no sku to add, per §4.5/§3), a slot
	 * descriptor otherwise. Phase 2's contract that the slot rides the same
	 * `purchasable` flag as price/availability is unchanged; this is the
	 * seam being filled, not repurposed.
	 */
	slots: { addToCart: AddToCartSlot | null };
}

export function buildProductViewModel(joined: JoinedProduct, locale: string): ProductViewModel {
	const { content, commerce, purchasable } = joined;
	// Commercial fields render only for a PURCHASABLE product (§4.5, and
	// §4.2's inactive arm): an inactive/unpublished commerce row displays
	// exactly like a missing one — flagged, no price, no availability.
	const sellable = purchasable && commerce !== null ? commerce : null;
	const model: ProductViewModel = {
		id: content.id,
		title: content.title,
		purchasable,
		sku: sellable === null ? null : sellable.sku,
		price:
			sellable === null
				? null
				: {
						amount: sellable.price.amount,
						currency: sellable.price.currency,
						formatted: formatMoney(sellable.price.amount, sellable.price.currency, locale),
					},
		availability: sellable === null ? null : sellable.inStock ? "in_stock" : "out_of_stock",
		// The affordance needs a sku to submit; gating on `sellable` (not just
		// `purchasable`) means an inconsistent purchasable-but-no-sku state
		// (shouldn't happen — `sellable` is derived from the same commerce
		// row — but stays defensive rather than emitting an unsku'd button).
		// `content.id` IS the productId (the CMS content id = product_commerce join
		// key, join-product.ts) — thread it so the add-to-cart line is priceable
		// (issue #80).
		slots: {
			addToCart: sellable === null ? null : buildAddToCartSlot(sellable.sku, content.id),
		},
	};
	if (content.slug !== undefined) model.slug = content.slug;
	if (content.description !== undefined) model.description = content.description;
	if (content.images !== undefined) model.images = content.images;
	if (content.url !== undefined) model.url = content.url;
	return model;
}
