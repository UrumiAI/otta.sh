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
 * TWO FUNCTIONS, BECAUSE THERE ARE TWO SITUATIONS.
 *
 *  - {@link shortIdsFor} — the caller HAS the candidate set (a rendered page of
 *    rows, the options of one picker). It can compute a true shortest-unique
 *    prefix, and it must be given the WHOLE set it will render: a prefix
 *    computed over a filtered or re-fetched subset is unique against the wrong
 *    population and can collide on screen.
 *  - {@link shortIdFixed} — the caller has ONE id and no set (a confirm dialog
 *    renders against a single record). No uniqueness claim is possible, so it
 *    takes a fixed {@link SHORT_ID_CONFIRM_LEN} characters.
 *
 * HOW THE TWO LINE UP, which is the load-bearing property. The fixed length is
 * deliberately LONGER than the floor, so for any id whose computed prefix is
 * ≤ {@link SHORT_ID_CONFIRM_LEN} the fixed prefix is a strict superset of it:
 * the operator reads `#7e4c` in the picker and `#7e4ce728` in the confirm, and
 * can see at a glance that the second starts with the first. That holds unless a
 * page contains two ids agreeing on their first 8 characters — a collision a
 * 128-bit id makes vanishingly unlikely, and one this module cannot repair from
 * a confirm dialog that was never handed the other candidate.
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

/** The fixed length used where no candidate set is in hand (the refund
 *  confirm). Longer than {@link SHORT_ID_MIN} on purpose — see the header. */
export const SHORT_ID_CONFIRM_LEN = 8;

/**
 * Shortest-unique prefixes for a candidate set: `min` characters, extended one
 * at a time for exactly the ids that collide at that length.
 *
 * TOTAL — every id in `ids` has an entry, including duplicates (which map to
 * the same prefix, because they are the same record) and ids shorter than
 * `min` (which map to themselves). DETERMINISTIC — the result depends only on
 * the SET of ids, never on their order, so re-rendering a page in a different
 * order cannot renumber it.
 */
export function shortIdsFor(
	ids: readonly string[],
	min: number = SHORT_ID_MIN,
): Map<string, string> {
	const floor = Number.isInteger(min) && min > 0 ? min : SHORT_ID_MIN;
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

/**
 * A fixed-length prefix, for a surface rendering ONE record with no candidate
 * set to be unique against (the refund confirm). Ids shorter than `len` are
 * returned whole rather than padded — a short id is already unambiguous.
 */
export function shortIdFixed(id: string, len: number = SHORT_ID_CONFIRM_LEN): string {
	const take = Number.isInteger(len) && len > 0 ? len : SHORT_ID_CONFIRM_LEN;
	return id.slice(0, take);
}
