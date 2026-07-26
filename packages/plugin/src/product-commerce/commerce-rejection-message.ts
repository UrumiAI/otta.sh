import { type Blocker, hasControlChars } from "./commerce-save-blockers.js";

/**
 * The merchant-facing rejection message, plus the sentinel-key hygiene and the
 * self-scrub that keeps it from ever bricking an entry.
 *
 * ── Why the message is a KEY ───────────────────────────────────────────────
 * A `content:beforeSave` hook has no channel back to the editor. What it DOES
 * have is the save payload: em-dash's `validateContentData` rejects any unknown
 * top-level data key with `"<key>: unknown field on collection 'products'"`,
 * joins every issue into one `VALIDATION_ERROR.message`, and the admin client
 * toasts that message verbatim ("Failed to save" / "Autosave failed") — with the
 * whole save discarded before ANY write. So one extra key whose NAME is the
 * message is the only surfacing channel available today.
 *
 * This is BEST-EFFORT UX, not the fix. The fix is the STRIP in
 * `sync/before-save.ts` (the returned payload carries no `commerce` key), which
 * holds regardless of what the host does with unknown keys. If em-dash ever
 * replaces its unknown-key rule with a zod `.strip()`, the sentinel is silently
 * dropped and the merchant sees no message — the SILENCE half of the bug
 * returns while the DIVERGENCE half stays fixed. That degradation is accepted
 * and recorded in ADR-0012.
 *
 * ── Hygiene, and why it matters ────────────────────────────────────────────
 * On the degraded non-revision write path a data key reaches em-dash's
 * `validateIdentifier`, which caps identifiers at 128 chars. Every merchant
 * value is therefore coerced to a string, stripped of control characters,
 * whitespace-collapsed and clipped to 40 chars; the whole key is clipped to 110.
 *
 * Pure module — no IO.
 */

/** Stable, machine-recognisable prefix. Every sentinel key starts with it, and
 *  `scrubStaleSentinels` removes every key that does. Deliberately NOT a
 *  leading underscore: em-dash's validator SKIPS `_`-prefixed keys, which would
 *  silence the error and forfeit the entire surfacing mechanism. */
export const SENTINEL_PREFIX = "Urumi — ";

/** Comfortably under em-dash's `MAX_IDENTIFIER_LENGTH` (128). */
export const MAX_SENTINEL_KEY_LENGTH = 110;

/** Merchant values are clipped to this many characters (ellipsis included). */
const MAX_VALUE_LENGTH = 40;

/** Stated up front, before any variable-length text, so the clip can never eat
 *  the one thing the merchant most needs to know. */
const LEAD = "Not saved. ";

/** Control characters become plain spaces (then collapse) — never dropped
 *  outright, so `"a\nb"` reads as `a b` rather than `ab`. Shares its range with
 *  the blocker predicate's `hasControlChars`. */
function stripControlChars(text: string): string {
	let out = "";
	for (const char of text) out += hasControlChars(char) ? " " : char;
	return out;
}

function coerce(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	if (Array.isArray(value)) return "[list]";
	return "[object]";
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A merchant value, made safe to embed in an identifier-shaped key: coerced to
 * a string, control characters removed, whitespace collapsed, quotes softened
 * (the key quotes the value), clipped to 40 chars.
 *
 * A present-but-invisible value (`"   "`, a non-breaking space) renders as
 * `(blank)` rather than as nothing at all — an empty pair of quotes in a toast
 * tells the merchant nothing about what to fix.
 */
export function renderBlockerValue(value: unknown): string {
	const raw = coerce(value);
	const cleaned = stripControlChars(raw).replace(/"/g, "'").replace(/\s+/g, " ").trim();
	if (cleaned.length === 0) return raw.length === 0 ? "(empty)" : "(blank)";
	return clip(cleaned, MAX_VALUE_LENGTH);
}

/**
 * The sentinel key for a set of blockers. Deterministic (same blockers ⇒
 * byte-identical key), which the "exactly one sentinel" invariant depends on.
 *
 * Shape: `Urumi — Not saved. Price "24.99" must be whole minor units (2499 =
 * $24.99); also: Currency, Stock`. The first blocker gets the full clause; the
 * rest are named so the merchant knows the list is longer, without blowing the
 * length cap.
 */
export function commerceRejectionMessage(blockers: readonly Blocker[]): string {
	const first = blockers[0];
	if (first === undefined)
		return clip(`${SENTINEL_PREFIX}${LEAD}Invalid product data`, MAX_SENTINEL_KEY_LENGTH);

	const rest = blockers.slice(1);
	const detail = `${first.label} "${renderBlockerValue(first.value)}" ${first.expected}`;
	const also = rest.length > 0 ? `; also: ${rest.map((b) => b.label).join(", ")}` : "";
	return clip(`${SENTINEL_PREFIX}${LEAD}${detail}${also}`, MAX_SENTINEL_KEY_LENGTH);
}

/**
 * Remove EVERY sentinel key from an incoming payload. Runs on every path,
 * including the happy one — this is what guarantees a stale sentinel can never
 * BLOCK a save: `validateContentData` sees the scrubbed payload, so there is no
 * unknown key left to reject.
 *
 * What it does NOT buy: it does not clean up storage. A products draft revision
 * is written as `{...baseData, ...processedData}`, and removing a key from
 * `processedData` does not remove it from `baseData` — a sentinel that ever
 * reached the draft JSON is re-merged indefinitely (see ADR-0012's
 * publish-brick note).
 *
 * Idempotent and a fixed point: it only ever removes keys, so one pass suffices
 * and there is no scrub loop. Returns the ORIGINAL reference when nothing was
 * removed, so the caller can keep the zero-cost `return undefined` happy path.
 */
export function scrubStaleSentinels(content: Record<string, unknown>): Record<string, unknown> {
	let removed = false;
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(content)) {
		if (key.startsWith(SENTINEL_PREFIX)) {
			removed = true;
			continue;
		}
		cleaned[key] = value;
	}
	return removed ? cleaned : content;
}
