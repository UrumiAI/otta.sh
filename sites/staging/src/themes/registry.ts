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
import TemperedHomeView from "./tempered/HomeView.astro";
import TemperedLayout from "./tempered/Layout.astro";
import TemperedProductView from "./tempered/ProductView.astro";
import TemperedShopView from "./tempered/ShopView.astro";

const tempered = {
	id: "tempered",
	Layout: TemperedLayout,
	views: { home: TemperedHomeView, shop: TemperedShopView, product: TemperedProductView },
} satisfies ThemeModule & { views: ThemeViews };

/** Every theme the manifest lists, and nothing else (held equal by test). */
export const THEMES: Readonly<Record<ThemeId, ThemeModule>> = { tempered };

export function themeFor(id: ThemeId): ThemeModule {
	return THEMES[id];
}

/** The theme's own view, or Tempered's when the theme has not ported it yet. */
export function viewFor<K extends keyof ThemeViews>(theme: ThemeModule, view: K): ThemeViews[K] {
	return theme.views[view] ?? tempered.views[view];
}
