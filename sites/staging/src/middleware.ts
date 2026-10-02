/**
 * The site's own middleware. It decides one thing: who may be served a stored
 * copy of a storefront page (ADR-0024).
 *
 * A page that draws the shopper's own bag is PER-SHOPPER. For a theme that opts
 * into the chrome's cart-lines read (`ThemeModule.chrome.cartLines`), a request
 * carrying a cart cookie can render that shopper's lines into the header of any
 * page, so its HTML is sent `private, no-store` and kept out of Astro's route
 * cache — it must never be stored and replayed to anyone else. Any other theme
 * renders the same page for every shopper, and its caching is left alone.
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
 * write.
 */
import { CART_COOKIE_NAME } from "@otta-sh/plugin";
import { defineMiddleware } from "astro:middleware";
import { PRIVATE_NO_STORE } from "./lib/no-store.js";
import { themeFor } from "./themes/registry.js";
import { activeTheme } from "./themes/resolve.js";

/** `Cache-Control` for a page that drew one shopper's bag — the site's ONE
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
	if (request.method !== "GET" && request.method !== "HEAD") return next();
	if (url.pathname.startsWith("/_")) return next();

	// A shopper with a cart, on a theme whose chrome draws the cart's lines.
	// The theme is asked only when there IS a cart cookie, and `activeTheme` is
	// memoized per request, so the shell's own call reuses this answer. It is
	// asked on every such GET, not only pages (an endpoint or a redirect too):
	// deliberate, since it is one memoized read and the HTML check below is what
	// decides the header.
	const cartId = cookies.get(CART_COOKIE_NAME)?.value;
	if (cartId === undefined || cartId.length === 0) return next();
	if (themeFor(await activeTheme(context)).chrome?.cartLines !== true) return next();
	skipRouteCache(context);
	const response = await next();
	// Again after the page (TWO CACHES above).
	skipRouteCache(context);
	const html = response.headers.get("Content-Type")?.includes("text/html") ?? false;
	return html ? noStore(response, PRIVATE_NO_STORE) : response;
});
