/**
 * Theme id → the components that render it.
 *
 * WHY STATIC IMPORTS ARE SAFE HERE, AND WHAT THEY COST. Astro links the CSS of
 * every component in a page's static import graph, so this file puts every
 * registered theme's components on every page. That is harmless for markup
 * (only the active theme's components are called) and is exactly why a theme's
 * `.astro` files may carry NO `<style>` block: each theme's Layout links its
 * own stylesheet through a `?url` import, so only the ACTIVE theme's CSS
 * reaches the browser. `themes-boundary.test.ts` enforces the no-`<style>`
 * rule. (Phase 1 exception: the shared `src/components/*` keep their scoped
 * styles — they are Tempered's today and harmless on any page.)
 */
import BatchAccountLoginView from "./batch/AccountLoginView.astro";
import BatchAccountOrdersView from "./batch/AccountOrdersView.astro";
import BatchAccountOrderView from "./batch/AccountOrderView.astro";
import BatchAccountVerifyView from "./batch/AccountVerifyView.astro";
import BatchCartView from "./batch/CartView.astro";
import BatchCheckoutView from "./batch/CheckoutView.astro";
import BatchHomeView from "./batch/HomeView.astro";
import BatchLayout from "./batch/Layout.astro";
import BatchOrderView from "./batch/OrderView.astro";
import BatchPayView from "./batch/PayView.astro";
import BatchProductView from "./batch/ProductView.astro";
import BatchShopView from "./batch/ShopView.astro";
import type { ThemeModule, ThemeViews } from "./contract.js";
import CounterAccountLoginView from "./counter/AccountLoginView.astro";
import CounterAccountOrdersView from "./counter/AccountOrdersView.astro";
import CounterAccountOrderView from "./counter/AccountOrderView.astro";
import CounterAccountVerifyView from "./counter/AccountVerifyView.astro";
import CounterCartView from "./counter/CartView.astro";
import CounterCheckoutView from "./counter/CheckoutView.astro";
import CounterHomeView from "./counter/HomeView.astro";
import CounterLayout from "./counter/Layout.astro";
import CounterOrderView from "./counter/OrderView.astro";
import CounterPayView from "./counter/PayView.astro";
import CounterProductView from "./counter/ProductView.astro";
import CounterShopView from "./counter/ShopView.astro";
import JumbleAccountLoginView from "./jumble/AccountLoginView.astro";
import JumbleAccountOrdersView from "./jumble/AccountOrdersView.astro";
import JumbleAccountOrderView from "./jumble/AccountOrderView.astro";
import JumbleAccountVerifyView from "./jumble/AccountVerifyView.astro";
import JumbleCartView from "./jumble/CartView.astro";
import JumbleCheckoutView from "./jumble/CheckoutView.astro";
import JumbleHomeView from "./jumble/HomeView.astro";
import JumbleLayout from "./jumble/Layout.astro";
import JumbleOrderView from "./jumble/OrderView.astro";
import JumblePayView from "./jumble/PayView.astro";
import JumbleProductView from "./jumble/ProductView.astro";
import JumbleShopView from "./jumble/ShopView.astro";
import type { ThemeId } from "./manifest.js";
import TemperedAccountLoginView from "./tempered/AccountLoginView.astro";
import TemperedAccountOrdersView from "./tempered/AccountOrdersView.astro";
import TemperedAccountOrderView from "./tempered/AccountOrderView.astro";
import TemperedAccountVerifyView from "./tempered/AccountVerifyView.astro";
import TemperedCartView from "./tempered/CartView.astro";
import TemperedCheckoutView from "./tempered/CheckoutView.astro";
import temperedCommerceHref from "./tempered/commerce.css?url";
import TemperedHomeView from "./tempered/HomeView.astro";
import TemperedLayout from "./tempered/Layout.astro";
import TemperedOrderView from "./tempered/OrderView.astro";
import TemperedPayView from "./tempered/PayView.astro";
import TemperedProductView from "./tempered/ProductView.astro";
import TemperedShopView from "./tempered/ShopView.astro";

