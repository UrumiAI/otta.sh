/**
 * THE theme list — the single source of which storefront themes exist.
 *
 * Pure data, deliberately: no `.astro` import, no IO. `registry.ts` maps each
 * id to its components, and `themes-boundary.test.ts` holds the registry to
 * exactly this list.
 *
 * The admin offers NO theme choice (ADR-0024's amendment of 2026-10-02): the Themes
 * screen, its live preview and the Settings "Store theme" radio were removed,
 * so the store renders Tempered unless a theme installed from the separate
 * themes repo is registered here and activated. A theme is added HERE when it
 * is built, not before: an id the registry cannot render falls back to
 * Tempered. One ships in this repo: Tempered (the default). The five
 * other themes built here (Plinth, Pressing, Batch, Jumble, Counter) moved out
 * on 2026-10-01 to their own repo, to come back as external themes once the
 * theme SDK and host integration exist.
 */

export interface StoreThemeEntry {
	/** Stable id — what the plugin stores under kv `settings:storeTheme`. */
	readonly id: string;
	/** The theme's human name. */
	readonly label: string;
}

export const STORE_THEMES = [
	{
		id: "tempered",
		label: "Tempered",
	},
] as const satisfies readonly StoreThemeEntry[];

export type ThemeId = (typeof STORE_THEMES)[number]["id"];

/** Today's look, and where every unknown, absent or unreadable setting lands. */
export const DEFAULT_THEME_ID: ThemeId = "tempered";

/** Is `value` the id of a theme this build ships? */
export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === "string" && STORE_THEMES.some((theme) => theme.id === value);
}
