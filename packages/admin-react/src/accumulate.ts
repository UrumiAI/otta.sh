/**
 * What `Load more` does to the rows already on screen (F24).
 *
 * THE DEFECT THIS EXISTS TO CLOSE. Both React lists used to assign the freshly
 * fetched page straight into list state, so a successful `Load more` REPLACED
 * the rows the operator was reading instead of adding to them. Nothing had to
 * fail for that to happen — the success path alone lost the page above. On
 * Pricing & inventory it is what made a low-stock scan useless: the matches the
 * operator had already gathered vanished at the exact moment they asked to see
 * more of them.
 *
 * MERGE ON IDENTITY, NEVER ON POSITION. The two requests are two statements
 * about a collection that keeps moving underneath them: a record inserted,
 * edited or re-sorted between them can appear on both pages, and blind
 * concatenation renders it twice — a duplicate row and, on React, a duplicate
 * key. So a row is matched by the id it is keyed and navigated by.
 *
 * TWO RULES, both deliberate:
 *
 *  - **Arrival order is preserved.** A row keeps the position it first
 *    appeared at, so the page an operator is mid-scan through does not reorder
 *    under them when the next one lands.
 *  - **The newer page wins on content.** A row that arrives again is the same
 *    record read more recently, so its fields replace the older read's — while
 *    keeping the older read's POSITION, per the rule above. A duplicate WITHIN
 *    one incoming page resolves the same way, last occurrence winning, because
 *    a page that names a record twice is the same disagreement in one response.
 *
 * PURE, and generic over the row, so both lists share the decision and it can
 * be tested as the function of `(accumulated, incoming)` that it is.
 */
export function mergeById<T>(
	accumulated: readonly T[],
	incoming: readonly T[],
	identify: (row: T) => string,
): readonly T[] {
	// The common case — the first page of a fresh accumulation — has nothing to
	// merge against, and answering it with the incoming array keeps the identity
	// React's reconciler and the `useMemo` over these rows both compare on.
	if (accumulated.length === 0) return incoming;
	if (incoming.length === 0) return accumulated;

	const newer = new Map<string, T>();
	for (const row of incoming) newer.set(identify(row), row);

	const merged: T[] = [];
	const seen = new Set<string>();
	for (const row of accumulated) {
		const id = identify(row);
		if (seen.has(id)) continue;
		seen.add(id);
		merged.push(newer.get(id) ?? row);
	}
	for (const row of incoming) {
		const id = identify(row);
		if (seen.has(id)) continue;
		seen.add(id);
		merged.push(newer.get(id) ?? row);
	}
	return merged;
}

/**
 * The cursor `Load more` set, CARRYING THE FILTER IT WAS ISSUED UNDER.
 *
 * WHY A CURSOR IS NOT A STRING HERE. A keyset cursor is only meaningful against
 * the predicate that produced it, and the list holds the two in separate state.
 * Between the click that applies a filter and the effect that acts on it there
 * is one commit in which the applied filter has already moved and the cursor has
 * not — and a `Load more` landing in that commit forms the one pair that must
 * never exist: the NEW filter with the OLD filter's cursor, sent as a
 * continuation, merging rows that do not match the filter into rows that do. The
 * count line then states a confident total for a set that was never queried.
 *
 * PAIRING THEM IN ONE VALUE IS WHAT MAKES THAT UNREPRESENTABLE, rather than
 * merely unlikely: whichever order the two updates are applied in, a cursor
 * whose filter is not the one now applied is not a continuation of anything, and
 * {@link continuationCursor} refuses it. Ordering, batching and effect timing
 * stop being part of the argument.
 */
export interface PendingCursor<F> {
	readonly filter: F;
	readonly value: string;
}

/**
 * The cursor to put on the wire, or `undefined` for "start at the first page".
 *
 * REFERENCE EQUALITY IS THE TEST, and it is the right one: the applied filter is
 * a state value replaced wholesale by a new object on every apply, so identity
 * answers exactly "is this still the filter that cursor was issued under" — with
 * none of the false matches a structural comparison would produce between two
 * differently-derived filters that happen to look alike.
 *
 * TWO ASSUMPTIONS THIS RESTS ON. First, that callers never mutate a filter in
 * place — a filter changed in place, same reference, different contents, would
 * still compare equal and the cursor would be reused across the change. Safe
 * today because the filter types declare their fields `readonly` and every call
 * site builds a fresh object, but this helper is generic and exported, so a
 * future caller could break that without touching this file. Second, that the
 * applied filter is state, not a per-render derivation — the reference only
 * changes when the filter is actually applied. A per-render derivation would
 * fail every comparison, degrading `Load more` into a silent first-page reload
 * that loses the accumulated scan. That failure direction is the safe one,
 * though: a mismatch always yields a fresh first page, never a merge across
 * filters.
 */
export function continuationCursor<F>(
	cursor: PendingCursor<F> | null,
	applied: F,
): string | undefined {
	return cursor !== null && cursor.filter === applied ? cursor.value : undefined;
}

