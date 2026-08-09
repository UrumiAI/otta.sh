/**
 * The `/products` console page — list or detail, and the navigation between
 * them (INC-21).
 *
 * THE DRILL-IN HAS A URL, which is the whole difference from the Block Kit
 * screen. There, "no client routing, no URL per drill-in, back is a rendered
 * button" (§0.5): every interaction POSTs and replaces the entire block tree, so
 * a product's detail is a transient render with no address. Here the selected
 * product lives in the query string, so a browser Back goes back, a reload lands
 * where the merchant was, and a product can be sent to a colleague as a link —
 * which on THIS screen is what a "please reprice this" message has always
 * needed and never had.
 *
 * WHY A QUERY PARAMETER RATHER THAN A PATH SEGMENT. EmDash's admin router
 * resolves a plugin page by matching the derived path against the descriptor's
 * declared `adminPages`; `/products/<uuid>` is not a declared page and would
 * resolve no component at all. `?product=<uuid>` stays on the declared
 * `/products` page while still being a real, shareable, back-navigable address.
 *
 * IT IS THE SAME MECHANISM `orders-screen.tsx` USES, deliberately and to the
 * line: the same push-on-drill, the same pop-on-back, the same guard for an
 * operator who arrived on a pasted link with nothing of ours to pop, and the
 * same filter and tab plumbing. Two screens' navigation behaving differently is
 * the kind of difference nobody documents and everybody trips on. The parameter
 * names differ, and — because only this screen has forms that hold typed work —
 * the unsaved-work guard below.
 */
import type { ProductsFilter } from "../console-api.js";
import { PRODUCT_KIND_LABELS } from "@otta-sh/admin-presentation";
import * as React from "react";
import { CURSOR_PARAM, cursorQuery, readCursor } from "../accumulate.js";
import { ConsoleStyles } from "../ui.js";
import { ProductDetail } from "./product-detail.js";
import { ProductsList } from "./products-list.js";

/** The query parameter carrying the drilled-into product. */
export const PRODUCT_PARAM = "product";

/** THE FILTER PARAMETERS (F22) — unprefixed, matching the drill-in's `product`.
 *  `kind` and `low` are shorter than the fields they feed (`productKind`,
 *  `lowStock`) because a URL is read by people; the two do not have to match. */
const FILTER_PARAMS = ["status", "kind", "low", "q"] as const;

/** The slug per tab, in tab order (F23). NOT the labels — a label is copy and
 *  may be reworded, while these are addresses that have to survive a rewording;
 *  and NOT indices, which reorder silently the first time a tab is inserted. */
export const PRODUCT_TAB_SLUGS = ["product", "stock"] as const;

/** The query parameter carrying the shared tab. */
const TAB_PARAM = "tab";

/** Absent, empty, or anything the caller cannot make sense of, as absent. A URL
 *  is user input: it arrives hand-edited, truncated, and years out of date. */
function param(params: URLSearchParams, name: string): string | undefined {
	const value = params.get(name);
	return value !== null && value.length > 0 ? value : undefined;
}

/**
 * THE VALUES THE TWO SELECTS CAN TAKE.
 *
 * The kinds are read off the label record rather than restated, so a third kind
 * becomes addressable the moment it is authored. The combined Status select has
 * no such record — its options are authored beside the wording that describes
 * them and shipped with the list payload — and a URL is decoded before any
 * payload exists, so the addressable set has to be stated here, the same way the
 * tab slugs are. Like a slug, one of these is an address rather than copy.
 */
const PRODUCT_KIND_VALUES: readonly string[] = Object.keys(PRODUCT_KIND_LABELS);
const PRODUCT_STATUS_VALUES = ["true", "false", "archived"] as const;

