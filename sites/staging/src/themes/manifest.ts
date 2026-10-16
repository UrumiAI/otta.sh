/**
 * THE theme list — the single source of which storefront themes exist.
 *
 * Pure data, deliberately: no `.astro` import, no IO. `registry.ts` maps each
 * id to its components, and `themes-boundary.test.ts` holds the registry to
 * exactly this list.
 *
 * Tempered is the only theme (ADR-0024's amendment of 2026-10-15: Otta does
 * not support external themes). The five other themes built here (Plinth,
 * Pressing, Batch, Jumble, Counter) moved out on 2026-10-01 and are not coming
 * back as plug-ins; the shell and the middleware render `DEFAULT_THEME_ID`.
 */

export interface StoreThemeEntry {
	/** Stable id — `data-theme-id` on `<html>`. */
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

/** The one theme every storefront page renders. */
export const DEFAULT_THEME_ID: ThemeId = "tempered";
