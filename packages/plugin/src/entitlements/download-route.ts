import { COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import { isNonEmptyString } from "../storefront/account-routes.js";
import type { RouteHandler } from "../types.js";

/** The PUBLIC route path a digital-download link posts to (plan §6). */
export const ENTITLEMENT_DOWNLOAD_ROUTE = "entitlements/download";

export interface EntitlementDownloadInput {
	orderId?: unknown;
	/** A logged-in customer's Bearer session token, threaded from the theme's
	 *  first-party cookie layer (same source as the account routes). NEVER an
	 *  email — see the buyerRef note below. */
	sessionToken?: unknown;
	sku?: unknown;
}

export type EntitlementDownloadResult =
	| { authorized: true; sku: string }
	| { authorized: false; reason: "NOT_ENTITLED" | "INVALID_INPUT" | "UNAUTHENTICATED" };

/**
 * Entitlement-gated digital download (plan §6, step 4.9; ADR-0011). The plugin
 * route calls the service's entitlement **check** via `ctx.http` and authorizes
 * delivery only when an active entitlement exists — the file is never served
 * without one. Two scopes: the unguessable `orderId` (guest download link) or a
 * logged-in customer's `sessionToken` (the service derives the email).
 *
 * SECURITY (issue #33): this route NEVER accepts or forwards a `buyerRef` email.
 * The raw-email check scope is operator-only (gated by `X-Internal-Token` on the
 * service), and this storefront/sandbox path must NEVER read `settings:internalToken`
 * from kv — doing so would let the sandbox re-acquire the email existence oracle
 * this issue closed. The only token this route may touch is `settings:serviceToken`
 * (the write gate, ADR-0007), which does not unlock the buyerRef scope.
 *
 * SEAM NOTE: the actual file bytes / signed-R2-URL are served by the storefront
 * layer (Phase-2 scaffolding, not yet merged). This route returns the
 * authorization decision; wiring it to the object store is a storefront concern.
 * The plugin holds no secret and its only egress is `ctx.http` + `allowedHosts`.
 */
export function createEntitlementDownloadHandler(): RouteHandler<EntitlementDownloadInput> {
	return async (routeCtx, ctx): Promise<EntitlementDownloadResult> => {
		const { orderId, sessionToken, sku } = routeCtx.input;
		if (!isNonEmptyString(sku)) {
			return { authorized: false, reason: "INVALID_INPUT" };
		}
		const scopedOrderId = isNonEmptyString(orderId) ? orderId : undefined;
		const scopedSessionToken = isNonEmptyString(sessionToken) ? sessionToken : undefined;
		if (scopedOrderId === undefined && scopedSessionToken === undefined) {
			return { authorized: false, reason: "INVALID_INPUT" };
		}

		// `checkEntitlement` is a GET (write-gate-exempt), but the SERVICE token is
		// threaded for uniformity (ADR-0007) — undefined ⇒ no header ⇒ unchanged
		// wire. This is `settings:serviceToken`, never `settings:internalToken`.
		const serviceToken = await serviceTokenFromKv(ctx);
		const client = new HttpCommerceClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(serviceToken !== undefined ? { serviceToken } : {}),
		});

		// PRECEDENCE FIX (review): the service gives an `orderId` in the query
		// priority over a session Bearer riding along in the SAME request (ADR-0011
		// scope 2 before scope 3, by design — the orderId capability must keep
		// working for a guest with no session at all). So a single combined request
		// would false-negative NOT_ENTITLED for a logged-in customer whose
		// theme-supplied `orderId` happens to be stale or unrelated (e.g. a leftover
		// query param from another tab/order). Check the orderId scope first — it's
		// the common guest-download-link case and needs no auth header — and ONLY
		// when it comes back inactive AND a session is present, retry session-scoped.
		// Never the reverse: a valid orderId bearer capability must never be
		// shadowed by trying the session first.
		if (scopedOrderId !== undefined) {
			const byOrder = await client.checkEntitlement({ orderId: scopedOrderId }, sku);
			if (!byOrder.ok) return { authorized: false, reason: "UNAUTHENTICATED" };
			if (byOrder.active) return { authorized: true, sku };
		}
		if (scopedSessionToken !== undefined) {
			const bySession = await client.checkEntitlement({}, sku, {
				sessionToken: scopedSessionToken,
			});
			if (!bySession.ok) return { authorized: false, reason: "UNAUTHENTICATED" };
			return bySession.active
				? { authorized: true, sku }
				: { authorized: false, reason: "NOT_ENTITLED" };
		}
		return { authorized: false, reason: "NOT_ENTITLED" };
	};
}