/**
 * A parameter is a value the panel could have SUBMITTED, or it is absent.
 *
 * The tab slug has always resolved this way and the filters did not, which let
 * `?status=nonsense` travel all the way to the service while both selects still
 * read "any" — the panel and the request disagreeing about what was asked for,
 * which is the one thing a URL carrying screen state must never do. An unknown
 * value is a stale link or a typo, and the answer to both is the default.
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
export function readProductsFilter(search: string): ProductsFilter {
	const params = new URLSearchParams(search);
	const status = oneOf(param(params, "status"), PRODUCT_STATUS_VALUES);
	const kind = oneOf(param(params, "kind"), PRODUCT_KIND_VALUES);
	const text = param(params, "q");
	// ON is `low=1` and nothing else. The flag is written as `low=1` or omitted —
	// never as `low=0` — so every other spelling, including a stale `low=0`, a
	// hand-typed `low=true` and a typo, is simply the default, which is off.
	const low = params.get("low") === "1";
	return {
		...(status === undefined ? {} : { status }),
		...(kind === undefined ? {} : { productKind: kind }),
		...(low ? { lowStock: true } : {}),
		...(text === undefined ? {} : { search: text }),
	};
}

/**
 * Encode the list's filter into a query string (F22).
 *
 * A parameter is written ONLY when the filter is off its default: the list has
 * already dropped the "any" sentinel and the empty string by the time a filter
 * reaches here, so the absence of a parameter and the default are the same fact
 * said once — and the boolean appears as `low=1` or not at all, never as
 * `low=0`. `URLSearchParams` does the escaping, because a search term is free
 * text and hand-rolled concatenation loses to the first `&` someone types.
 *
 * It starts from the CURRENT query rather than from nothing, so the drill-in's
 * `product` and anything the host admin put there survive a filter change.
 */
export function productsFilterQuery(current: string, filter: ProductsFilter): string {
	const params = new URLSearchParams(current);
	for (const name of FILTER_PARAMS) params.delete(name);
	// THE PAGE GOES WITH THE PREDICATE IT WAS ISSUED UNDER — same rule, same
	// reason, as the Orders screen: a filter change is page one of a new set, and
	// a cursor left in the address would describe a page of the filter the
	// merchant just left.
	params.delete(CURSOR_PARAM);
	if (filter.status !== undefined && filter.status.length > 0) params.set("status", filter.status);
	if (filter.productKind !== undefined && filter.productKind.length > 0)
		params.set("kind", filter.productKind);
	if (filter.lowStock === true) params.set("low", "1");
	if (filter.search !== undefined && filter.search.length > 0) params.set("q", filter.search);
	return params.toString();
}

/** Which tab a shared link names (F23) — the first tab whenever the slug is
 *  absent or unrecognised, which is what keeps an old link working across a
 *  rename or a removal. */
export function readProductTab(search: string): number {
	const slug = param(new URLSearchParams(search), TAB_PARAM);
	const index = PRODUCT_TAB_SLUGS.indexOf(slug as (typeof PRODUCT_TAB_SLUGS)[number]);
	return index === -1 ? 0 : index;
}

/** The query naming a tab (F23) — omitted for the default tab, so the common
 *  link stays the short one. */
export function productTabQuery(current: string, index: number): string {
	const params = new URLSearchParams(current);
	params.delete(TAB_PARAM);
	const slug = PRODUCT_TAB_SLUGS[index];
	if (slug !== undefined && index > 0) params.set(TAB_PARAM, slug);
	return params.toString();
}

function currentSearch(): string {
	return typeof window === "undefined" ? "" : window.location.search;
}

/**
 * Swap the whole query, keeping the entry.
 *
 * REPLACE, NEVER PUSH, for everything that refines one view. A filter and a tab
 * are not places: pushing them would make the browser's Back walk backwards
 * through every intermediate filter before it ever left the screen, and would
 * break the single-pushed-entry assumption `← Back to pricing & inventory`
 * relies on. Returns the resulting address, which the caller keeps so it can
 * restore it.
 */
function replaceQuery(query: string): string {
	if (typeof window === "undefined") return "";
	const url = new URL(window.location.href);
	url.search = query;
	window.history.replaceState(window.history.state, "", url);
	return url.href;
}

