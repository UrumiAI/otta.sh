/**
 * THE theme list — the single source of which storefront themes exist.
 *
 * Pure data, deliberately: no `.astro` import, no IO, so a build config can
 * import it as safely as the site can. `registry.ts` maps each id to its
 * components, and `themes-boundary.test.ts` holds the registry to exactly this
 * list.
 *
 * A theme is added HERE when it is built, not before: listing an id the
 * registry cannot render would put an option in the admin that silently falls
 * back to Tempered. Phase 1 ships Tempered alone; `plinth`, `pressing`,
 * `batch`, `jumble` and `counter` arrive one PR each.
 */

export interface StoreThemeEntry {
	/** Stable id — what the plugin stores under kv `settings:storeTheme`. */
	readonly id: string;
	/** What the admin shows a merchant. */
	readonly label: string;
}

export const STORE_THEMES = [
	{ id: "tempered", label: "Tempered" },
] as const satisfies readonly StoreThemeEntry[];

export type ThemeId = (typeof STORE_THEMES)[number]["id"];

/** Today's look, and where every unknown, absent or unreadable setting lands. */
export const DEFAULT_THEME_ID: ThemeId = "tempered";

/** Is `value` the id of a theme this build ships? */
export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === "string" && STORE_THEMES.some((theme) => theme.id === value);
}
