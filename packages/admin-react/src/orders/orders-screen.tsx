/**
 * The `/orders` console page — list or detail, and the navigation between them.
 *
 * THE DRILL-IN HAS A URL, which is the whole difference from the Block Kit
 * screen. There, "no client routing, no URL per drill-in, back is a rendered
 * button" (§0.5): every interaction POSTs and replaces the entire block tree, so
 * an order's detail is a transient render with no address. Here the selected
 * order lives in the query string, so a browser Back goes back, a reload lands
 * where the operator was, and an order can be sent to a colleague as a link.
 *
 * WHY A QUERY PARAMETER RATHER THAN A PATH SEGMENT. EmDash's admin router
 * resolves a plugin page by matching the derived path against the descriptor's
 * declared `adminPages`; `/orders/<uuid>` is not a declared page and would
 * resolve no component at all. `?order=<uuid>` stays on the declared `/orders`
 * page while still being a real, shareable, back-navigable address.
 *
 * `popstate` IS LISTENED TO, AND THE STATE IS STILL THE SOURCE OF TRUTH. The
 * admin SPA has its own router; rather than reach into it, this component pushes
 * history entries and reads them back, and renders from its own state either
 * way. If a future EmDash intercepts the history in a way that stops the
 * listener firing, the screen still works — it loses the browser Back button,
 * not the navigation.
 *
 * THE FILTER, THE TAB AND THE PAGE ARE ALL IN THE ADDRESS (F22, F23), and
 * their plumbing lives here rather than in the list and the detail for one
 * reason: this is the file that already touches `window.history`, and a screen
 * with two writers to the same address bar is a screen whose URL and rendered
 * state drift. The list and the detail ANNOUNCE a change and are TOLD what to
 * start from; neither reads or writes history itself.
 */
import type { OrdersFilter } from "../console-api.js";
import { ORDER_STATES } from "@otta-sh/admin-presentation";
import * as React from "react";
import {
	CURSOR_PARAM,
	FIRST_PAGE,
	cursorQuery,
	entryState,
	readCursor,
	readTrailState,
	seedTrail,
	type PageChange,
	type PageTrail,
} from "../accumulate.js";
import { ConsoleStyles } from "../ui.js";
import { OrderDetail } from "./order-detail.js";
import { OrdersList } from "./orders-list.js";

/** The query parameter carrying the drilled-into order. */
export const ORDER_PARAM = "order";

/**
 * THE FILTER PARAMETERS (F22). Unprefixed, because the drill-in's `order`
 * already set that convention and a link is read by people.
 *
 * `q` rather than `search`: it is the short name every other admin's address bar
 * uses, and the field it feeds is `search` because that is what the port calls
 * it. The two do not have to match.
 */
const FILTER_PARAMS = ["status", "period", "from", "to", "q"] as const;

/** The slug per tab, in tab order (F23). NOT the labels — a label is copy and
 *  may be reworded, while these are addresses that have to survive a rewording;
 *  and NOT indices, which reorder silently the first time a tab is inserted. */
export const ORDER_TAB_SLUGS = ["order", "fulfilment", "money", "history"] as const;

/** The query parameter carrying the shared tab. */
const TAB_PARAM = "tab";

/** Absent, empty, or anything the caller cannot make sense of, as absent. A URL
 *  is user input: it arrives hand-edited, truncated, and years out of date. */
function param(params: URLSearchParams, name: string): string | undefined {
	const value = params.get(name);
	return value !== null && value.length > 0 ? value : undefined;
}

/**
 * THE PERIOD KEYS the Period menu can take.
 *
 * The menu's OPTIONS arrive with the list payload — labels are authored once
 * and shipped down the wire — but a URL is decoded before any payload exists,
 * so the set of addressable keys has to be stated here, the same way the tab
 * slugs are. Like a slug, a key is an address rather than copy: it is spelled
 * once and never reworded, and an unrecognised one falls back to the default.
 */
const PERIOD_KEYS = ["last7", "last30", "last90", "custom"] as const;

