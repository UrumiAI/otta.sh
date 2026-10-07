/**
 * Which theme renders THIS request.
 *
 * THE SETTING. The active theme is plugin kv `settings:storeTheme`. Nothing in
 * this repo writes it today (the admin's picker was removed — see below); a
 * theme installed from the separate themes repo must ship its own write path.
 * EmDash's `createKVAccess` prefixes every plugin kv key with `plugin:<id>:`,
 * so the row lands in the options table as `plugin:otta:settings:storeTheme` —
 * and EmDash's public `getPluginSetting(pluginId, key)` reads exactly
 * `plugin:<id>:settings:<key>` (emdash@1.0.1, `src/settings/index.ts`
 * `getPluginSettingWithDb`). On 1.0.1 a `settings:*` kv key goes through the
 * plugin settings layer (`src/plugins/settings.ts` `createSettingsAccess`),
 * which writes the same `plugin:<id>:settings:<key>` row. So the site reads the
 * plugin's write as `getPluginSetting("otta", "storeTheme")` with no shared
 * constant to drift.
 * `test/theme-resolve.test.ts` proves that round trip against a real migrated
 * host database: a real plugin route's `ctx.kv.set` in, this module's read out.
 *
 * FAIL-SOFT, ALWAYS. An unknown id (a theme removed from a later build), an
 * absent row (a store that never chose), a malformed value, or a read that
 * THROWS (content store unreachable) all render Tempered. The theme is
 * presentation; it must never be the reason a page 500s.
 *
 * ONE READ PER REQUEST. The Storefront shell asks once per render; the answer is
 * memoized against the request's `Astro.locals` object, which lives exactly as
 * long as the request.
 *
 * THE DEV OVERRIDE. `?theme=<id>` picks a registered theme for screenshots and
 * e2e — only when `import.meta.env.DEV`, which a production build replaces with
 * `false`, so the branch is dead code in anything deployed.
 *
 * NO ADMIN PICKER. The store ships one theme, Tempered; the admin's Themes
 * screen, its live preview and the Settings "Store theme" choice were removed
 * (ADR-0024's amendment of 2026-10-02). The stored setting is still READ, so a theme
 * installed from the separate themes repo can be activated by whatever ships
 * with it; anything unknown falls back to Tempered.
 */
import { OTTA_PLUGIN_ID } from "@otta-sh/plugin";
import { getPluginSetting } from "emdash";
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "./manifest.js";

/** The kv key's suffix — the plugin writes `settings:storeTheme`. */
export const STORE_THEME_SETTING = "storeTheme";

export type ThemeSettingReader = () => Promise<unknown>;

const readStoredSetting: ThemeSettingReader = () =>
	getPluginSetting(OTTA_PLUGIN_ID, STORE_THEME_SETTING);

/** The stored choice, or the default for anything unusable. Never throws. */
export async function readStoredThemeId(
	read: ThemeSettingReader = readStoredSetting,
): Promise<ThemeId> {
	let raw: unknown;
	try {
		raw = await read();
	} catch (error) {
		console.error("[site-staging] store theme read threw:", error);
		raw = undefined;
	}
	return isThemeId(raw) ? raw : DEFAULT_THEME_ID;
}

/** `?theme=<registered id>` in dev; `null` otherwise (and always in production). */
export function devThemeOverride(url: URL, dev: boolean): ThemeId | null {
	if (!dev) return null;
	const requested = url.searchParams.get("theme");
	return isThemeId(requested) ? requested : null;
}

export async function resolveActiveThemeId(options: {
	url: URL;
	dev: boolean;
	read?: ThemeSettingReader;
}): Promise<ThemeId> {
	return devThemeOverride(options.url, options.dev) ?? readStoredThemeId(options.read);
}

const perRequest = new WeakMap<object, Promise<ThemeId>>();

/** The active theme for this request — memoized on `Astro.locals`. */
export function activeTheme(astro: { url: URL; locals: object }): Promise<ThemeId> {
	let pending = perRequest.get(astro.locals);
	if (pending === undefined) {
		pending = resolveActiveThemeId({ url: astro.url, dev: import.meta.env.DEV });
		perRequest.set(astro.locals, pending);
	}
	return pending;
}
