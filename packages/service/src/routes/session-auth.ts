import type { CustomerId, SessionStore } from "@otta-sh/domain";
import type { Context } from "hono";

/** Extract the `Authorization: Bearer <token>` value, or null. */
export function bearerToken(c: Context): string | null {
	const header = c.req.header("authorization") ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match === null ? null : match[1]!;
}

/**
 * Resolve the authenticated customer purely from the bearer session token
 * (Phase 5 §4) — **never** a `customerId` in the request body/query. This is the
 * concrete mechanism behind "sees only own orders": every `/me/*` handler is
 * given exactly one identity, and it's the one `SessionStore.validate` derives.
 * Returns null when unauthenticated (the caller replies 401).
 */
export async function resolveCustomer(
	c: Context,
	sessionStore: SessionStore,
): Promise<CustomerId | null> {
	const token = bearerToken(c);
	if (token === null) return null;
	return sessionStore.validate(token);
}
