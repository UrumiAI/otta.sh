/**
 * The site's own middleware. It does ONE thing: the admin-only live theme
 * preview (`src/lib/theme-preview.ts`, ADR-0024 as amended 2026-09-30).
 *
 * WHY MIDDLEWARE AND NOT THE STOREFRONT SHELL. The preview sets a cookie and a
 * `Cache-Control` header, and Astro lets only the PAGE (or middleware) touch the
 * response — a layout renders while the body may already be streaming. Every
 * storefront page would otherwise have to repeat the same three lines, and the
 * first page to forget would cache a preview.
 *
 * ORDER. EmDash's middlewares are all `order: "pre"`, so they have run by the
 * time this does: `locals.user` is already the session's user (or absent) on
 * public routes too.
 *
 * TWO CACHES. `Cache-Control: private, no-store` keeps a preview out of HTTP
 * caches, but NOT out of Astro's route cache (e.g. Workers Cache on
 * Cloudflare): the adapter derives that cache's TTL from the route-cache
 * options, not from the header, and a stored entry is served without running
 * middleware again. So, as EmDash does for its own session-specific responses,
 * every previewed response and every exit also calls `context.cache.set(false)`.
 * A preview calls it both before AND after `next()`: in Astro 7 any later
 * `cache.set(options)` (a page's `Astro.cache.set(hint)`) clears the disabled
 * flag again, and the route cache reads the options only once `next()` has
 * returned, so the call after the page is the one that counts. With no cache
 * provider configured it is a no-op.
 *
 * SCOPE. Storefront GET/HEAD only. `/_emdash/*` (the admin and its API) and
 * `/_astro/*`, `/_image` (assets) are passed straight through, as is every
 * write: a preview changes presentation, never what a POST does.
 */
import { defineMiddleware } from "astro:middleware";
import {
	decideThemePreview,
	setRequestThemePreview,
	THEME_PREVIEW_COOKIE,
	THEME_PREVIEW_NO_STORE,
} from "./lib/theme-preview.js";

/** Mark a response private. A `Response` built by `Response.redirect()` (or
 *  handed through from elsewhere) can carry IMMUTABLE headers, so a refusal to
 *  set is answered by copying the response rather than by sending it cacheable. */
function noStore(response: Response): Response {
	try {
		response.headers.set("Cache-Control", THEME_PREVIEW_NO_STORE);
		return response;
	} catch {
		const copy = new Response(response.body, response);
		copy.headers.set("Cache-Control", THEME_PREVIEW_NO_STORE);
		return copy;
	}
}

/** Opt this request out of Astro's route cache (see TWO CACHES above). */
function skipRouteCache(context: { cache?: { set(options: false): void } }): void {
	context.cache?.set(false);
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { request, url, cookies, locals } = context;
	if (request.method !== "GET" && request.method !== "HEAD") return next();
	if (url.pathname.startsWith("/_")) return next();

	const decision = decideThemePreview({
		url,
		cookie: cookies.get(THEME_PREVIEW_COOKIE)?.value,
		user: locals.user,
	});

	if (decision.cookie === "clear") {
		cookies.delete(THEME_PREVIEW_COOKIE, { path: "/" });
	} else if (decision.cookie !== "keep") {
		cookies.set(THEME_PREVIEW_COOKIE, decision.cookie.set, {
			path: "/",
			httpOnly: true,
			sameSite: "lax",
			secure: !import.meta.env.DEV,
			// No maxAge / expires: a session cookie, gone with the browser session.
		});
	}

	if (decision.exitTo !== null) {
		skipRouteCache(context);
		// The Themes screen's hidden exit frame wants the clearing cookie and a
		// `load`, not a page: an empty 200 (Chromium fires no `load` on a 204).
		if (decision.silent) return noStore(new Response(null, { status: 200 }));
		return noStore(context.redirect(decision.exitTo, 303));
	}

	if (decision.themeId === null) return next();

	skipRouteCache(context);
	setRequestThemePreview(locals, decision.themeId);
	const response = await next();
	// Again after the page: its own `Astro.cache.set(hint)` re-enables the cache.
	skipRouteCache(context);
	// Whatever the page set (a public page may set none; the account pages set
	// their own no-store): a previewed response is private to this admin.
	return noStore(response);
});
