/**
 * The site's origin-based CSRF guard, applied ONCE, in `src/middleware.ts`, to
 * every state-changing storefront request (issue #376).
 *
 * Needed because the emdash astro integration force-disables Astro's
 * built-in `security.checkOrigin` (it injects `checkOrigin: false` so its
 * own dual-origin CSRF layer can validate at runtime — em-dash
 * `astro/integration/index.ts`), and that replacement layer
 * (`checkPublicCsrf`) covers only `/_emdash/api/*` routes. Theme-owned
 * endpoints get NOTHING unless the site checks them. See ADR-0006's CSRF
 * section.
 *
 * Semantics mirror em-dash's `checkPublicCsrf` / Astro's origin check:
 * a present-but-mismatched `Origin` header is forbidden (browsers always
 * send Origin on cross-site form POSTs, including the opaque "null");
 * an ABSENT Origin is allowed — that's curl / server-to-server, which
 * carries no ambient cookie and is not a CSRF vector. "Same origin" is the
 * REQUEST's own origin (`context.url.origin`: scheme, host and port), exactly
 * what each endpoint compared against before the move; no `Sec-Fetch-Site`,
 * no `Referer` fallback, no configured site URL.
 *
 * WHY DEFAULT-DENY. The guard used to be a call each endpoint had to remember
 * to make first; a new endpoint that forgot it shipped unguarded. Now every
 * non-safe method on every storefront path is checked unless the route is on
 * the explicit exemption list below — so forgetting fails closed (a 403 a
 * developer sees at once) instead of open (a CSRF hole nobody sees). Keying the
 * rule on "every storefront path" rather than on a list of guarded paths also
 * means no spelling of a path (a trailing slash, a percent-encoded letter that
 * Astro decodes before routing) can step around it.
 *
 * WHAT IS NOT CHECKED HERE.
 *  - GET, HEAD and OPTIONS: safe methods; no storefront route changes state on
 *    them through a form a foreign site could post.
 *  - Any path under `/_` — `/_emdash/*` (the admin and its API, which EmDash
 *    guards itself: `X-EmDash-Request: 1` on authenticated routes and
 *    `checkPublicCsrf` on public ones, running before this middleware) and
 *    Astro's own `/_astro`, `/_image`, `/_server-islands`. Checking them here
 *    would double-guard EmDash and, worse, refuse the cross-origin OAuth
 *    protocol routes it exempts on purpose. The same prefix rule the caching
 *    half of the middleware already uses.
 *  - The routes in `ORIGIN_GUARD_EXEMPT_ROUTES`, each with its reason.
 */
import type { APIContext } from "astro";
import { PRIVATE_NO_STORE } from "./no-store.js";

/** Methods that never reach the guard. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Storefront routes (Astro route patterns) a cross-origin write may reach.
 * Keyed by the ROUTE that serves the request (`context.routePattern`), not the
 * raw path, so `/webhooks/stripe/` is exempt too and nothing else is.
 */
export const ORIGIN_GUARD_EXEMPT_ROUTES: ReadonlyMap<string, string> = new Map([
	[
		"/webhooks/stripe",
		// Authority is Stripe's HMAC signature (plus the edge token), which no
		// browser can forge; Stripe sends no Origin, so the guard would pass every
		// genuine delivery anyway. Exempt so a proxy that adds an Origin can never
		// turn a paid order's settlement into a 403 that Stripe gives up on.
		"signature-authenticated server-to-server webhook",
	],
]);

/** The refusal's body: the same words every endpoint sent. */
export const CROSS_ORIGIN_REFUSAL_BODY = "Cross-origin form submissions are forbidden";

/** Pure decision (unit-tested): forbid iff Origin is present and differs
 *  from the request's own origin. */
export function isForbiddenCrossOrigin(
	originHeader: string | null,
	requestOrigin: string,
): boolean {
	return originHeader !== null && originHeader !== requestOrigin;
}

/** Pure decision (unit-tested): is this request one the guard checks at all?
 *  `pathname` decides the `/_` carve-out (the same input EmDash's own CSRF
 *  layer matches on); `routePattern` decides the per-route exemptions. */
export function originGuardApplies(
	method: string,
	pathname: string,
	routePattern: string,
): boolean {
	if (SAFE_METHODS.has(method.toUpperCase())) return false;
	if (pathname.startsWith("/_")) return false;
	return !ORIGIN_GUARD_EXEMPT_ROUTES.has(routePattern);
}

/**
 * The 403 for every refused request — a fresh, mutable `Response` each time.
 * It always carries the strictest headers any endpoint used to wrap its own
 * refusal in: `Referrer-Policy: no-referrer` (the next page learns nothing of
 * this URL) and `Cache-Control: private, no-store` (no cache keeps it). One
 * answer for every route, so nothing here mirrors an endpoint's wrappers from
 * a distance and can drift from them; the routes that used to send a bare 403
 * only gain the two headers.
 */
export function crossOriginRefusal(): Response {
	return new Response(CROSS_ORIGIN_REFUSAL_BODY, {
		status: 403,
		headers: { "Cache-Control": PRIVATE_NO_STORE, "Referrer-Policy": "no-referrer" },
	});
}

/** The middleware's whole check: the refusal for a guarded cross-origin
 *  request, or null when the request may proceed. */
export function rejectCrossOrigin(
	context: Pick<APIContext, "request" | "url" | "routePattern">,
): Response | null {
	const { request, url, routePattern } = context;
	if (!originGuardApplies(request.method, url.pathname, routePattern)) return null;
	if (!isForbiddenCrossOrigin(request.headers.get("origin"), url.origin)) return null;
	return crossOriginRefusal();
}
