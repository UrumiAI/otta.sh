/**
 * Git-style short ids for the admin console (the UUID display rule, D4).
 *
 * WHY. An order id is a uuid: 36 characters of noise that an operator cannot
 * hold in their head and cannot compare between two surfaces. Rendering it in
 * full in a list row buys nothing, and rendering NOTHING costs money — two
 * orders of one repeat customer with the same total and the same status produce
 * character-for-character identical picker options, and the refund confirm names
 * amount + buyer, precisely the attributes both candidates share. The answer is
 * the one git settled on: the SHORTEST PREFIX that is unique among the candidate
 * set, floored at {@link SHORT_ID_MIN} so it stays recognisable, extending one
 * character at a time only when two candidates actually collide.
 *
 * ONE FUNCTION, {@link shortIdsFor}: the caller HAS the candidate set (a rendered
 * page of rows, the options of one picker) and must pass the WHOLE set it will
 * render — a prefix computed over a filtered or re-fetched subset is unique against
 * the wrong population and can collide on screen. The orders list prints the order
 * NUMBER instead (ADR-0033) and uses this only to tell apart rows that share one;
 * the refund confirm names a fixed 12 hex digits (`orderConfirmLabel`).
 *
 * NOT FOR NATURAL KEYS. Tax classes, shipping zones and coupons are keyed by
 * readable slugs (`eu-standard-vat`, `SUMMER25`). Those are the operator's own
 * words and render in full; this module is for ids nobody chose.
 *
 * IO-FREE and allocation-cheap: pure string slicing, safe inside the sandbox.
 */

/** The floor for a computed prefix — short enough to scan, long enough to
 *  recognise, and the point below which two ids collide on almost every page. */
export const SHORT_ID_MIN = 4;

/**
 * Shortest-unique prefixes for a candidate set: `min` characters, extended one
 * at a time for exactly the ids that collide at that length.
 *
 * `min` RAISES THE FLOOR AND CANNOT LOWER IT. {@link SHORT_ID_MIN} is a rule
 * about what an operator can recognise, not a default a caller may opt out of,
 * so the argument is clamped: anything below it — including a fractional or
 * non-finite value, which is truncated or discarded first — yields
 * {@link SHORT_ID_MIN}. A caller that wants LONGER prefixes (say, matching the
 * confirm dialog's 8) passes 8 and gets 8.
 *
 * TOTAL — every id in `ids` has an entry, including duplicates (which map to
 * the same prefix, because they are the same record) and ids shorter than the
 * floor (which map to themselves). DETERMINISTIC — the result depends only on
 * the SET of ids, never on their order, so re-rendering a page in a different
 * order cannot renumber it.
 */
export function shortIdsFor(
	ids: readonly string[],
	min: number = SHORT_ID_MIN,
): Map<string, string> {
	const floor = Number.isFinite(min) ? Math.max(SHORT_ID_MIN, Math.trunc(min)) : SHORT_ID_MIN;
	// De-duplicate FIRST: an id is never its own collision, and a page that
	// happens to list one record twice must not push every prefix to full length.
	const candidates = [...new Set(ids)];
	const longest = candidates.reduce((n, id) => Math.max(n, id.length), 0);
	const prefixes = new Map<string, string>();
	for (const id of candidates) {
		// The fallback, reached only when EVERY id is shorter than the floor — in
		// which case this IS `id.slice(0, floor)`. Within the loop a unique length
		// always exists: two ids that never diverge are equal, and equal ids were
		// removed above, so the worst case is one id being a proper prefix of
		// another, which the character after it separates.
		let prefix = id;
		for (let len = floor; len <= longest; len++) {
			const candidate = id.slice(0, len);
			if (candidates.every((other) => other === id || other.slice(0, len) !== candidate)) {
				prefix = candidate;
				break;
			}
		}
		prefixes.set(id, prefix);
	}
	return prefixes;
}