/**
 * A parameter is a value the panel could have SUBMITTED, or it is absent.
 *
 * The tab slug has always resolved this way and the filters did not, which let
 * `?status=nonsense` travel all the way to the service while both the panel and
 * the summary line above it said "any" — the address bar and the request
 * disagreeing about what was asked for, which is the one thing a URL carrying
 * screen state must never do. An unknown value is a stale link or a typo, and
 * the answer to both is the default.
 */
function oneOf(value: string | undefined, allowed: readonly string[]): string | undefined {
	return value !== undefined && allowed.includes(value) ? value : undefined;
}

/**
 * Decode the list's filter from a query string (F22).
 *
 * PURE, which is the point of splitting it out: a missing parameter is the
 * DEFAULT, never an error and never an empty result, so the ordinary first visit
 * — no parameters at all — decodes to the same `{}` the list starts from anyway.
 */
export function readOrdersFilter(search: string): OrdersFilter {
	const params = new URLSearchParams(search);
	const period = oneOf(param(params, "period"), PERIOD_KEYS);
	// `from`/`to` belong to the custom range and to nothing else, which is the
	// rule the filter panel itself applies. Honouring it here is what makes a
	// decoded filter one the list could have produced by hand.
	const custom = period === "custom";
	const status = oneOf(param(params, "status"), ORDER_STATES);
	const from = custom ? param(params, "from") : undefined;
	const to = custom ? param(params, "to") : undefined;
	const text = param(params, "q");
	return {
		...(status === undefined ? {} : { status }),
		...(period === undefined ? {} : { period }),
		...(from === undefined ? {} : { from }),
		...(to === undefined ? {} : { to }),
		...(text === undefined ? {} : { search: text }),
	};
}

/**
 * Encode the list's filter into a query string (F22).
 *
 * A parameter is written ONLY when the filter is off its default: the list has
 * already dropped the "any" sentinel and the empty string by the time a filter
 * reaches here, so the absence of a parameter and the default are the same fact
 * said once. `URLSearchParams` does the escaping — a search term is free text,
 * and hand-rolled concatenation loses to the first `&` someone types.
 *
 * It starts from the CURRENT query rather than from nothing, so the drill-in's
 * `order` and anything the host admin put there survive a filter change.
 */
export function ordersFilterQuery(current: string, filter: OrdersFilter): string {
	const params = new URLSearchParams(current);
	for (const name of FILTER_PARAMS) params.delete(name);
	// THE PAGE GOES WITH THE PREDICATE IT WAS ISSUED UNDER. A filter change
	// is page one of a NEW set — the list clears its cursor to say so — and a
	// cursor left in the address would describe a page of the filter the operator
	// just left: exactly the pairing `continuationCursor` refuses in memory,
	// preserved in a link and handed back to a reload as though it were valid.
	params.delete(CURSOR_PARAM);
	if (filter.status !== undefined && filter.status.length > 0) params.set("status", filter.status);
	if (filter.period !== undefined && filter.period.length > 0) {
		params.set("period", filter.period);
		// The SAME custom-only rule the decode applies, applied on the way out:
		// a preset resolves its own window, so a `from` beside one is a leftover
		// from the range the operator abandoned. Writing it would put a date in
		// the address that nothing reads back — a link that describes a filter
		// the screen it opens will not show.
		if (filter.period === "custom") {
			if (filter.from !== undefined && filter.from.length > 0) params.set("from", filter.from);
			if (filter.to !== undefined && filter.to.length > 0) params.set("to", filter.to);
		}
	}
	if (filter.search !== undefined && filter.search.length > 0) params.set("q", filter.search);
	return params.toString();
}

/** Which tab a shared link names (F23) — the first tab whenever the slug is
 *  absent or unrecognised, which is what keeps an old link working across a
 *  rename or a removal. */
export function readOrderTab(search: string): number {
	const slug = param(new URLSearchParams(search), TAB_PARAM);
	const index = ORDER_TAB_SLUGS.indexOf(slug as (typeof ORDER_TAB_SLUGS)[number]);
	return index === -1 ? 0 : index;
}

