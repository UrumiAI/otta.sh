/**
 * The `buyerRef` guard — a check NOTHING upstream performs.
 *
 * `POST /checkout/orders` types `buyerRef` as `z.string().min(1).max(320)` with
 * no regex (`packages/service/src/schemas.ts`), and the domain treats it as an
 * opaque string. That permissiveness is deliberate — the field is documented as
 * an "email/session claim token", not strictly an email — so `"asdf"`, `" "`
 * and `"jo@"` all produce a perfectly valid order. The consequences are not
 * cosmetic:
 *
 *  - ADR-0004's guest-order claiming matches on `buyer_ref` at magic-link
 *    login, so a typo'd address yields an order NO CUSTOMER CAN EVER CLAIM.
 *  - ADR-0005's transactional order emails are addressed from it, so nothing
 *    about the order can ever reach the buyer.
 *  - The order is immutable: there is no self-service repair, only an admin
 *    refund (ADR-0008).
 *
 * So the SITE owns the guard — it is the layer that knows this value came from
 * a checkout form rather than a session.
 *
 * The rule is deliberately conservative-but-not-clever: it rejects the
 * realistic typo classes (missing `@`, missing TLD, a trailing dot, a space
 * pasted in from a mail client) without attempting RFC 5322, which is
 * unimplementable as a regex and would reject valid addresses. Traced
 * adversarially against plus-addressing, subdomains, long/unusual TLDs, mixed
 * case and Unicode local parts: it rejects no realistic legitimate address.
 *
 * **Trim only — NEVER lowercase.** The service stores `buyer_ref` verbatim and
 * claiming is already case-insensitive, so normalizing would silently alter the
 * buyer's own identifier for no gain.
 */

/** Matches the service's own `max(320)`. */
const MAX_LENGTH = 320;

/** Exactly one `@`, no whitespace anywhere, and a dotted domain whose labels
 *  are all non-empty (so no leading, trailing or doubled dots). */
const PLAUSIBLE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isPlausibleEmail(raw: string): boolean {
	const value = raw.trim();
	if (value.length === 0 || value.length > MAX_LENGTH) return false;
	return PLAUSIBLE.test(value);
}

/** The value to send as `buyerRef`: trimmed, otherwise verbatim. Exported so
 *  the endpoint cannot drift from the predicate's notion of "the address". */
export function normalizeBuyerRef(raw: string): string {
	return raw.trim();
}
