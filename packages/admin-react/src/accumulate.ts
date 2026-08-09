import {
	NEXT_AT_END_TITLE,
	NEXT_PAGE_LABEL,
	NEXT_RELEASES_SCAN_TITLE,
	PREVIOUS_AT_START_TITLE,
	PREVIOUS_PAGE_LABEL,
	PREVIOUS_UNWALKED_TITLE,
	pageCount,
	pagePositionLine,
} from "@otta-sh/admin-presentation";

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
	/**
	 * WHICH PAGE WAS ASKED FOR — `undefined` is page one, which is a page like any
	 * other and is asked for by sending no token at all.
	 *
	 * WHY THIS IS OPTIONAL RATHER THAN A `null` CURSOR. The state that holds this
	 * value distinguishes two things a bare `string | null` cannot: "no page has
	 * been asked for, this is a fresh load" (the value is `null`) and "the pager
	 * was pressed and it asked for page one" (the value is an object whose
	 * `value` is `undefined`). The difference decides what a FAILURE costs — a
	 * fresh load that fails disproves the rows on screen, and a page move that
	 * fails disproves nothing — and it was the one distinction the earlier
	 * `continuation = cursor !== undefined` test could not make, which is how a
	 * failed `Previous` onto page one destroyed a screenful of rows.
	 */
	readonly value: string | undefined;
	/**
	 * Does this cursor CONTINUE the rows on screen, or REPLACE them?
	 *
	 * TWO CONTROLS NOW ADVANCE THE SAME CURSOR AND ONLY ONE ACCUMULATES.
	 * `Load more` extends the window — the rows above it are the operator's scan
	 * and merging is the whole point (see {@link mergeById}). `Next` and
	 * `Previous` MOVE the window: what comes back is one page, standing on its
	 * own, and merging it would paste page three onto page two and caption the
	 * result as a scan the operator never made.
	 *
	 * IT RIDES ON THE CURSOR RATHER THAN BESIDE IT, for the reason the filter
	 * does: two pieces of state set by one click can still be read by an effect in
	 * either order, and the pair that must never exist is a REPLACE cursor read as
	 * an EXTEND one. Carrying the intent in the same value makes that
	 * unrepresentable rather than merely unlikely.
	 *
	 * ABSENT IS REPLACE, and that is the safe default rather than an accident: a
	 * cursor decoded from an address ({@link seedCursor}) names a page and has
	 * nothing on screen to continue, and a pager step is the same. Exactly one
	 * call site per screen sets this, and it is the one labelled `Load more`.
	 */
	readonly extend?: boolean;
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
	return askedForPage(cursor, applied) ? cursor?.value : undefined;
}

/**
 * DID THE OPERATOR ASK FOR THIS PAGE, or is this a fresh load?
 *
 * THE TWO ARE NOT THE SAME REQUEST EVEN WHEN THEY PUT THE SAME BYTES ON THE
 * WIRE. `Previous` onto page one and a filter apply both send no cursor, and
 * {@link continuationCursor} therefore answers `undefined` for both — but one is
 * a MOVE between pages of a query whose rows are on screen, and the other is a
 * fresh query whose rows have not been fetched yet. What separates them is
 * whether a cursor OBJECT exists at all.
 *
 * IT DECIDES WHAT A FAILURE COSTS. A fresh load that fails disproves the rows on
 * screen — they answered a different question — so they are cleared. A page move
 * that fails disproves nothing: the rows still answer the query that produced
 * them, so they stand and the refusal is drawn beside them. Reading
 * "continuation" off the wire instead was how a failed `Previous` onto page one
 * wiped a screenful of rows that were still true.
 *
 * SAME IDENTITY TEST as {@link continuationCursor}, and for the same reason: a
 * cursor issued under a filter that has since been replaced is not a move within
 * anything, so the request it belongs to is a fresh load of the new filter.
 */
export function askedForPage<F>(cursor: PendingCursor<F> | null, applied: F): boolean {
	return cursor !== null && cursor.filter === applied;
}

