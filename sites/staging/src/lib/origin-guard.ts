/**
 * Origin-based CSRF guard for the site's own /cart/* POST endpoints.
 *
 * Needed because the emdash astro integration force-disables Astro's
 * built-in `security.checkOrigin` (it injects `checkOrigin: false` so its
 * own dual-origin CSRF layer can validate at runtime — em-dash
 * `astro/integration/index.ts`), and that replacement layer
 * (`checkPublicCsrf`) covers only `/_emdash/api/*` routes. Theme-owned
 * endpoints get NOTHING unless they check themselves. See ADR-0006's CSRF
 * section.
 *
 * Semantics mirror em-dash's `checkPublicCsrf` / Astro's origin check:
 * a present-but-mismatched `Origin` header is forbidden (browsers always
 * send Origin on cross-site form POSTs, including the opaque "null");
 * an ABSENT Origin is allowed — that's curl / server-to-server, which
 * carries no ambient cookie and is not a CSRF vector.
 *
 * FOLLOW-UP (Phase 4 storefront task): when checkout/x402/download
 * endpoints land, promote this per-endpoint call into a site
 * `src/middleware.ts` guarding every non-/_emdash state-changing route,
 * so a new endpoint can't ship unguarded by omission.
 */
import type { APIContext } from "astro";

/** Pure decision (unit-tested): forbid iff Origin is present and differs
 *  from the request's own origin.
 *
 *  `forwardedProto` exists because behind a TLS-terminating proxy the two
 *  disagree on SCHEME ALONE. The edge (an ALB, Cloudflare) terminates https
 *  and speaks plain http to the pod, so the app computes its own origin as
 *  `http://shop.example` while the browser faithfully sends
 *  `Origin: https://shop.example` — and every add-to-cart 403s for real
 *  users. `curl` without an Origin header is allowed by the rule above, so
 *  the endpoint tests green from a terminal while being broken in every
 *  browser, which is exactly how this survived to production.
 *
 *  Only the scheme is relaxed, only to what the EDGE reports, and only for
 *  the same host — a different host is still forbidden. */
export function isForbiddenCrossOrigin(
	originHeader: string | null,
	requestOrigin: string,
	forwardedProto?: string | null,
): boolean {
	if (originHeader === null) return false;
	if (originHeader === requestOrigin) return false;

	// X-Forwarded-Proto is a LIST when several proxies are chained; the
	// client-facing hop is the first entry.
	const proto = forwardedProto?.split(",")[0]?.trim();
	if (proto !== undefined && /^https?$/.test(proto)) {
		try {
			const asForwarded = new URL(requestOrigin);
			asForwarded.protocol = `${proto}:`;
			if (originHeader === asForwarded.origin) return false;
		} catch {
			// requestOrigin isn't a URL — fall through to forbidden.
		}
	}
	return true;
}

/** Returns the 403 response for a forbidden cross-origin request, or null
 *  when the request may proceed. Call FIRST in every /cart/* POST. */
export function rejectCrossOrigin(context: APIContext): Response | null {
	const forbidden = isForbiddenCrossOrigin(
		context.request.headers.get("origin"),
		context.url.origin,
		context.request.headers.get("x-forwarded-proto"),
	);
	if (forbidden) {
		return new Response("Cross-origin form submissions are forbidden", { status: 403 });
	}
	return null;
}
