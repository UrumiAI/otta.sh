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

export type AvailabilityToken = "in_stock" | "out_of_stock";

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
	 * ── P3-GROUP-E EXTENSION SEAM — do not repurpose ──
	 * Phase 3's add-to-cart affordance hangs HERE: when it lands, a
	 * purchasable product's slot becomes its affordance descriptor (target
	 * cart route, qty constraints, …), gated on THIS view model's
	 * `purchasable` flag (§4.5/§3). Phase 2 always renders `null`: no
	 * add-to-cart surface exists yet, purchasable or not.
	 */
	slots: { addToCart: null };
}

export function buildProductViewModel(joined: JoinedProduct, locale: string): ProductViewModel {
	const { content, commerce, purchasable } = joined;
	const model: ProductViewModel = {
		id: content.id,
		title: content.title,
		purchasable,
		sku: commerce === null ? null : commerce.sku,
		price:
			commerce === null
				? null
				: {
						amount: commerce.price.amount,
						currency: commerce.price.currency,
						formatted: formatMoney(commerce.price.amount, commerce.price.currency, locale),
					},
		availability: commerce === null ? null : commerce.inStock ? "in_stock" : "out_of_stock",
		slots: { addToCart: null },
	};
	if (content.slug !== undefined) model.slug = content.slug;
	if (content.description !== undefined) model.description = content.description;
	if (content.images !== undefined) model.images = content.images;
	if (content.url !== undefined) model.url = content.url;
	return model;
}