/**
 * WHAT A RESPONSE DOES TO THE ROWS ALREADY ON SCREEN — the three answers, named.
 *
 *  - `reset` — a FRESH LOAD. A first mount, a filter apply, or a page the
 *    service refused and answered with page one instead. Whatever was on screen
 *    answered a different question, so it goes, and the render starts at the
 *    first page.
 *  - `extend` — `Load more`. The rows above are the operator's scan; the
 *    incoming page merges into them by identity ({@link mergeById}) and the
 *    window grows by one page.
 *  - `replace` — a PAGER STEP, or a deep link. The window MOVES: the incoming
 *    page stands on its own, and it is not the first page.
 *
 * Both lists spell this the same way and derive it the same way, which is the
 * point of naming it rather than passing two booleans that each list combines in
 * its own words.
 */
export type PageArrival = "reset" | "extend" | "replace";

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
 * WHY THIS IS SAFE, and it is NOT that the token is unreadable. It is
 * unsigned base64url JSON carrying the keyset position, the filter it was issued
 * under and the page limit: anyone can decode one, and anyone can mint one. A
 * cursor in a public, hand-editable string is therefore exactly as exposed as it
 * looks, and pretending otherwise would be the wrong argument for the right
 * decision.
 *
 * THE PROTECTION IS ON THE ROUTE, where protection belongs. The service decodes
 * the token, RE-VALIDATES the filter it carries through the same zod schema a
 * query string is held to, re-checks the position's shape, and RE-CLAMPS the
 * limit — every one of those failing closed to a 400 rather than to a 500 or to
 * a trusted value. So a minted token can ask for a page of something the schema
 * already allows an operator to ask for, and nothing more: it is a
 * pre-authorized query restated, not a capability. What a hand-edited token
 * cannot do is smuggle an unvalidated predicate or an unbounded page size past
 * the route.
 *
 * NOTHING HERE PARSES IT ANYWAY, and that is a separate rule with its own
 * reason: the shape belongs to the service, and a browser that read it would
 * couple this tier to an encoding it does not own and would rot the first time
 * that encoding changed. Every function below moves the value verbatim.
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
 * `URLSearchParams` DOES THE ESCAPING, and the reason is NOT that today's token
 * needs escaping — it does not. The service emits base64URL: `+` and `/` are
 * mapped to `-` and `_` and the `=` padding is stripped, so a current token is
 * already query-safe and would survive hand concatenation intact. The encoder is
 * here because THIS TIER DOES NOT KNOW THAT, and must not depend on it: the
 * token's alphabet belongs to the service, and the day it gains a character that
 * needs escaping — a different encoding, a signature, a version prefix — hand
 * concatenation would corrupt it silently on the way out and the route would
 * refuse it on the way back in. One `params.set` costs nothing and removes the
 * dependency.
 */
export function cursorQuery(current: string, cursor: string | undefined): string {
	const params = new URLSearchParams(current);
	params.delete(CURSOR_PARAM);
	if (cursor !== undefined && cursor.length > 0) params.set(CURSOR_PARAM, cursor);
	return params.toString();
}

/**
 * WHAT A PAGE THAT WOULD NOT OPEN SAYS TO THE OPERATOR.
 *
 * IT STATES WHAT HAPPENED AND REFUSES TO STATE WHY, because this tier does not
 * know why. The first cut of this sentence said the link was stale — shared
 * before the filters moved, or edited on the way — and that is only one of the
 * things a refusal can mean. The request that failed carries no way to tell a
 * token the route rejected from a session that expired, a permission that was
 * withdrawn, a service that is down, or a laptop that went offline between the
 * click and the response. Naming the stale link as the cause would send an
 * operator to check a link when the real answer was "sign in again", and would
 * do it in the confident voice of a screen that had diagnosed something.
 *
 * SO THE COPY IS THE FACT PLUS THE REMEDY: the page did not open, here is the
 * first page instead. Saying nothing at all would be worse than either — the
 * screen would silently show page one to someone who followed a link to page
 * four.
 *
 * IT IS NOT IN THE SHARED COPY PACKAGE, deliberately. That package exists so the
 * Block Kit tier and the React tier cannot drift on wording they BOTH render,
 * and the Block Kit screens have no addressable cursor — no URL, no shareable
 * page, nothing that can arrive stale. This sentence has exactly one surface. If
 * a second one ever grows it, it moves.
 */
