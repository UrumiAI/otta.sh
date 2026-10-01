/**
 * The admin-only LIVE THEME PREVIEW (ADR-0024, amended 2026-09-30).
 *
 * The React Themes screen frames the storefront in an `<iframe>` at
 * `/?preview_theme=<id>` so a merchant can walk the store in a theme before
 * activating it. This module decides, per request, whether that is honoured.
 *
 * WHO. Only a signed-in, enabled user whose role is ADMIN (50) or above.
 * EmDash's auth middleware sets `Astro.locals.user` on public routes too (a
 * soft session check that never blocks), and it already drops a disabled user;
 * `disabled` is re-checked here anyway, because a preview is the one place a
 * storefront response depends on who is asking and the check costs nothing.
 * Everyone else — anonymous shoppers, customers, editors — gets the STORED
 * theme whatever the URL or cookie says: the parameter is not a way to show a
 * shopper an unreleased look.
 *
 * WHAT. A theme id this build ships (`isThemeId`). Anything else is ignored.
 *
 * HOW IT PERSISTS. The iframe's links are the theme's ordinary links, with no
 * parameter on them, so the choice rides a session cookie
 * (`otta_theme_preview`: HttpOnly, SameSite=Lax, Path=/, Secure outside dev, no
 * Max-Age) — honoured under the same admin rule, and cleared by
 * `?preview_theme=off` (the preview pill's "Exit preview" link, and what the
 * Themes screen loads when its overlay closes). The pill's link is a
 * navigation, answered with a redirect to the clean URL. The Themes screen's
 * exit adds `&silent=1` and is answered with an EMPTY 200: it only needs the
 * clearing `Set-Cookie`, not a home page rendered into a hidden frame, and it
 * needs a `load` to know the cookie is gone before it frames the next preview
 * (Chromium fires no `load` for a frame navigation answered 204).
 *
 * CACHING. A previewed response is per-user by construction, so it is sent
 * `Cache-Control: private, no-store` — never stored by a shared cache that
 * could hand it to a shopper, and never replayed from the admin's own cache
 * after the preview ends.
 *
 * Pure: the decision is a function of (url, cookie, user, dev) so it is tested
 * without a server; `src/middleware.ts` applies it.
 */
import { THEME_PREVIEW_OFF, THEME_PREVIEW_PARAM, THEME_PREVIEW_SILENT } from "@otta-sh/plugin";
import { isThemeId, type ThemeId } from "../themes/manifest.js";

export { THEME_PREVIEW_OFF, THEME_PREVIEW_PARAM, THEME_PREVIEW_SILENT };

/** The session cookie that carries an admin's preview across in-frame links. */
export const THEME_PREVIEW_COOKIE = "otta_theme_preview";

/** EmDash's ADMIN role level (`@emdash-cms/auth` `Role.ADMIN`). Stated as a
 *  number rather than imported: the site does not depend on the auth package,
 *  and the level is part of EmDash's stable role scale (10…50). */
export const THEME_PREVIEW_MIN_ROLE = 50;

/** `Cache-Control` for a previewed response. */
export const THEME_PREVIEW_NO_STORE = "private, no-store";

/** The subset of EmDash's `User` (`App.Locals["user"]`) this reads. */
export interface PreviewUser {
	readonly role: number;
	readonly disabled: boolean;
}

/** May this user preview themes? Fails CLOSED: `disabled` must be exactly
 *  `false` (a missing or non-boolean flag is not an enabled user). */
export function canPreviewThemes(user: PreviewUser | null | undefined): boolean {
	return (
		user !== null &&
		user !== undefined &&
		user.disabled === false &&
		typeof user.role === "number" &&
		user.role >= THEME_PREVIEW_MIN_ROLE
	);
}

export interface ThemePreviewDecision {
	/** The theme to render instead of the stored one, or `null`. */
	readonly themeId: ThemeId | null;
	/** What to do with the cookie on the way out. */
	readonly cookie: { readonly set: ThemeId } | "clear" | "keep";
	/** `?preview_theme=off`: answer with a redirect to the same URL without the
	 *  parameter, so the address the merchant is left on is a clean one. */
	readonly exitTo: string | null;
	/** `?preview_theme=off&silent=1` (the Themes screen's hidden exit frame):
	 *  answer with an empty body instead of the redirect. */
	readonly silent: boolean;
}

const NONE: ThemePreviewDecision = { themeId: null, cookie: "keep", exitTo: null, silent: false };

/** The URL with the preview parameters removed (path + remaining query).
 *  Always a same-site PATH: leading slashes are collapsed to one, so a request
 *  for `//evil.example/?preview_theme=off` can never redirect to a
 *  protocol-relative `//evil.example/`. */
function withoutPreviewParam(url: URL): string {
	const clean = new URL(url);
	clean.searchParams.delete(THEME_PREVIEW_PARAM);
	clean.searchParams.delete(THEME_PREVIEW_SILENT);
	return `${clean.pathname.replace(/^\/+/, "/")}${clean.search}`;
}

/**
 * Decide the preview for one storefront request.
 *
 *  1. `?preview_theme=off` ends a preview for anyone (clearing a cookie is never
 *     a privilege) and redirects to the clean URL (or, with `&silent=1`, is
 *     answered with an empty body).
 *  2. `?preview_theme=<shipped id>` from an admin previews it and sets the cookie.
 *  3. Otherwise a cookie naming a shipped id, from an admin, previews it.
 *  4. A cookie nobody may use (unknown id, or not an admin) is cleared; the
 *     request renders the stored theme.
 */
export function decideThemePreview(input: {
	url: URL;
	cookie: string | undefined;
	user: PreviewUser | null | undefined;
}): ThemePreviewDecision {
	const requested = input.url.searchParams.get(THEME_PREVIEW_PARAM);
	if (requested === THEME_PREVIEW_OFF) {
		return {
			themeId: null,
			cookie: "clear",
			exitTo: withoutPreviewParam(input.url),
			silent: input.url.searchParams.get(THEME_PREVIEW_SILENT) === "1",
		};
	}
	const admin = canPreviewThemes(input.user);
	if (admin && isThemeId(requested)) {
		return { themeId: requested, cookie: { set: requested }, exitTo: null, silent: false };
	}
	if (input.cookie === undefined) return NONE;
	if (admin && isThemeId(input.cookie)) {
		return { themeId: input.cookie, cookie: "keep", exitTo: null, silent: false };
	}
	return { themeId: null, cookie: "clear", exitTo: null, silent: false };
}

/** The pill's "Exit preview" link: this page, with `?preview_theme=off`. Any
 *  `silent` parameter is dropped, so the pill's Exit always lands on a page,
 *  never on the Themes screen's empty exit response. */
export function themePreviewExitHref(url: URL): string {
	const exit = new URL(url);
	exit.searchParams.delete(THEME_PREVIEW_SILENT);
	exit.searchParams.set(THEME_PREVIEW_PARAM, THEME_PREVIEW_OFF);
	return `${exit.pathname.replace(/^\/+/, "/")}${exit.search}`;
}

const perRequest = new WeakMap<object, ThemeId>();

/** Record this request's preview on its `locals` (set by the middleware). */
export function setRequestThemePreview(locals: object, themeId: ThemeId): void {
	perRequest.set(locals, themeId);
}

/** The theme this request is previewing, or `null` — read by the resolver and
 *  by the Storefront shell's "Previewing" pill. */
export function requestThemePreview(locals: object): ThemeId | null {
	return perRequest.get(locals) ?? null;
}
