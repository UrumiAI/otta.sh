import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Constant-time shared-secret comparison: hash both sides to a fixed length
 *  first so `timingSafeEqual` applies to arbitrary token lengths — a plain
 *  `!==` would leak the match length/prefix through timing. Shared by the
 *  `X-Internal-Token` gate (routes/carts.ts) and the Bearer write gate. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
	if (provided === undefined) return false;
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * SERVICE_API_TOKEN write gate (D9), registered FIRST in `createApp` so every
 * route — current and future — inherits it. Token unset ⇒ pass-through
 * (exactly the pre-gate behavior). Token set ⇒ GET/HEAD stay open as the
 * storefront read surface (`/health` is a GET, so it is open by the same
 * rule); every other method on every path requires
 * `Authorization: Bearer <token>`, else 401 with `WWW-Authenticate: Bearer`
 * (RFC 6750). Note: Hono serves HEAD via GET handlers, so HEAD is explicitly
 * listed to keep it as open as the GET it delegates to.
 *
 * `exemptPaths` is an EXACT-path allowlist for endpoints that carry their own
 * cryptographic caller authentication and whose third-party caller cannot be
 * given our Bearer token (e.g. a payment provider's webhook receiver). Every
 * entry must document its own auth mechanism at the registration site
 * (app.ts) — the default remains deny.
 */
export function requireBearerToken(
	token: string | undefined,
	exemptPaths: readonly string[] = [],
): MiddlewareHandler {
	return async (c, next) => {
		if (token === undefined || token.length === 0) return next();
		if (c.req.method === "GET" || c.req.method === "HEAD") return next();
		if (exemptPaths.includes(c.req.path)) return next();

		const header = c.req.header("Authorization");
		const spaceAt = header?.indexOf(" ") ?? -1;
		const scheme = header === undefined || spaceAt === -1 ? "" : header.slice(0, spaceAt);
		const credentials = header === undefined || spaceAt === -1 ? "" : header.slice(spaceAt + 1);
		if (scheme.toLowerCase() !== "bearer" || !tokenMatches(credentials, token)) {
			c.header("WWW-Authenticate", "Bearer");
			return c.json({ ok: false, error: "unauthorized" }, 401);
		}
		return next();
	};
}