export const CURSOR_RESET_TITLE = "This link's page could not be opened";
export const CURSOR_RESET_DESCRIPTION =
	"Showing the first page of these filters instead. Whether that page is gone or the request simply failed, the answer that came back does not say.";

/**
 * WHAT A LIST THAT CANNOT BE PAGED SAYS — and why it is not the sentence above.
 *
 * THE TWO REFUSALS DIFFER IN WHAT IS AT STAKE, not in what went wrong. A deep
 * link naming a page that will not open costs nothing: there is nothing on screen
 * yet, and page one of its filters is a complete answer. A page refused while an
 * operator is already reading rows costs those rows — and answering it the same
 * way would throw them away to show the first page again. The refusal is
 * identical; the right response is not.
 *
 * IT NAMES NO DIRECTION, and that is a correction rather than a preference.
 * THREE controls now reach this sentence — `Load more`, `Next` and `Previous` —
 * so "the page after them could not be added" described a request an operator
 * pressing `Previous` never made. What is true of all three is that the page
 * ASKED FOR would not open.
 *
 * SO THE ROWS STAY AND THE PAGING STOPS. What was already loaded is still true —
 * nothing about it is disproved by another page being unavailable — so it stays
 * on screen, the retry's page-one rows are discarded rather than merged into it,
 * and the only thing withdrawn is the ability to move. The count line keeps its
 * "loaded so far" hedge where it had one, because there IS more out there and
 * this render still knows it.
 *
 * NO CAUSE, same doctrine as {@link CURSOR_RESET_DESCRIPTION}: a stale token, an
 * expired session and a settings read that blinked are one value by the time they
 * reach a screen. And no attempt at a fix the operator did not ask for — the two
 * things that restart paging honestly are a filter and a reload, so those are
 * what it names.
 */
export const PAGING_STOPPED_TITLE = "Paging stopped here";
export const PAGING_STOPPED_DESCRIPTION =
	"The rows already on screen are unaffected; the page that was asked for could not be opened. Apply a filter or reload to start again.";

/**
 * WHERE THE OPERATOR IS IN A KEYSET SCAN — a CLIENT-SIDE STACK of cursors.
 *
 * WHY A STACK AND NOT A QUERY. Keyset paging is one-directional by construction:
 * a cursor names "everything after this row", and there is no token for
 * "everything before it". The obvious fix is a reverse keyset read — flip the
 * ordering, take a page, reverse it back — and it was considered and DECLINED.
 * It is a second query shape in the store, a second index consideration, and a
 * second set of edge cases at the boundaries, bought to answer a question the
 * browser can already answer exactly: the cursors of the pages the operator
 * walked through are cursors the SERVICE ISSUED, and going back is replaying
 * one. Exact, free, and no server work.
 *
 * WHAT IS IN IT. `cursors` are the tokens each page after the first was fetched
 * with, in visit order, so the last entry is the page on screen and the entry
 * before it is where `Previous` goes. Page one is the ABSENCE of a cursor and
 * therefore the absence of an entry — which is why popping the last one lands
 * there with nothing on the wire.
 *
 * WHY `grounded` IS SEPARATE FROM THE DEPTH. A stack one deep can mean two
 * different things: the operator pressed `Next` once (they are on page two), or
 * they arrived on an address naming a page (they are on page ?). `grounded`
 * records which — whether the walk started at page one — and it is the whole
 * reason {@link pageNumber} can refuse to answer instead of inventing "page 2"
 * for a link to page 40. It is also what stops `Previous` popping a deep link's
 * single entry: that pop would land page one, which is not the page before this
 * one.
 */
export interface PageTrail {
	/** The cursors of the pages after the first, in the order they were visited.
	 *  The last is the page on screen. */
	readonly cursors: readonly string[];
	/** Did this walk start at page one? Only then is the depth a page number. */
	readonly grounded: boolean;
}

