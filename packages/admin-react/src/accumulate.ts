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