/**
 * THE CURSOR A DEEP LINK ARRIVED WITH, bound to the filter that link decoded to.
 *
 * THIS IS THE ONE PATH `PendingCursor` DOES NOT GET FOR FREE, and it is the
 * whole reason this helper exists rather than an inline object literal at two
 * call sites. Every other cursor on these screens is issued by a response the
 * list already holds, so the filter it belongs to is the applied filter, sitting
 * right there in state. A cursor decoded from an address has no such history: it
 * is a bare string that arrives BEFORE the first request, at the same moment the
 * filter is being decoded from the same address. Binding the two is what makes
 * the pair a continuation at all — {@link continuationCursor} compares filters
 * by IDENTITY, so a structurally-equal copy, or a filter re-derived on a later
 * render, is refused, and the deep link silently degrades into a first-page
 * reload that looks exactly like an operator's ordinary first visit.
 *
 * THE CALLER'S OBLIGATION, and it is the only one: pass the SAME filter object
 * the list is about to apply — the one seeding `applied`, not a copy of it. Both
 * lists satisfy this by seeding both pieces of state from the one `initialFilter`
 * prop in the same render.
 *
 * An absent value is page one, and so is an empty one: a URL is user input, and
 * `?cursor=` is a trimmed or stale link rather than a request for the empty
 * token.
 */
export function seedCursor<F>(filter: F, value: string | undefined): PendingCursor<F> | null {
	return value === undefined || value.length === 0 ? null : { filter, value };
}

/**
 * THE PAGE IS PART OF THE ADDRESS.
 *
 * WHY THIS IS SAFE, since a keyset cursor in a public, hand-editable string
 * looks alarming at first reading. The token is OPAQUE and self-describing: the
 * service issued it, only the service can read it, and it refuses one it did not
 * issue rather than guessing. So the two things a client could get wrong are
 * both unavailable to it — it cannot mint a token, and it cannot interpret one
 * — and everything below moves the value verbatim. Nothing here parses,
 * validates or reconstructs it; a token this tier "understood" would be the
 * service's keyset predicate reimplemented in a browser, and it would rot the
 * first time the cursor shape changed.
 *
 * WHY IT LIVES BESIDE THE MERGE RATHER THAN IN EITHER SCREEN. Both screens spell
 * the parameter identically and must keep spelling it identically — an address
 * is a compatibility surface, and two independent copies of one is how the
 * Orders link and the Pricing & inventory link quietly stop meaning the same
 * thing. The filter parameters legitimately differ per screen and stay there;
 * the cursor does not.
 */
export const CURSOR_PARAM = "cursor";

/** The page a link names, or `undefined` for the first one. ABSENT, not empty:
 *  `?cursor=` is a stale or hand-trimmed link, and sending `""` would put a
 *  token on the wire for the service to refuse when the honest reading is "no
 *  page was named". */
export function readCursor(search: string): string | undefined {
	const value = new URLSearchParams(search).get(CURSOR_PARAM);
	return value !== null && value.length > 0 ? value : undefined;
}

/**
 * The query naming a page, or naming none.
 *
 * It starts from the CURRENT query, so the filter parameters, the drill-in and
 * anything the host admin put there survive a page change — this parameter
 * shares one address bar with all of them.
 *
 * `URLSearchParams` DOES THE ESCAPING, and on this parameter that is
 * load-bearing rather than hygienic: a base64 token carries `+`, `/` and `=`,
 * and a `+` written raw into a query string decodes back as a SPACE. Hand
 * concatenation would corrupt the token on the way out and the service would
 * refuse it on the way back in — the fail-closed path, reached by our own bug.
 */
export function cursorQuery(current: string, cursor: string | undefined): string {
	const params = new URLSearchParams(current);
	params.delete(CURSOR_PARAM);
	if (cursor !== undefined && cursor.length > 0) params.set(CURSOR_PARAM, cursor);
	return params.toString();
}

/**
 * WHAT AN ADDRESS THE SERVICE WOULD NOT HONOUR SAYS TO THE OPERATOR.
 *
 * A refused token is not a fault to apologise for and not an error to dead-end
 * on: the link is simply older than the list it names — shared before the
 * filters moved, truncated by a chat client, or edited by hand — and the useful
 * answer is the first page of the filters that link DID carry, with one sentence
 * saying why the operator is not where they expected to be. Saying nothing would
 * be worse than the error card: the screen would silently show page one of a
 * link that promised page four.
 *
 * IT IS NOT IN THE SHARED COPY PACKAGE, deliberately. That package exists so the
 * Block Kit tier and the React tier cannot drift on wording they BOTH render,
 * and the Block Kit screens have no addressable cursor — no URL, no shareable
 * page, nothing that can arrive stale. This sentence has exactly one surface. If
 * a second one ever grows it, it moves.
 */
export const CURSOR_RESET_TITLE = "That link named a page this list could not open";
export const CURSOR_RESET_DESCRIPTION =
	"The link may have been shared before these filters changed, or edited on the way. Showing the first page of these filters instead.";
