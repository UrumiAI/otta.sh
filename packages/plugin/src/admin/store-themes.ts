/**
 * The storefront themes the SITE offers, as a build-time Vite define.
 *
 * The plugin does not know which themes exist — the site does, and it bakes the
 * list into this bundle as `__OTTA_STORE_THEMES__` (a JSON array of
 * `{ id, label }`), the same way it bakes the egress URLs (`manifest.ts`,
 * `__OTTA_EMAIL_API_URL__`). The `typeof` guard makes the undeclared global safe
 * in the plain tsdown dist, this package's vitest run and the sandbox harness,
 * all of which bake nothing.
 *
 * ABSENT IS A REAL STATE, not an error: a host that offers no themes gets no
 * "Store theme" picker, and `save-theme` is refused (`settings-form.ts`). Anything
 * the shape check does not accept is treated as absent, so a malformed define
 * can never put an arbitrary string into the admin form or into kv.
 */
declare const __OTTA_STORE_THEMES__: unknown;

/**
 * One theme the site offers: a stable id (what kv stores), its admin label, and
 * — for the React Themes screen (ADR-0014, amended 2026-09-30) — an optional
 * one-line description and an optional preview image path.
 */
export interface StoreTheme {
	id: string;
	label: string;
	/** One sentence for the Themes card and the live-preview bar. */
	description?: string;
	/** A SAME-ORIGIN absolute path to a static screenshot, e.g.
	 *  `/theme-previews/plinth.webp`. Never a URL: the admin renders it as an
	 *  `<img src>`, and a baked host would be an egress the build never named. */
	preview?: string;
}

/**
 * THE LIVE-PREVIEW CONTRACT between the admin and the site, named once, here.
 *
 * The site honours `?preview_theme=<id>` for a signed-in ADMIN only
 * (`sites/staging/src/lib/theme-preview.ts`) and remembers it in a session
 * cookie so in-frame navigation stays in the previewed theme; `off` clears it.
 * The plugin serves the resulting URLs to the React Themes screen as data, so
 * the console never spells the parameter itself and the site reads the same
 * constant rather than a copy of the string.
 */
export const THEME_PREVIEW_PARAM = "preview_theme";

/** The value that ends a preview. It can never name a theme: the shape check
 *  refuses a baked id equal to it, so `?preview_theme=off` is unambiguous. */
export const THEME_PREVIEW_OFF = "off";

/** Beside `off`: `silent=1` asks for an empty answer instead of a redirect to
 *  the page. The Themes screen's hidden exit frame sends it; it needs the
 *  cookie cleared, not a storefront page rendered where nobody sees it. */
export const THEME_PREVIEW_SILENT = "silent";

/** A theme id: lowercase slug, letter first, at most 32 characters. */
const THEME_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** A theme label must fit beside the display name in the Store group's label. */
const THEME_LABEL_MAX = 40;

/** A description is one line on a card, not a paragraph. */
const THEME_DESCRIPTION_MAX = 160;

/**
 * A preview path: rooted at `/`, but not protocol-relative (`//host/…`), made
 * only of path-safe characters (no `\`, no `:`, no query or fragment), with no
 * `..` segment, ending in an image extension. Anything else would let the baked
 * list aim the admin's `<img>` somewhere other than this site's own assets.
 */
const THEME_PREVIEW = /^\/(?!\/)[A-Za-z0-9/_.-]{1,200}\.(webp|png|jpe?g|avif)$/;

function isPreviewPath(value: unknown): value is string {
	return typeof value === "string" && THEME_PREVIEW.test(value) && !value.split("/").includes("..");
}

function isStoreTheme(entry: unknown): entry is StoreTheme {
	if (typeof entry !== "object" || entry === null) return false;
	const { id, label, description, preview } = entry as Record<string, unknown>;
	return (
		typeof id === "string" &&
		THEME_ID.test(id) &&
		id !== THEME_PREVIEW_OFF &&
		typeof label === "string" &&
		label.length > 0 &&
		label.length <= THEME_LABEL_MAX &&
		(description === undefined ||
			(typeof description === "string" &&
				description.length > 0 &&
				description.length <= THEME_DESCRIPTION_MAX)) &&
		(preview === undefined || isPreviewPath(preview))
	);
}

/**
 * Validate a raw theme list: a NON-EMPTY array whose EVERY entry is a
 * well-formed `{ id, label, description?, preview? }`. Anything else — one bad
 * entry included, a bad preview path included — is `undefined` (absent). Only
 * those four keys survive, and an optional one only when it was present.
 */
export function resolveStoreThemes(raw: unknown): readonly StoreTheme[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	if (!raw.every(isStoreTheme)) return undefined;
	return raw.map(({ id, label, description, preview }) => ({
		id,
		label,
		...(description === undefined ? {} : { description }),
		...(preview === undefined ? {} : { preview }),
	}));
}

/** The theme a store falls back to when nothing valid is stored — a PREFERENCE,
 *  not a hard-coded list entry: it is used only when the site offers it. */
export const DEFAULT_STORE_THEME = "tempered";

/**
 * The theme the admin shows as current: the stored id when the site offers it;
 * else {@link DEFAULT_STORE_THEME} when the site offers that; else the site's
 * first theme. Always one of `storeThemes` (which the shape check keeps
 * non-empty), so a picker's initial value is always an option and a label never
 * falls back to a raw id.
 */
export function currentStoreTheme(storeThemes: readonly StoreTheme[], stored: unknown): string {
	const offered = (id: unknown): string | undefined =>
		storeThemes.find((theme) => theme.id === id)?.id;
	return (
		offered(stored) ?? offered(DEFAULT_STORE_THEME) ?? storeThemes[0]?.id ?? DEFAULT_STORE_THEME
	);
}

/** The baked list, resolved once. `undefined` when the site baked none. */
export const STORE_THEMES: readonly StoreTheme[] | undefined =
	typeof __OTTA_STORE_THEMES__ === "undefined"
		? undefined
		: resolveStoreThemes(__OTTA_STORE_THEMES__);

/** The storefront home page rendered in `themeId`, for an admin. */
export function themePreviewUrl(themeId: string): string {
	return `/?${THEME_PREVIEW_PARAM}=${encodeURIComponent(themeId)}`;
}

/** The URL that ends a preview session from the Themes screen (silently). */
export const THEME_PREVIEW_EXIT_URL = `/?${THEME_PREVIEW_PARAM}=${THEME_PREVIEW_OFF}&${THEME_PREVIEW_SILENT}=1`;
