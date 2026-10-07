/**
 * The site's own middleware. It decides one thing: who may be served a stored
 * copy of a storefront page (ADR-0024).
 *
 * A page whose chrome draws the shopper's own state is PER-SHOPPER. For a theme
 * that opts into the chrome's cart-lines read (`ThemeModule.chrome.cartLines`)
 * or into the shopper's state (`chrome.shopperState`: the cart count and the
 * signed-in label on every page — QA U-12, U-14), a request carrying a cart
 * cookie can render that shopper's cart into the header of any page, and (for
 * `shopperState`) one carrying a session cookie their signed-in state. Its HTML
 * is sent `private, no-store` and kept out of Astro's route cache — it must
 * never be stored and replayed to anyone else.
 *
 * A request with NEITHER cookie gets the neutral header (no count, "Account"),
 * the same for every such visitor, and its caching is left alone: that is the
 * copy a shared cache may hold. A shopper WITH a cookie can at worst be handed
 * that neutral copy by a cache that ignores cookies — a header missing their
 * state, never someone else's. (A CDN rule that bypasses the cache when
 * `otta_cart` or `otta_session` is present gives them their own.)
 *
 * (The admin-only live theme preview this file used to handle is gone with the
 * admin's theme picker: the store ships one theme, Tempered.)
 *
 * WHY MIDDLEWARE AND NOT THE STOREFRONT SHELL. A `Cache-Control` header can only
 * be set by the PAGE (or middleware) — a layout renders while the body may
 * already be streaming — and every storefront page would otherwise repeat it.
 *
 * ORDER. EmDash's middlewares are all `order: "pre"`, so they have run by the
 * time this does.
 *
 * TWO CACHES. `Cache-Control: private, no-store` keeps a page out of HTTP
 * caches, but NOT out of Astro's route cache (e.g. Workers Cache on
 * Cloudflare): the adapter derives that cache's TTL from the route-cache
 * options, not from the header, and a stored entry is served without running
 * middleware again. So, as EmDash does for its own session-specific responses,
 * every per-shopper page also calls `context.cache.set(false)` — both before
 * AND after `next()`: in Astro 7 any later `cache.set(options)` (a page's
 * `Astro.cache.set(hint)`) clears the disabled flag again, and the route cache
 * reads the options only once `next()` has returned, so the call after the page
 * is the one that counts. With no cache provider configured it is a no-op.
 *
 * SCOPE. Storefront GET/HEAD only. `/_emdash/*` (the admin and its API) and
 * `/_astro/*`, `/_image` (assets) are passed straight through, as is every
 * write — with ONE exception that runs first: EmDash's public media route never
 * serves a key under `dl/`, where
 * paid downloads live (issue #376; `lib/media-deny.ts`). Paid files belong in
 * the private DOWNLOADS bucket, never MEDIA; this is the backstop for one put
 * in the wrong bucket by hand.
 *
 * ONE WRITE IS LOOKED AT, too (issue #405): a plugin-route write (POST, PUT or
 * PATCH — any method but GET, HEAD, DELETE and OPTIONS) that attaches a
 * download file has its key `head()`ed in the DOWNLOADS bucket before EmDash
 * dispatches it, because the plugin cannot reach R2 and a key with no object
 * would 404 every buyer (`lib/download-attach-guard.ts`). Every other write
 * passes through.
 */
import { CART_COOKIE_NAME, SESSION_COOKIE_NAME } from "@otta-sh/plugin";
import { defineMiddleware } from "astro:middleware";
import { env } from "virtual:emdash/env";
import { attachBucketFrom, guardAttachDownload } from "./lib/download-attach-guard.js";
import { UPLOAD_MIN_ROLE } from "./lib/download-upload.js";
import { isPrivateDownloadMediaRequest } from "./lib/media-deny.js";
import { PRIVATE_NO_STORE } from "./lib/no-store.js";
import { themeFor } from "./themes/registry.js";
import { activeTheme } from "./themes/resolve.js";

/** `Cache-Control` for a page that drew one shopper's state — the site's ONE
 *  private, no-store constant, under the name its callers already use. */
export { PRIVATE_NO_STORE as PER_SHOPPER_NO_STORE } from "./lib/no-store.js";

/** Mark a response private. A `Response` built by `Response.redirect()` (or
 *  handed through from elsewhere) can carry IMMUTABLE headers, so a refusal to
 *  set is answered by copying the response rather than by sending it cacheable. */
function noStore(response: Response, value: string = PRIVATE_NO_STORE): Response {
	try {
		response.headers.set("Cache-Control", value);
		return response;
	} catch {
		const copy = new Response(response.body, response);
		copy.headers.set("Cache-Control", value);
		return copy;
	}
}

/** Opt this request out of Astro's route cache (see TWO CACHES above). */
function skipRouteCache(context: { cache?: { set(options: false): void } }): void {
	context.cache?.set(false);
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { request, url, cookies } = context;
	// Every method that can carry a body — the guard decides (it gates all but
	// GET, HEAD, DELETE and OPTIONS, as EmDash's plugin route parses a JSON body
	// for POST, PUT and PATCH alike).
	const locals = context.locals as { user?: unknown; tokenScopes?: unknown };
	const refused = await guardAttachDownload(
		request,
		url,
		{ user: locals.user, tokenScopes: locals.tokenScopes },
		UPLOAD_MIN_ROLE,
		attachBucketFrom(env),
	);
	if (refused !== null) return refused;
	if (request.method !== "GET" && request.method !== "HEAD") return next();
	// Before the `/_` pass-through: the media route is under `/_emdash`. The same
	// plain 404 EmDash answers for a key it does not have, and never stored.
	if (isPrivateDownloadMediaRequest(url)) {
		return new Response("Not found", {
			status: 404,
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": PRIVATE_NO_STORE,
				"X-Content-Type-Options": "nosniff",
			},
		});
	}
	if (url.pathname.startsWith("/_")) return next();

	// A shopper with a cart or a session, on a theme whose chrome draws it. The
	// theme is asked only when there IS such a cookie, and `activeTheme` is
	// memoized per request, so the shell's own call reuses this answer. It is
	// asked on every such GET, not only pages (an endpoint or a redirect too):
	// deliberate, since it is one memoized read and the HTML check below is what
	// decides the header.
	const hasCart = (cookies.get(CART_COOKIE_NAME)?.value ?? "").length > 0;
	const hasSession = (cookies.get(SESSION_COOKIE_NAME)?.value ?? "").length > 0;
	if (!hasCart && !hasSession) return next();
	const chrome = themeFor(await activeTheme(context)).chrome;
	const drawsShopper = chrome?.shopperState === true;
	const perShopper =
		(hasCart && (drawsShopper || chrome?.cartLines === true)) || (hasSession && drawsShopper);
	if (!perShopper) return next();
	skipRouteCache(context);
	const response = await next();
	// Again after the page (TWO CACHES above).
	skipRouteCache(context);
	const html = response.headers.get("Content-Type")?.includes("text/html") ?? false;
	return html ? noStore(response, PRIVATE_NO_STORE) : response;
});