/** Page one, with nothing behind it — a fresh list, and where a filter apply
 *  puts every list. */
export const FIRST_PAGE: PageTrail = { cursors: [], grounded: true };

/**
 * The stack an ADDRESS produces, which is the one case that is not grounded.
 *
 * An absent value is page one, and so is an empty one, for the same reason
 * {@link seedCursor} treats them alike: `?cursor=` is a trimmed or stale link
 * rather than a request for the empty token. Anything else is a page this list
 * did not walk to — it can be paged forward from and returned to, and it cannot
 * be numbered.
 */
export function seedTrail(cursor: string | undefined): PageTrail {
	return cursor === undefined || cursor.length === 0
		? FIRST_PAGE
		: { cursors: [cursor], grounded: false };
}

/**
 * One page forward. Both controls that advance the page push here — `Next`,
 * which replaces the rows, and `Load more`, which keeps them: they disagree
 * about the window, never about the position.
 *
 * A REPEATED CURSOR IS NOT A PAGE, and this refuses it rather than trusting the
 * caller not to produce one. The screens make the same click unavailable while a
 * request is in flight, but "unavailable" is a rendered state and this is an
 * invariant: two presses resolved inside one React batch, a synthetic double
 * event, or a service that answers two consecutive pages with the same
 * `nextCursor` would each push the same token twice and leave the stack one
 * deeper than the pages actually walked — which shows up as a page NUMBER that
 * is quietly wrong, the one defect a pager exists to avoid. Idempotence on the
 * top of the stack costs one comparison and makes the guard unnecessary rather
 * than load-bearing.
 */
export function pushedPage(trail: PageTrail, cursor: string): PageTrail {
	if (trail.cursors.at(-1) === cursor) return trail;
	return { cursors: [...trail.cursors, cursor], grounded: trail.grounded };
}

/**
 * One page back: the stack to keep, and the cursor to fetch it with.
 *
 * `undefined` IS PAGE ONE, not "no answer" — popping the last entry off a
 * grounded stack leaves nothing, and nothing is exactly what page one is asked
 * for with.
 *
 * TOTAL, NOT PARTIAL. A stack with nowhere to go answers with itself and stays
 * put, so the controls' guard ({@link hasPreviousPage}) is what OFFERS the act
 * rather than what makes it safe. A helper that threw here, or that quietly
 * invented page one for a deep link, would make the guard load-bearing and the
 * bug it prevents invisible.
 */
export function poppedPage(trail: PageTrail): {
	readonly trail: PageTrail;
	readonly cursor: string | undefined;
} {
	if (!hasPreviousPage(trail)) return { trail, cursor: trail.cursors.at(-1) };
	const cursors = trail.cursors.slice(0, -1);
	return { trail: { cursors, grounded: trail.grounded }, cursor: cursors.at(-1) };
}

/** Which page this is, 1-based — or `undefined` when the walk did not start at
 *  page one and the number is therefore not knowable. See {@link PageTrail}. */
export function pageNumber(trail: PageTrail): number | undefined {
	return trail.grounded ? trail.cursors.length + 1 : undefined;
}

/**
 * Is there a page to go BACK to?
 *
 * A grounded stack answers yes as soon as it has one entry: popping it lands
 * page one, which is a real page. An UNGROUNDED one needs two — the deepest
 * entry is the address's own page, and popping it would land page one, which is
 * not the page before it.
 */
export function hasPreviousPage(trail: PageTrail): boolean {
	return trail.grounded ? trail.cursors.length > 0 : trail.cursors.length > 1;
}

/** One pager control: what it says, whether it can be used, and — when it
 *  cannot — why. Rendered by `PagerButton` in `ui.tsx`, which draws this and
 *  decides nothing. */
export interface PagerControl {
	readonly label: string;
	readonly unavailable: boolean;
	/**
	 * The reason it is dimmed, or the cost of pressing it — a sentence either
	 * way, and always one this tier can stand behind.
	 *
	 * Absent while a request is merely in flight: "busy" is not a place, and
	 * naming it would put an explanation on a control that is about to be usable
	 * again.
	 */
	readonly title: string | undefined;
}

