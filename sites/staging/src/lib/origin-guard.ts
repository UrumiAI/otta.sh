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
 *  from the request's own origin. */
export function isForbiddenCrossOrigin(
	originHeader: string | null,
	requestOrigin: string,
): boolean {
	return originHeader !== null && originHeader !== requestOrigin;
}

/** Returns the 403 response for a forbidden cross-origin request, or null
 *  when the request may proceed. Call FIRST in every /cart/* POST. */
export function rejectCrossOrigin(context: APIContext): Response | null {
	if (isForbiddenCrossOrigin(context.request.headers.get("origin"), context.url.origin)) {
		return new Response("Cross-origin form submissions are forbidden", { status: 403 });
	}
	return null;
}
