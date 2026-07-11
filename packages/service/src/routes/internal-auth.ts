import type { Context } from "hono";
// The single timing-safe compare implementation lives in ../auth.js, shared by
// this X-Internal-Token guard and the SERVICE_API_TOKEN Bearer write gate.
import { tokenMatches } from "../auth.js";

/**
 * Guard an internal endpoint: 503 when no token is configured (disabled, never
 * silently open), 401 on a mismatch, `null` when authorized (proceed). Returns a
 * `Response` to short-circuit on failure.
 */
export function requireInternalToken(c: Context, expected: string | undefined): Response | null {
	if (expected === undefined || expected.length === 0) {
		return c.json({ ok: false, error: "internal endpoints disabled" }, 503);
	}
	if (!tokenMatches(c.req.header("X-Internal-Token"), expected)) {
		return c.json({ ok: false, error: "unauthorized" }, 401);
	}
	return null;
}