const tempered = {
	id: "tempered",
	Layout: TemperedLayout,
	views: {
		home: TemperedHomeView,
		shop: TemperedShopView,
		product: TemperedProductView,
		cart: TemperedCartView,
		checkout: TemperedCheckoutView,
		pay: TemperedPayView,
		order: TemperedOrderView,
		accountLogin: TemperedAccountLoginView,
		accountVerify: TemperedAccountVerifyView,
		accountOrders: TemperedAccountOrdersView,
		accountOrder: TemperedAccountOrderView,
	},
} satisfies ThemeModule & { views: ThemeViews };

/** Every view its own. No drawer, so no chrome cart read: the bag is `/cart`. */
const batch = {
	id: "batch",
	Layout: BatchLayout,
	views: {
		home: BatchHomeView,
		shop: BatchShopView,
		product: BatchProductView,
		cart: BatchCartView,
		checkout: BatchCheckoutView,
		pay: BatchPayView,
		order: BatchOrderView,
		accountLogin: BatchAccountLoginView,
		accountVerify: BatchAccountVerifyView,
		accountOrders: BatchAccountOrdersView,
		accountOrder: BatchAccountOrderView,
	},
} satisfies ThemeModule & { views: ThemeViews };

/** Every view its own. No drawer, so no chrome cart read: the bag is `/cart`,
 *  where the newest line hops up into the header bag. */
const jumble = {
	id: "jumble",
	Layout: JumbleLayout,
	views: {
		home: JumbleHomeView,
		shop: JumbleShopView,
		product: JumbleProductView,
		cart: JumbleCartView,
		checkout: JumbleCheckoutView,
		pay: JumblePayView,
		order: JumbleOrderView,
		accountLogin: JumbleAccountLoginView,
		accountVerify: JumbleAccountVerifyView,
		accountOrders: JumbleAccountOrdersView,
		accountOrder: JumbleAccountOrderView,
	},
} satisfies ThemeModule & { views: ThemeViews };

/** Every view its own, and the one theme whose chrome draws the cart's lines
 *  (the bag drawer) — so the one theme that pays the shell's bag read. */
const counter = {
	id: "counter",
	Layout: CounterLayout,
	views: {
		home: CounterHomeView,
		shop: CounterShopView,
		product: CounterProductView,
		cart: CounterCartView,
		checkout: CounterCheckoutView,
		pay: CounterPayView,
		order: CounterOrderView,
		accountLogin: CounterAccountLoginView,
		accountVerify: CounterAccountVerifyView,
		accountOrders: CounterAccountOrdersView,
		accountOrder: CounterAccountOrderView,
	},
	chrome: { cartLines: true },
} satisfies ThemeModule & { views: ThemeViews };

/** Every theme the manifest lists, and nothing else (held equal by test). */
export const THEMES: Readonly<Record<ThemeId, ThemeModule>> = {
	tempered,
	batch,
	jumble,
	counter,
};

export function themeFor(id: ThemeId): ThemeModule {
	return THEMES[id];
}

/** The theme's own view, or Tempered's when the theme has not ported it yet. */
export function viewFor<K extends keyof ThemeViews>(theme: ThemeModule, view: K): ThemeViews[K] {
	return theme.views[view] ?? tempered.views[view];
}

/** The views whose Tempered rendering is styled by `tempered/commerce.css`. */
const TEMPERED_COMMERCE_VIEWS: ReadonlySet<keyof ThemeViews> = new Set([
	"cart",
	"checkout",
	"pay",
	"order",
	"accountLogin",
	"accountVerify",
	"accountOrders",
	"accountOrder",
] satisfies (keyof ThemeViews)[]);

/**
 * The extra stylesheet a view needs beyond its theme's own sheets, or `null`.
 *
 * Tempered's commerce views are EVERY theme's fallback, so their sheet cannot
 * ride Tempered's Layout: the shell links it whenever the view about to render
 * is Tempered's commerce view — under Tempered, or under a theme that has not
 * ported that view — and on no other page. A `?url` import, like every theme
 * sheet, so nothing joins a page's CSS by side effect.
 */
export function fallbackSheetFor(theme: ThemeModule, view: keyof ThemeViews): string | null {
	if (!TEMPERED_COMMERCE_VIEWS.has(view)) return null;
	return viewFor(theme, view) === tempered.views[view] ? temperedCommerceHref : null;
}
