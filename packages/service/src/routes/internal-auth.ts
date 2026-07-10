import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

/**
 * Constant-time shared-secret comparison for the `X-Internal-Token` header
 * (Phase 3 pattern §6): hash both sides to a fixed length first so
 * `timingSafeEqual` applies to arbitrary token lengths — a plain `!==` would leak
 * the match length/prefix through timing.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
	if (provided === undefined) return false;
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

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