/**
 * Swap the whole query, ON A NEW ENTRY.
 *
 * THE ONE THING THAT PUSHES WITHOUT LEAVING THE LIST, and the exception is
 * deliberate: a filter and a tab refine one view, but a page is a PLACE the
 * merchant went to. Replacing here would leave Back with nothing to walk.
 *
 * It does NOT touch `detailHref`: this fires only while the list is on screen,
 * where there is no record to restore.
 */
function pushQuery(query: string): void {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	url.search = query;
	window.history.pushState({ ottaProduct: null }, "", url);
}

function readSelectedProduct(): string | null {
	if (typeof window === "undefined") return null;
	const value = new URLSearchParams(window.location.search).get(PRODUCT_PARAM);
	return value !== null && value.length > 0 ? value : null;
}

function pushSelectedProduct(productId: string): string {
	if (typeof window === "undefined") return "";
	const url = new URL(window.location.href);
	url.searchParams.set(PRODUCT_PARAM, productId);
	window.history.pushState({ ottaProduct: productId }, "", url);
	return url.href;
}

/**
 * `← Back to pricing & inventory` POPS the history entry the drill-in pushed.
 * It does not push a third one — otherwise list → detail → list would be three
 * entries, so the browser's own Back would return the merchant to the DETAIL
 * they just left. Two controls that both say "back" and disagree about where
 * that is.
 *
 * THE GUARD: only pop when this component pushed the entry it would be popping.
 * A merchant who arrived on `?product=…` directly — a pasted link, a reload, a
 * bookmark — has no pushed entry behind them, and `history.back()` would take
 * them out of the admin entirely. That case replaces the URL instead.
 */
function popSelectedProduct(pushed: boolean): void {
	if (typeof window === "undefined") return;
	if (pushed) {
		window.history.back();
		return;
	}
	const url = new URL(window.location.href);
	url.searchParams.delete(PRODUCT_PARAM);
	// THE TAB BELONGS TO THE RECORD, so it leaves with it. This path REPLACES,
	// which fires no `popstate`, so nothing re-derives the screen from the
	// address afterwards: a `tab` left behind here would sit on a list URL that
	// has no tabs and then seed the NEXT record the merchant opened.
	url.searchParams.delete(TAB_PARAM);
	window.history.replaceState({ ottaProduct: null }, "", url);
}