export interface PagerView {
	readonly visible: boolean;
	readonly previous: PagerControl;
	readonly next: PagerControl;
	/** `Page 2 of 6` · `Pages 2–3 of 6` — or with either half an em dash.
	 *  `undefined` when neither half is known, because "Page — of —" is a line
	 *  that says nothing. Composed by `pagePositionLine` in
	 *  `@otta-sh/admin-presentation`. */
	readonly position: string | undefined;
}

/**
 * THE WHOLE PAGER DECIDED IN ONE PLACE, so two React lists draw it and neither
 * decides it.
 *
 * WHERE THE REST OF THE PAGER LIVES, since it is deliberately split across three
 * files: the STACK is {@link PageTrail} above; the WORDS and the arithmetic are
 * `pagePositionLine`, `pageCount` and the four title constants in
 * `@otta-sh/admin-presentation`'s `list-outcome.ts`; the MARKUP is `PagerButton`
 * in `ui.tsx`. This function is the seam that turns the first into the second so
 * the third has nothing left to decide.
 *
 * `M` IS DERIVED, NEVER FETCHED. The service already counts the filtered set
 * alongside the page it returns, and the plugin already sends the keyset limit
 * it paged by, so the page count is arithmetic over two values this render is
 * holding — see `pageCount`. The `total` handed in must be the one the count
 * line ACTUALLY STATED (`listOutcome`'s `statedTotal`), not the raw payload
 * figure: that is what stops a page count appearing under a caption that
 * withheld the very number it was derived from.
 *
 * THE LAST PAGE IS THE PAGE COUNT — with one exception that is the whole reason
 * this is not a one-liner. A render whose response carried no next cursor has
 * DIRECT evidence of standing on the last page, and that outranks arithmetic
 * over two statements taken at different moments. But when the arithmetic says
 * there are MORE pages than the one being stood on, the two disagree outright,
 * and answering "Page 6 of 6" beside a count line reading "200 orders" would
 * pick a winner the render has no grounds to pick. It dashes instead: an
 * absence, rather than either of two figures that cannot both be true.
 *
 * WITHDRAWN IS THE CALLER'S WORD. A failure card and the paging-stopped state
 * both take the whole control away — the list knows about those, this function
 * does not — and everything else here is about whether there is anywhere to go.
 *
 * VISIBLE MEANS "THIS LIST IS PAGED", not "there is a live control". A deep link
 * to the LAST page can go neither forward nor back, and hiding the pager there
 * would answer the one question the operator arrived with — where am I? — by
 * removing the only thing that could say. Any cursor in the stack means paging
 * happened, so the position stays on screen with both controls dimmed and
 * explained.
 */
export function pagerView(opts: {
	readonly trail: PageTrail;
	readonly hasNext: boolean;
	/** Rows on screen, which is what a `total` is sanity-checked against. */
	readonly rows: number;
	/** The count line's OWN figure — `listOutcome`'s `statedTotal`. */
	readonly total?: number;
	readonly pageSize?: number;
	/** How many responses the rows on screen were merged from. Above one, the
	 *  position states the window rather than its last page. */
	readonly span?: number;
	readonly busy: boolean;
	readonly withdrawn: boolean;
}): PagerView {
	const index = pageNumber(opts.trail);
	const derived = pageCount(opts.rows, {
		...(opts.total !== undefined ? { total: opts.total } : {}),
		...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
	});
	const pages =
		!opts.hasNext && index !== undefined
			? derived !== undefined && derived > index
				? undefined
				: index
			: derived;
	const canPrevious = hasPreviousPage(opts.trail);
	const accumulated = opts.span !== undefined && opts.span > 1;
	return {
		// ANY CURSOR IN THE STACK MEANS THIS LIST IS PAGED — see the note above.
		visible: !opts.withdrawn && (opts.hasNext || opts.trail.cursors.length > 0),
		previous: {
			label: PREVIOUS_PAGE_LABEL,
			unavailable: opts.busy || !canPrevious,
			title: canPrevious
				? undefined
				: opts.trail.grounded
					? PREVIOUS_AT_START_TITLE
					: PREVIOUS_UNWALKED_TITLE,
		},
		next: {
			label: NEXT_PAGE_LABEL,
			unavailable: opts.busy || !opts.hasNext,
			// THE COST IS STATED BEFORE THE CLICK, not discovered after it. Paging on
			// from an accumulated scan shows the next page alone, so the pages the
			// operator gathered are released — the one thing about this pager that
			// takes something away, and the one place it can be said in time.
			title: !opts.hasNext ? NEXT_AT_END_TITLE : accumulated ? NEXT_RELEASES_SCAN_TITLE : undefined,
		},
		position: pagePositionLine({
			...(index !== undefined ? { index } : {}),
			...(pages !== undefined ? { pages } : {}),
			...(opts.span !== undefined ? { span: opts.span } : {}),
		}),
	};
}

