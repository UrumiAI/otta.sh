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

/** One theme the site offers: a stable id (what kv stores) and its admin label. */
export interface StoreTheme {
	id: string;
	label: string;
}

/** A theme id: lowercase slug, letter first, at most 32 characters. */
const THEME_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** A theme label must fit beside the display name in the Store group's label. */
const THEME_LABEL_MAX = 40;

function isStoreTheme(entry: unknown): entry is StoreTheme {
	if (typeof entry !== "object" || entry === null) return false;
	const { id, label } = entry as Record<string, unknown>;
	return (
		typeof id === "string" &&
		THEME_ID.test(id) &&
		typeof label === "string" &&
		label.length > 0 &&
		label.length <= THEME_LABEL_MAX
	);
}

/**
 * Validate a raw theme list: a NON-EMPTY array whose EVERY entry is a
 * well-formed `{ id, label }`. Anything else — one bad entry included — is
 * `undefined` (absent). Only `id` and `label` survive.
 */
export function resolveStoreThemes(raw: unknown): readonly StoreTheme[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	if (!raw.every(isStoreTheme)) return undefined;
	return raw.map(({ id, label }) => ({ id, label }));
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
