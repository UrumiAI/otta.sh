/**
 * THE theme list — the single source of which storefront themes exist.
 *
 * Pure data, deliberately: no `.astro` import, no IO. Two consumers read it and
 * they must not be able to disagree:
 *
 *  - `astro.config.ts` bakes it into the build as the Vite define
 *    `__OTTA_STORE_THEMES__` (JSON `[{ id, label, description, preview }]`),
 *    which is how the plugin's admin Settings radio and the React Themes screen
 *    learn the options without hard-coding a theme list of their own;
 *  - `registry.ts` maps each id to its components, and
 *    `themes-boundary.test.ts` holds the registry to exactly this list.
 *
 * A theme is added HERE when it is built, not before: listing an id the
 * registry cannot render would put an option in the admin that silently falls
 * back to Tempered. All six ship: Tempered (the default), Plinth, Pressing,
 * Batch, Jumble and Counter.
 */

export interface StoreThemeEntry {
	/** Stable id — what the plugin stores under kv `settings:storeTheme`. */
	readonly id: string;
	/** What the admin shows a merchant. 1–40 characters (the plugin's check). */
	readonly label: string;
	/** One line for the admin Themes card and live-preview bar. ≤ 160 chars. */
	readonly description: string;
	/**
	 * The Themes card's screenshot: a SAME-ORIGIN path under `public/`, always
	 * `/theme-previews/<id>.webp`. Regenerate with `pnpm capture:theme-previews`
	 * (scripts/capture-theme-previews.ts); `theme-previews.test.ts` fails a
	 * theme whose file is missing or the wrong size.
	 */
	readonly preview: string;
}

export const STORE_THEMES = [
	{
		id: "tempered",
		label: "Tempered",
		description: "Condensed headlines and a live stock table.",
		preview: "/theme-previews/tempered.webp",
	},
	{
		id: "plinth",
		label: "Plinth",
		description: "A quiet gallery: stone tones and wide margins.",
		preview: "/theme-previews/plinth.webp",
	},
	{
		id: "pressing",
		label: "Pressing",
		description: "Record-sleeve blue, sleeve pink and big type.",
		preview: "/theme-previews/pressing.webp",
	},
	{
		id: "batch",
		label: "Batch",
		description: "Kraft paper, a letterpress label and a green stamp.",
		preview: "/theme-previews/batch.webp",
	},
	{
		id: "jumble",
		label: "Jumble",
		description: "Sunny, rounded and playful — a toy shop.",
		preview: "/theme-previews/jumble.webp",
	},
	{
		id: "counter",
		label: "Counter",
		description: "Clean, calm and product-first.",
		preview: "/theme-previews/counter.webp",
	},
] as const satisfies readonly StoreThemeEntry[];

export type ThemeId = (typeof STORE_THEMES)[number]["id"];

/** Today's look, and where every unknown, absent or unreadable setting lands. */
export const DEFAULT_THEME_ID: ThemeId = "tempered";

/** Is `value` the id of a theme this build ships? */
export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === "string" && STORE_THEMES.some((theme) => theme.id === value);
}
