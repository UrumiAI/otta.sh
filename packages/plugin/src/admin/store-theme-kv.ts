/**
 * The storefront theme SETTING — its one kv key, its fallback, its read and its
 * ONE write path.
 *
 * Two admin surfaces change the theme: the Block Kit Settings screen's "Store
 * theme" radio (`settings-form.ts`, the fallback surface) and the React Themes
 * screen's "Activate" (`themes-console-route.ts`, ADR-0014 as amended
 * 2026-09-30). Both call {@link saveStoreTheme}, so there is exactly one place
 * that decides which ids may be stored — an id the SITE offers, never one the
 * plugin knows — and exactly one place that writes the key. A second copy of
 * that check would be the first thing to drift.
 */
import type { PluginContext } from "../types.js";
import { currentStoreTheme, type StoreTheme } from "./store-themes.js";

/** The kv key for the storefront theme id (one of the site's baked
 *  `__OTTA_STORE_THEMES__` ids — see `store-themes.ts`). The site reads it back
 *  as `getPluginSetting("otta", "storeTheme")`. */
export const STORE_THEME_KEY = "settings:storeTheme";

/**
 * The theme id the store is on, as the admin should show it: the stored id when
 * the site still offers it, else the preferred fallback (`tempered`) when the
 * site offers that — the same answer the site's own resolver reaches — else the
 * site's first theme ({@link currentStoreTheme}). Always one the site offers.
 *
 * FAIL-SOFT: a kv read that rejects reads as "nothing stored", because the
 * theme is presentation and a kv blip must not take an admin screen down.
 * Callers with no list must not call this (there is nothing to resolve against).
 */
export async function readStoreThemeId(
	ctx: PluginContext,
	storeThemes: readonly StoreTheme[],
): Promise<string> {
	const stored = await ctx.kv.get<string>(STORE_THEME_KEY).catch(() => null);
	return currentStoreTheme(storeThemes, stored);
}

/** Why a save wrote nothing. `no-themes`: the build baked no list (sandbox,
 *  other hosts), so there is nothing to validate against. `not-offered`: the id
 *  is not one the site offers. */
export type StoreThemeRefusal = "no-themes" | "not-offered";

export type StoreThemeSaveOutcome =
	| { readonly ok: true; readonly theme: StoreTheme }
	| { readonly ok: false; readonly reason: StoreThemeRefusal };

/**
 * THE write path. Stores `raw` only when it is exactly the id of a theme the
 * site offers; anything else — a non-string, a case variant, an id a later build
 * dropped — writes nothing. A kv write that rejects propagates: the caller
 * reports it, and must never claim a save that did not happen.
 */
export async function saveStoreTheme(
	ctx: PluginContext,
	storeThemes: readonly StoreTheme[] | undefined,
	raw: unknown,
): Promise<StoreThemeSaveOutcome> {
	if (storeThemes === undefined) return { ok: false, reason: "no-themes" };
	const chosen =
		typeof raw === "string" ? storeThemes.find((theme) => theme.id === raw) : undefined;
	if (chosen === undefined) return { ok: false, reason: "not-offered" };
	await ctx.kv.set(STORE_THEME_KEY, chosen.id);
	return { ok: true, theme: chosen };
}
