/**
 * Which FILE renders a given view for each theme — for the source-pin suites
 * whose markup moved out of the pages and into theme views (Phase 3).
 *
 * A pin that used to read `pages/cart/index.astro` now has to hold for EVERY
 * theme's cart, because any theme may render it: a theme's own view when it has
 * ported one, and Tempered's (the registry's `viewFor` fallback) when it has
 * not. So the suites sweep `viewSources(...)` — one entry per registered theme,
 * resolved the way the registry resolves it — with the assertions they always
 * had. A theme that ports its cart tomorrow is covered the moment its file
 * lands, and `themes-boundary.test.ts` holds the registry's wiring to the files
 * on disk so the resolution here cannot drift from the real one.
 *
 * Not a `.test.ts`: `vitest.config.ts` collects `*.test.ts` only.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STORE_THEMES } from "../src/themes/manifest.js";

export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Registry key → the file each theme names it by. */
export const COMMERCE_VIEW_FILES = {
	cart: "CartView.astro",
	checkout: "CheckoutView.astro",
	pay: "PayView.astro",
	order: "OrderView.astro",
	accountLogin: "AccountLoginView.astro",
	accountVerify: "AccountVerifyView.astro",
	accountOrders: "AccountOrdersView.astro",
	accountOrder: "AccountOrderView.astro",
} as const;

export type CommerceView = keyof typeof COMMERCE_VIEW_FILES;

export const THEME_IDS: readonly string[] = STORE_THEMES.map((theme) => theme.id);

/** `themes/<id>/<File>` when that theme ships one, else Tempered's (the fallback). */
export function viewFileFor(themeId: string, view: CommerceView): string {
	const own = `themes/${themeId}/${COMMERCE_VIEW_FILES[view]}`;
	return existsSync(path.join(SRC, own)) ? own : `themes/tempered/${COMMERCE_VIEW_FILES[view]}`;
}

export interface ViewSource {
	/** The theme this entry renders for. */
	theme: string;
	/** `src/`-relative path of the file that renders it. */
	file: string;
	source: string;
}

/** One entry per registered theme: the source of the view that renders `view` for it. */
export function viewSources(view: CommerceView): ViewSource[] {
	return THEME_IDS.map((theme) => {
		const file = viewFileFor(theme, view);
		return { theme, file, source: readFileSync(path.join(SRC, file), "utf8") };
	});
}

/** `[label, entry]` rows for `test.each` / `describe.each`, labelled "tempered → themes/…". */
export function viewCases(view: CommerceView): [string, ViewSource][] {
	return viewSources(view).map((entry) => [`${entry.theme} → ${entry.file}`, entry]);
}