export function ProductsScreen(): React.ReactElement {
	const [selected, setSelected] = React.useState<string | null>(() => readSelectedProduct());
	/** Seeded from the query string so a shared link lands FILTERED, with the
	 *  panel showing why (F22), and re-derived on `popstate` so Back out of a
	 *  detail restores the filters as well as the list. */
	const [filter, setFilter] = React.useState<ProductsFilter>(() =>
		readProductsFilter(currentSearch()),
	);
	/** THE PAGE THE ADDRESS NAMES, read at the same moment as the filter
	 *  because the two are one pair — a cursor is only meaningful against the
	 *  predicate it was issued under. It is only ever a SEED: the list owns where
	 *  it has paged to once mounted, and this is what it starts from on a first
	 *  mount and on the remount a traversal triggers. */
	const [cursor, setCursor] = React.useState<string | undefined>(() => readCursor(currentSearch()));
	const [tab, setTab] = React.useState<number>(() => readProductTab(currentSearch()));
	/** Bumped on every `popstate`, and used as the child's `key`: a traversal is
	 *  the one moment the URL knows something the mounted child does not, so the
	 *  child is rebuilt from it rather than being told to re-seed itself. A
	 *  filter the LIST applied does not bump this — the list already holds that
	 *  state, and remounting would throw away the page it just fetched. The
	 *  unsaved-work guard below does not bump it either, for the same reason
	 *  written much larger: remounting is exactly the loss it exists to prevent. */
	const [restore, setRestore] = React.useState(0);
	/** Bumped to ask the detail to raise its OWN leave confirm. The dialog stays
	 *  where it is: this screen decides that a confirm is owed, and the detail —
	 *  which alone knows which sections are dirty — decides what it says.
	 *
	 *  IT IS AN EVENT, NOT A LEVEL, and the detail reads it as one: a bump is a
	 *  request from the record that is on screen NOW. The count is never reset,
	 *  because a reset is itself a value the detail would have to tell apart from
	 *  a request; the detail remembers what the count was when it mounted and
	 *  reacts only to a change, so a fresh record — and every record is fresh
	 *  after a `key={restore}` remount — starts owing nothing. */
	const [leavePrompt, setLeavePrompt] = React.useState(0);
	/** Did THIS component push the entry currently on top? */
	const pushed = React.useRef(false);
	/** What was on screen BEFORE the traversal. `popstate` reports where you
	 *  landed, never where you left. */
	const selectedRef = React.useRef<string | null>(selected);
	/** Reported up by the detail, because only its forms know. */
	const unsaved = React.useRef(false);
	/**
	 * The detail's full address — the ONLY thing the guard is allowed to put
	 * back.
	 *
	 * Composing one instead, from the drilled-into id and wherever the traversal
	 * landed, is wrong twice over for a record that was never reached by a click:
	 * the entry behind a pasted link is whatever the merchant was on before, so
	 * `<that page>?product=…` addresses a page that is not this screen, and the
	 * `tab` they were reading is dropped, leaving the address and the rendered tab
	 * disagreeing. So it is recorded whenever the screen ARRIVES at a record —
	 * click, pasted link, reload, or a traversal that lands on one — and kept
	 * current through tab changes; the guard refuses to act without it rather than
	 * approximating it.
	 */
	const detailHref = React.useRef<string | null>(null);

	React.useEffect(() => {
		selectedRef.current = selected;
	}, [selected]);

	React.useEffect(() => {
		if (typeof window === "undefined") return;
		detailHref.current = selected === null ? null : window.location.href;
	}, [selected, restore]);

	/**
	 * THE ONE TRAVERSAL NO `popstate` LISTENER CAN SEE: the one that leaves the
	 * document.
	 *
	 * `popstate` is only delivered to a document that survives the traversal, so
	 * the guard below covers exactly the traversals that stay inside this one.
	 * Two do not. A merchant who opened a pasted `?product=…` as the FIRST entry
	 * in a fresh tab backs out of the document entirely. And a Back pressed twice
	 * in quick succession is resolved by the browser against a session history it
	 * has not yet been told about the re-push in — so the second press can carry
	 * the merchant past the entry the guard just restored and out of the document,
	 * with no event delivered to anything left here to notice.
	 *
	 * `beforeunload` is the only thing that fires in both cases, it needs nothing
	 * new to work, and its worst behaviour is a browser-drawn sentence instead of
	 * this screen's own. It reads the ref rather than a dependency so that the
	 * listener is registered once and cannot be momentarily absent between a keyed
	 * remount and its next effect — the window in which a fast second press lands.
	 */
	React.useEffect(() => {
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!unsaved.current) return;
			event.preventDefault();
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, []);

	React.useEffect(() => {
		const onPop = () => {
			const was = selectedRef.current;
			const next = readSelectedProduct();
			/*
			 * BROWSER BACK, WITH UNSAVED WORK BEHIND IT.
			 *
			 * `popstate` CANNOT BE CANCELLED. By the time this runs the entry is
			 * already gone and the address bar already shows the list, so there is
			 * nothing to prevent — there is only putting it back. Pushing the detail
			 * entry again is depth-NEUTRAL (one entry popped, one pushed), and that
			 * is the property that keeps this from becoming a trap: the merchant is
			 * exactly where they were, on a stack exactly as deep as it was, so
			 * `Leave` is still one Back away and pressing Back twice in a row simply
			 * asks twice.
			 *
			 * For the ordinary single Back the re-push discards only the forward
			 * entries this traversal had just created; before it, the detail WAS the
			 * tip, so nothing the merchant could have reached is lost. THAT IS THE
			 * SINGLE-STEP CASE AND ONLY THE SINGLE-STEP CASE: a traversal of several
			 * entries at once — a `go(-n)` from the Back button's long-press menu —
			 * arrives here as ONE event that reports where it landed and never how far
			 * it came, so the re-push restores the record and truncates the n−1 entries
			 * in between. The typed work is kept, which is what this guard is for; that
			 * stretch of history is not, and cannot be from here.
			 *
			 * It fires only for a traversal that leaves the record — `next !== was`.
			 * A traversal landing on the same record is a tab or a filter, not a
			 * departure, and must not put a dialog in the way.
			 *
			 * THE CASE THIS DELIBERATELY DOES NOT COVER: a `popstate` that lands on
			 * the SAME record (`next === was`) while it holds unsaved work skips this
			 * guard by design and falls through to the remount below, discarding that
			 * work with no confirmation. This console cannot produce that case on its
			 * own — the drill-in pushes exactly one entry above the list entry, a
			 * filter or tab change replaces rather than pushes, and this guard's own
			 * re-push truncates anything ahead of it — so reaching it would require a
			 * host router pushing its own entry that names this same record. Not
			 * changing the guard to close it; noted here for whoever changes the
			 * navigation around it next.
			 *
			 * A traversal that leaves the DOCUMENT is not covered here — nothing is
			 * delivered to a document being torn down — and is covered by the
			 * `beforeunload` above instead.
			 *
			 * It restores the RECORDED address or it does not act: see
			 * {@link detailHref}. Composing one from where the traversal landed
			 * addresses the wrong page for a record that was never reached by a click.
			 */
			const href = detailHref.current;
			if (unsaved.current && was !== null && href !== null && next !== was) {
				window.history.pushState({ ottaProduct: was }, "", href);
				pushed.current = true;
				setLeavePrompt((n) => n + 1);
				return;
			}
			pushed.current = false;
			setSelected(next);
			setFilter(readProductsFilter(currentSearch()));
			// THE PAGE RIDES THE SAME RESTORE PATH THE FILTER DOES, never a
			// second mechanism: one traversal re-derives the whole address, and the
			// `key={restore}` bump rebuilds the list from all of it at once.
			setCursor(readCursor(currentSearch()));
			setTab(readProductTab(currentSearch()));
			setRestore((n) => n + 1);
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	return (
		<div style={{ padding: 24, maxInlineSize: 1100, textAlign: "start" }}>
			<ConsoleStyles />
			{selected === null ? (
				<ProductsList
					key={restore}
					initialFilter={filter}
					initialCursor={cursor}
					onFilterChange={(next) => {
						// The filter query drops the cursor with the filter it belonged to
						// (see `productsFilterQuery`), so this one write says both things.
						setCursor(undefined);
						replaceQuery(productsFilterQuery(currentSearch(), next));
					}}
					/*
					 * PAGING PUSHES; RETURNING TO PAGE ONE REPLACES — the same rule the
					 * Orders screen states at length. A page is somewhere the merchant
					 * went; being sent back to page one because the address named a page
					 * the service would not open is this screen correcting the entry the
					 * merchant is standing on, not a journey they took.
					 */
					onCursorChange={(next) => {
						setCursor(next);
						const query = cursorQuery(currentSearch(), next);
						if (next === undefined) replaceQuery(query);
						else pushQuery(query);
					}}
					onOpen={(productId) => {
						detailHref.current = pushSelectedProduct(productId);
						pushed.current = true;
						setSelected(productId);
					}}
				/>
			) : (
				<ProductDetail
					key={restore}
					productId={selected}
					initialTab={tab}
					leavePrompt={leavePrompt}
					onTabChange={(index) => {
						detailHref.current = replaceQuery(productTabQuery(currentSearch(), index));
					}}
					onUnsavedChange={(value) => {
						unsaved.current = value;
					}}
					onBack={() => {
						// EVERY route to here is a deliberate departure: the button asks
						// first when there is work to lose, and the guard above asks before
						// a browser Back gets this far. So the guard stands down — leaving
						// it armed would re-arrest the very pop this is about to cause.
						unsaved.current = false;
						const wasPushed = pushed.current;
						popSelectedProduct(wasPushed);
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
