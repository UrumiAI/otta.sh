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
import type { ThemeModule, ThemeViews } from "./contract.js";
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
	/* The header's cart count and signed-in state on every storefront page
	   (QA U-12, U-14) — see ThemeChromeNeeds.shopperState. */
	chrome: { shopperState: true },
} satisfies ThemeModule & { views: ThemeViews };

/** Every theme the manifest lists, and nothing else (held equal by test). */
export const THEMES: Readonly<Record<ThemeId, ThemeModule>> = {
	tempered,
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