/** The query naming a tab (F23) — omitted for the default tab, so the common
 *  link stays the short one. */
export function orderTabQuery(current: string, index: number): string {
	const params = new URLSearchParams(current);
	params.delete(TAB_PARAM);
	const slug = ORDER_TAB_SLUGS[index];
	if (slug !== undefined && index > 0) params.set(TAB_PARAM, slug);
	return params.toString();
}

function currentSearch(): string {
	return typeof window === "undefined" ? "" : window.location.search;
}

/** The entry's own state, which is where the pager's stack lives — see
 *  {@link PAGE_STATE_KEY}. `null` off the browser, exactly as the address is
 *  empty there. */
function currentState(): unknown {
	return typeof window === "undefined" ? null : window.history.state;
}

/**
 * Swap the whole query, keeping the entry.
 *
 * REPLACE, NEVER PUSH, for everything that refines one view. A filter and a tab
 * are not places: pushing them would make the browser's Back walk backwards
 * through every intermediate filter before it ever left the screen, and would
 * break the single-pushed-entry assumption `← Back to orders` relies on.
 */
function replaceQuery(query: string, trail?: PageTrail): void {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	url.search = query;
	// THE ENTRY'S OWN RECORD OF THE WALK rides alongside the address — through
	// {@link entryState}, which merges rather than clobbers. This function is used
	// by filters and tabs too, and a filter change must not silently drop the
	// drill-in state a later Back would read.
	window.history.replaceState(entryState(window.history.state, {}, trail), "", url);
}

/**
 * Swap the whole query, ON A NEW ENTRY.
 *
 * THE ONE THING THAT PUSHES WITHOUT LEAVING THE LIST, and the exception is the
 * point of putting the page there: a filter and a tab REFINE one view, but a
 * page is a PLACE the operator went to. Replacing here would leave Back with nothing to walk — the
 * browser's own Back would jump straight out of a four-page scan to whatever
 * came before the screen — which is the behaviour that made the address bar and
 * the pagination disagree in the first place.
 *
 * The entry names no record, because a page of the list is not one; nothing
 * reads this state (the selection is read off the address, not off
 * `history.state`), so it is a statement about the entry rather than a channel.
 */
function pushQuery(query: string, trail: PageTrail): void {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	url.search = query;
	// THE STACK GOES ON THE ENTRY, and this is the whole reason a traversal can
	// land on page four still knowing it is page four. The ADDRESS deliberately
	// carries one cursor — that is what makes a link shareable, and a link that
	// replayed a walk would be a different feature — but a history entry is this
	// browser's private note about somewhere this operator already stood, and it
	// can hold what a link cannot.
	window.history.pushState(entryState(window.history.state, { ottaOrder: null }, trail), "", url);
}

function readSelectedOrder(): string | null {
	if (typeof window === "undefined") return null;
	const value = new URLSearchParams(window.location.search).get(ORDER_PARAM);
	return value !== null && value.length > 0 ? value : null;
}

function pushSelectedOrder(orderId: string, trail: PageTrail): void {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	url.searchParams.set(ORDER_PARAM, orderId);
	// THE RECORD'S ENTRY CARRIES THE LIST'S PAGE TOO. A drill-in from page four is
	// still page four: the operator opened a record from there, and Back — or a
	// reload of the record's own address followed by `Back to orders` — has to
	// return them to a list that knows it. Composing this entry without the stack
	// is how the pager forgot its position one click away from where it earned it.
	window.history.pushState(
		entryState(window.history.state, { ottaOrder: orderId }, trail),
		"",
		url,
	);
}

