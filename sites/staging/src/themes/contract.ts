/**
 * The theme contract — what a page hands a theme, and what a theme must provide.
 *
 * ADR-0003 still holds (the plugin serves view models, the theme owns every
 * byte of markup); this file is the seam INSIDE the site between the page,
 * which owns every decision, and the theme, which owns only presentation.
 *
 * THE RULE THE MODELS ENCODE: a model is the page's finished answer. Every
 * value a view prints is already computed — the BUSY copy, the hold note, the
 * sold-out flag, the return path, the idempotency key. A view never reads
 * `Astro.url`, a cookie, a cart id, `Astro.response` or an error token, and
 * never imports `lib/otta-api`, `origin-guard`, `cart-cookie` or
 * `checkout-cookie`. `themes-boundary.test.ts` sweeps `src/themes/**` for
 * exactly that, so a second theme cannot quietly grow a second copy of the
 * store's logic.
 *
 * Money arrives pre-formatted (docs/theme/TEMPERED.md §7): no model carries an
 * amount a view could format.
 */
import type { AvailabilityToken } from "@otta-sh/plugin";
import type { TapeRow } from "../lib/tape.js";
import type { ThemeId } from "./manifest.js";

export type { ThemeId } from "./manifest.js";

// ── Chrome ────────────────────────────────────────────────────────────────

export interface ChromeNavItem {
	label: string;
	url: string;
	/** This item is the cart — the one that carries the count badge. */
	isCart: boolean;
}

/** Everything a theme's Layout renders around a page. Built by Storefront.astro. */
export interface ChromeModel {
	/** The store's name, CMS-owned; "Otta" when unset or unreadable. */
	siteTitle: string;
	/** The document <title>. */
	fullTitle: string;
	description: string | null;
	/** The primary menu, Account link already appended. */
	navItems: readonly ChromeNavItem[];
	/** Units in the cart, or `null` for "this page read no cart" (never `0`). */
	cartCount: number | null;
	/** The spoken form of `cartCount` ("3 items"), `null` exactly when it is. */
	cartCountLabel: string | null;
	/** The currency CODE the page quoted, or `null` when it quoted none (§7). */
	currency: string | null;
	themeId: ThemeId;
}

// ── Home ──────────────────────────────────────────────────────────────────

export interface HomeModel {
	/** The hero headline (the store's tagline, or its fallback). */
	thesis: string;
	lede: string;
	shopHref: string;
	/** "Shop all 3 items" / "Shop everything" — never a count the page cannot prove. */
	shopLabel: string;
	/** The inventory tape. Empty ⇒ the hero renders thesis-only (the degraded rule). */
	rows: readonly TapeRow[];
	/** The exact catalog size, or `null` when the page cannot state one. */
	count: number | null;
}

// ── Shop ──────────────────────────────────────────────────────────────────

export interface ShopCard {
	href: string;
	/** Keys the coil art — the slug, or the id when there is none. */
	slug: string;
	title: string;
	description: string | null;
	image: string | null;
	/** Pre-formatted price, or `null` for "no figure to show". */
	price: string | null;
	/** What stands where a price would; `undefined` takes the component default. */
	priceNote: string | undefined;
	availability: AvailabilityToken | null;
}

export interface NoticeCopy {
	lead: string;
}

export interface ShopModel {
	/**
	 * `unavailable` — the CONTENT store could not be read (not the empty shop);
	 * `empty` — the catalog genuinely has no products;
	 * `list` — cards to render.
	 */
	state: "unavailable" | "empty" | "list";
	/** Commerce degraded while content rendered: the notice above the grid. */
	degradedNotice: NoticeCopy | null;
	/** The eyebrow ("3 items"), `null` when the count is not exact. */
	countLabel: string | null;
	cards: readonly ShopCard[];
	/** Where an operator of an empty store goes next. */
	adminHref: string;
}

// ── Product ───────────────────────────────────────────────────────────────

/** The hidden-field contract `/cart/add` reads — see src/forms/AddToCartFields.astro. */
export interface AddToCartModel {
	sku: string;
	productId: string;
	/** The plugin's, minted per rendered PDP. Never minted by a theme. */
	idempotencyKey: string;
	/** Where the cart sends the shopper back to on an error. */
	returnTo: string;
}

export interface ProductPurchase {
	/** Pre-formatted, off `price.formatted`. */
	priceFormatted: string;
	/** Strike the price: not in stock (degraded is never "purchasable"). */
	priceStruck: boolean;
	availability: AvailabilityToken | null;
	sku: string | null;
	/** The add-to-cart form — present only for a product actually in stock. */
	addToCart: AddToCartModel | null;
	/** The effective cart-hold window, in minutes, as the route reported it. */
	cartHoldMinutes: number | undefined;
	/** The sentence stating that window. */
	holdNote: string;
	/** The explicit `out_of_stock` token — offers the way on. */
	soldOut: boolean;
}

export interface ProductContentModel {
	state: "ok";
	title: string;
	description: string | null;
	/** Keys the coil art (the product's own slug or id). */
	art: string;
	image: string | null;
	/** Dims the art: the explicit sold-out token, never `!inStock`. */
	dimmed: boolean;
	/** Commerce degraded — the notice lead (BUSY copy already chosen), else `null`. */
	degradedLead: string | null;
	/** A cart error carried back on the URL, already mapped to shopper copy. */
	errorMessage: string | null;
	/** Priced and sellable: the ledger and buy row. `null` otherwise. */
	purchase: ProductPurchase | null;
	/** Neither purchasable nor degraded: say so in prose. */
	showNotForSale: boolean;
}

export type ProductModel =
	| ProductContentModel
	/** The address resolves to nothing (404). */
	| { state: "notFound" }
	/** The content store could not be read (503). */
	| { state: "unavailable" };

// ── Theme module ──────────────────────────────────────────────────────────

/**
 * An Astro component as a registry holds it. `.astro` default exports are
 * typed by the Astro toolchain; the registry only needs "callable with these
 * props", so that is all this states.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Astro's own component factory type
export type AstroComponent<P> = (props: P) => any;

export interface ThemeViews {
	home: AstroComponent<{ model: HomeModel }>;
	shop: AstroComponent<{ model: ShopModel }>;
	product: AstroComponent<{ model: ProductModel }>;
}

export interface ThemeModule {
	id: ThemeId;
	/** Owns <html>, <head> (its own fonts + stylesheet) and the chrome. */
	Layout: AstroComponent<{ chrome: ChromeModel }>;
	/** Partial: an unported view falls back to Tempered's, in THIS theme's tokens. */
	views: Partial<ThemeViews>;
}