/**
 * THE STACK, AS SOMETHING A HISTORY ENTRY CAN HOLD.
 *
 * WHY THE ADDRESS IS NOT ENOUGH. A URL carries ONE cursor — the page being shown
 * — because that is what makes a link shareable, and a link that replayed a walk
 * would be a different feature. But a history ENTRY is not a link: it is this
 * browser's private record of somewhere this operator already stood, and
 * `history.state` exists precisely to carry what the address cannot. Without it,
 * every Back landed on a page whose stack had been thrown away, so a walked-to
 * page came back ungrounded — the position went to a dash and `Previous` dimmed,
 * two presses into a scan, for no reason the operator could see.
 *
 * IT IS PARSED DEFENSIVELY, like a URL, because it is the same kind of input:
 * `history.state` survives reloads, is written by whatever else shares this
 * document, and may have been serialized by an older build of this console. A
 * shape that does not match degrades to "no stack", which is exactly the
 * deep-link behaviour — legible, and never a thrown error inside a `popstate`
 * listener.
 */
export const PAGE_STATE_KEY = "ottaPage";

/** The entry's record of the walk, in the plainest shape `structuredClone` can
 *  carry. */
export function trailState(trail: PageTrail): { cursors: string[]; grounded: boolean } {
	return { cursors: [...trail.cursors], grounded: trail.grounded };
}

/** The walk an entry recorded, or `null` when it recorded none. `null` is not a
 *  failure: an entry pushed by the host, or by a build of this console older
 *  than the field, simply has nothing to say, and the caller falls back to
 *  seeding from the address. */
export function readTrailState(state: unknown): PageTrail | null {
	if (typeof state !== "object" || state === null) return null;
	const raw = (state as Record<string, unknown>)[PAGE_STATE_KEY];
	if (typeof raw !== "object" || raw === null) return null;
	const { cursors, grounded } = raw as { cursors?: unknown; grounded?: unknown };
	if (!Array.isArray(cursors) || typeof grounded !== "boolean") return null;
	if (!cursors.every((entry) => typeof entry === "string" && entry.length > 0)) return null;
	return { cursors: [...(cursors as string[])], grounded };
}

/**
 * WHY A PAGE CHANGED, which decides what it does to the history stack.
 *
 * THE TWO WERE ONE VALUE AND THAT WAS A BUG. The screens read "no cursor" as
 * "the list is correcting an address that would not open" and REPLACED the entry
 * — right for a refused deep link, which must not bury the entry the operator is
 * standing on under one they never asked for. Then `Previous` onto page one
 * started producing the same "no cursor", and an operator's deliberate step
 * backwards silently overwrote the entry they had stepped from. One value cannot
 * mean both "the operator went somewhere" and "the screen fixed something", so
 * it does not have to: the intent is stated.
 */
export type PageChangeKind = "navigate" | "correct";

/** What the list tells the screen when the page it is showing changes. The list
 *  states what happened; the screen decides what that does to the address and to
 *  the history stack. */
export interface PageChange {
	/** The token the address should name, or `undefined` for page one. */
	readonly cursor: string | undefined;
	/** The stack that produced it, for the entry's own state. */
	readonly trail: PageTrail;
	readonly kind: PageChangeKind;
}