/**
 * `← Back to orders` POPS the history entry the drill-in pushed. It does not
 * push a third one.
 *
 * The module doc above promises "a browser Back goes back", and pushing on the
 * way out would make that false in the most annoying way available: list →
 * detail → list would be three entries, so the browser's own Back would return
 * the operator to the DETAIL they just left, and a second press to the list
 * again. Two controls that both say "back" and disagree about where that is.
 *
 * `history.back()` is asynchronous and lands in the `popstate` listener, which
 * is what actually clears the selection — so the URL and the rendered state
 * change together, from one source, rather than from two writers that can
 * drift.
 *
 * THE GUARD: only pop when this component pushed the entry it would be popping.
 * An operator who arrived on `?order=…` directly — a pasted link, a reload, a
 * bookmark — has no pushed entry behind them, and `history.back()` would take
 * them out of the admin entirely. That case replaces the URL instead, which
 * clears the parameter without touching the stack.
 */
function popSelectedOrder(pushed: boolean): void {
	if (typeof window === "undefined") return;
	if (pushed) {
		window.history.back();
		return;
	}
	const url = new URL(window.location.href);
	url.searchParams.delete(ORDER_PARAM);
	// THE TAB BELONGS TO THE RECORD, so it leaves with it. This path REPLACES,
	// which fires no `popstate`, so nothing re-derives the screen from the
	// address afterwards: a `tab` left behind here would sit on a list URL that
	// has no tabs and then seed the NEXT record the operator opened.
	url.searchParams.delete(TAB_PARAM);
	// MERGED, NEVER CLOBBERED: this writer means "no record is open" and nothing
	// else, so the entry's page stack is not its to discard.
	window.history.replaceState(entryState(window.history.state, { ottaOrder: null }), "", url);
}

