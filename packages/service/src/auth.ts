import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Constant-time shared-secret comparison: hash both sides to a fixed length
 *  first so `timingSafeEqual` applies to arbitrary token lengths — a plain
 *  `!==` would leak the match length/prefix through timing. Shared by the
 *  `X-Internal-Token` gate (routes/internal-auth.ts) and the `X-Service-Token`
 *  write gate. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
	if (provided === undefined) return false;
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * SERVICE_API_TOKEN write gate (D9 / ADR-0007), registered FIRST in `createApp`
 * so every route — current and future — inherits it. Token unset ⇒ pass-through
 * (exactly the pre-gate behavior). Token set ⇒ GET/HEAD stay open as the
 * storefront read surface (`/health` is a GET, so it is open by the same rule);
 * every other method on every path requires the `X-Service-Token: <token>`
 * header, else 401.
 *
 * The machine token lives in its OWN dedicated header (`X-Service-Token`), NOT
 * `Authorization: Bearer` (ADR-0007): `Authorization: Bearer` is owned solely by
 * customer session auth (routes/session-auth.ts, used by `/auth/logout` and the
 * `/me/*` surface). Sharing the header would 401 those session routes at this
 * gate — a customer's Bearer carries a SESSION token, not the service token —
 * before session auth ever runs. The 401 is byte-identical to the
 * `X-Internal-Token` gate (`{ok:false,error:"unauthorized"}`, no
 * `WWW-Authenticate` challenge — a custom header has no registered scheme).
 * Note: Hono serves HEAD via GET handlers, so HEAD is explicitly listed to keep
 * it as open as the GET it delegates to.
 *
 * `exemptions` is an EXACT method+path allowlist for endpoints that carry
 * their own cryptographic caller authentication and whose third-party caller
 * cannot be given our service token (e.g. a payment provider's webhook
 * receiver). Scoping to the method keeps every other verb on the same path
 * gated. Every entry must document its own auth mechanism at the
 * registration site (app.ts) — the default remains deny.
 */
export interface ServiceTokenExemption {
	method: string;
	path: string;
}

export function requireServiceToken(
	token: string | undefined,
	exemptions: readonly ServiceTokenExemption[] = [],
): MiddlewareHandler {
	return async (c, next) => {
		if (token === undefined || token.length === 0) return next();
		if (c.req.method === "GET" || c.req.method === "HEAD") return next();
		if (exemptions.some((e) => e.method === c.req.method && e.path === c.req.path)) {
			return next();
		}

		if (!tokenMatches(c.req.header("X-Service-Token"), token)) {
			return c.json({ ok: false, error: "unauthorized" }, 401);
		}
		return next();
	};
}