export function OrdersScreen(): React.ReactElement {
	const [selected, setSelected] = React.useState<string | null>(() => readSelectedOrder());
	/** Seeded from the query string so a shared link lands FILTERED, with the
	 *  panel showing why (F22), and re-derived on `popstate` so Back out of a
	 *  detail restores the filters as well as the list. */
	const [filter, setFilter] = React.useState<OrdersFilter>(() => readOrdersFilter(currentSearch()));
	/**
	 * THE PAGE THE ADDRESS NAMES, read the same way and at the same moment as
	 * the filter — the two are one pair, and a cursor is only meaningful against
	 * the predicate it was issued under.
	 *
	 * IT IS ONLY EVER A SEED. The list owns where it has paged to once it is
	 * mounted; this value is what it STARTS from, on a first mount and on the
	 * remount a traversal triggers. Keeping it in step with the address afterwards
	 * is what stops a later remount seeding the list from a page it already left.
	 */
	const [cursor, setCursor] = React.useState<string | undefined>(() => readCursor(currentSearch()));
	/**
	 * THE WALK THIS ENTRY RECORDED, and the reason Back does not lose the pager.
	 *
	 * Read from `history.state`, which survives a traversal and a reload; absent
	 * (a pasted link, a fresh tab, an entry pushed by the host) it falls back to
	 * seeding from the address, which is the deep-link behaviour. Like the cursor
	 * it is ONLY EVER A SEED: the list owns where it has paged to once mounted.
	 */
	const [trail, setTrail] = React.useState<PageTrail>(
		() => readTrailState(currentState()) ?? seedTrail(readCursor(currentSearch())),
	);
	const [tab, setTab] = React.useState<number>(() => readOrderTab(currentSearch()));
	/** Bumped on every `popstate`, and used as the child's `key`: a traversal is
	 *  the one moment the URL knows something the mounted child does not, so the
	 *  child is rebuilt from it rather than being told to re-seed itself. A
	 *  filter the LIST applied does not bump this — the list already holds that
	 *  state, and remounting would throw away the page it just fetched. */
	const [restore, setRestore] = React.useState(0);
	/** Did THIS component push the entry currently on top? See
	 *  {@link popSelectedOrder} — an operator who arrived on `?order=…` directly
	 *  has nothing of ours to pop. */
	const pushed = React.useRef(false);

	/**
	 * NAVIGATION PUSHES; A CORRECTION REPLACES — and the LIST says which, because
	 * the address cannot.
	 *
	 * A page the operator asked for is somewhere they went, so it earns a history
	 * entry and Back walks the pages they actually visited. A correction is not a
	 * journey: the list is reporting that the page the address named would not
	 * open AND that page one has since landed, so the entry the operator is
	 * standing on is fixed in place rather than buried under a second one they
	 * never asked for.
	 *
	 * THIS USED TO BE INFERRED FROM "NO CURSOR", AND THAT WAS A BUG. `undefined`
	 * meant page one, and page one is reached BOTH ways — by the recovery above
	 * and by an operator pressing `Previous` from page two. Inferring the intent
	 * from the value made every deliberate step back overwrite the entry it was
	 * stepping from, deleting the page they had just left from their own history.
	 * See {@link PageChangeKind}.
	 *
	 * EVERY WRITE CARRIES THE STACK. The address holds one cursor, which is what
	 * makes a link shareable; the entry holds the walk behind it, which is what
	 * lets a traversal land on page four still knowing it is page four.
	 *
	 * `useCallback` IS REQUIRED, NOT TIDINESS. The list depends on this function
	 * in its fetch effect; a fresh arrow on every render would re-run that effect,
	 * and therefore re-fetch, on every render. It closes over nothing that changes
	 * — `setCursor` is stable and the rest is module scope — so the empty
	 * dependency list is exact rather than a suppression.
	 */
	const onCursorChange = React.useCallback((change: PageChange) => {
		setCursor(change.cursor);
		setTrail(change.trail);
		const query = cursorQuery(currentSearch(), change.cursor);
		if (change.kind === "correct") replaceQuery(query, change.trail);
		else pushQuery(query, change.trail);
	}, []);

	React.useEffect(() => {
		const onPop = () => {
			pushed.current = false;
			setSelected(readSelectedOrder());
			setFilter(readOrdersFilter(currentSearch()));
			// THE PAGE RIDES THE SAME RESTORE PATH THE FILTER DOES, and deliberately
			// not a second mechanism: a traversal re-derives the whole address at
			// once and the `key={restore}` bump below rebuilds the list from all of
			// it. A cursor restored through some other channel would race the filter
			// it belongs to through the one commit where they disagree.
			setCursor(readCursor(currentSearch()));
			// AND THE STACK THE ENTRY CARRIED. Without it a Back onto a page the
			// operator had walked to came back as if it had been pasted in: position
			// dashed, `Previous` dimmed, two presses into a scan.
			setTrail(readTrailState(window.history.state) ?? seedTrail(readCursor(currentSearch())));
			setTab(readOrderTab(currentSearch()));
			setRestore((n) => n + 1);
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	return (
		<div style={{ padding: 24, maxInlineSize: 1100, textAlign: "start" }}>
			<ConsoleStyles />
			{selected === null ? (
				<OrdersList
					key={restore}
					initialFilter={filter}
					initialCursor={cursor}
					initialTrail={trail}
					onFilterChange={(next) => {
						// The filter query drops the cursor with the filter it belonged to
						// (see `ordersFilterQuery`), so this one write says both things —
						// and the entry's stack goes with them, because a stack from the
						// previous predicate is exactly what `Previous` must never pop.
						setCursor(undefined);
						setTrail(FIRST_PAGE);
						replaceQuery(ordersFilterQuery(currentSearch(), next), FIRST_PAGE);
					}}
					onCursorChange={onCursorChange}
					onOpen={(orderId) => {
						pushSelectedOrder(orderId, trail);
						pushed.current = true;
						setSelected(orderId);
					}}
				/>
			) : (
				<OrderDetail
					key={restore}
					orderId={selected}
					initialTab={tab}
					onTabChange={(index) => {
						replaceQuery(orderTabQuery(currentSearch(), index));
					}}
					onBack={() => {
						const wasPushed = pushed.current;
						popSelectedOrder(wasPushed);
						pushed.current = false;
						// A pop is asynchronous and `popstate` will clear the selection;
						// a REPLACE fires no event, so that path clears it here — the tab
						// included, because the address it just rewrote no longer names one.
						if (!wasPushed) {
							setSelected(null);
							setTab(0);
						}
					}}
				/>
			)}
		</div>
	);
}
