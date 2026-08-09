/**
 * What a second page does to the first (F24), and what the count calls the rows
 * once "Low stock only" is on (F29).
 *
 * NO DOCUMENT HERE ON PURPOSE. Accumulation is a pure function of what is on
 * screen and what just arrived, and it is written as one so the hard part — the
 * merge, and which requests extend versus reset — can be pinned without a
 * render. The seams that genuinely need a live document (the click, the effect
 * that fires the second request, the rows the operator can count) are in
 * `load-more-dom.test.tsx`.
 */
import {
	ACCUMULATED_SUFFIX,
	PRODUCTS_EMPTY,
	PRODUCTS_PAGE_FAILED_TITLE,
	PRODUCTS_LOW_STOCK_NOUN,
	PRODUCTS_LOW_STOCK_NO_MATCH,
	PRODUCTS_NOUN,
	listOutcome,
} from "@otta-sh/admin-presentation";
import { describe, expect, test } from "vitest";
import {
	REFRESHING_LABEL,
	REFRESH_FAILED_TITLE,
	REFRESH_LABEL,
	REFRESH_TITLE,
	continuationCursor,
	mergeById,
	refreshControl,
	refreshWalk,
	refreshedTrail,
	sameFilter,
} from "../src/accumulate.js";
import { nextPage as ordersNextPage, ordersFailureCard } from "../src/orders/orders-list.js";
import {
	failureNotice,
	nextPage as productsNextPage,
	pageAfterFailure,
} from "../src/products/products-list.js";

interface Row {
	readonly id: string;
	readonly label: string;
}

const identify = (row: Row): string => row.id;

const row = (id: string, label = id): Row => ({ id, label });

describe("merging a page into the rows already on screen", () => {
	test("distinct rows APPEND, in arrival order", () => {
		const merged = mergeById([row("a"), row("b")], [row("c"), row("d")], identify);
		expect(merged.map(identify)).toEqual(["a", "b", "c", "d"]);
	});

	test("nothing accumulated yet — the incoming page IS the answer", () => {
		const incoming = [row("a")];
		expect(mergeById([], incoming, identify)).toBe(incoming);
	});

	test("an overlapping id appears ONCE, keeping its place and taking the newer read", () => {
		// The record was edited between the two requests, so page 2 carries it
		// again. Concatenating would render it twice — a duplicate row, and a
		// duplicate React key on top of it.
		const merged = mergeById(
			[row("a", "old a"), row("b", "old b")],
			[row("b", "new b"), row("c", "new c")],
			identify,
		);
		expect(merged.map(identify)).toEqual(["a", "b", "c"]);
		// LAST WRITE WINS ON CONTENT, first arrival wins on POSITION: the row is
		// the same record read more recently, and moving it would reorder the list
		// under an operator mid-scan.
		expect(merged.map((r) => r.label)).toEqual(["old a", "new b", "new c"]);
	});

	test("an overlapping id that arrives MID-PAGE keeps its place, it does not move to the end", () => {
		// THE DISCRIMINATING FIXTURE. With the repeat sitting at the page BOUNDARY —
		// last row of what is on screen, first row of what arrives — "keep the
		// first-arrival position" and "append in incoming order" produce the same
		// array, so a merge obeying only the second passes. Here they disagree: `b`
		// is in the MIDDLE of the accumulated rows, and appending would print
		// `a c b d`, reordering the list under an operator mid-scan.
		const merged = mergeById(
			[row("a", "old a"), row("b", "old b"), row("c", "old c")],
			[row("b", "new b"), row("d", "new d")],
			identify,
		);
		expect(merged.map(identify)).toEqual(["a", "b", "c", "d"]);
		// And the other rule still holds at the same time: the newer read wins on
		// CONTENT while the older read's POSITION is what is kept.
		expect(merged.map((r) => r.label)).toEqual(["old a", "new b", "old c", "new d"]);
	});

	test("a page that names one record twice resolves to its LAST occurrence", () => {
		const merged = mergeById([], [row("a", "first"), row("a", "second")], identify);
		// `mergeById` returns the incoming array untouched when nothing is
		// accumulated, so the de-duplication is asserted where it can act.
		expect(mergeById([row("z")], merged, identify).map((r) => r.label)).toEqual(["z", "second"]);
	});
});

const VOCABULARY = {
	statuses: ["paid"],
	statusAny: "any",
	periods: [{ key: "last30", label: "Last 30 days" }],
	cancellationReasons: [],
	oneClickCancellationReasons: [],
	reconciliationOutcomes: [],
	pageLimit: 25,
} as never;

const ordersPage = (ids: readonly string[], nextCursor: string | null, total?: number) => ({
	orders: ids.map((id) => ({ id })) as never,
	nextCursor,
	total,
	vocabulary: VOCABULARY,
});

describe("which requests EXTEND the list and which RESET it", () => {
	test("a continuation extends, and the count follows the rows", () => {
		const first = ordersNextPage(null, ordersPage(["a", "b"], "cursor-2", 4), "reset");
		expect(first.orders).toHaveLength(2);
		expect(first.pages).toBe(1);

		const second = ordersNextPage(first, ordersPage(["c", "d"], null, 4), "extend");
		expect(second.orders.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
		// The cursor and the total take the NEW page's values...
		expect(second.nextCursor).toBeNull();
		expect(second.total).toBe(4);
		// ...while `firstPage` is inherited: the rows still START at page one, so
		// the count on the last page of the scan may claim the whole set.
		expect(second.firstPage).toBe(true);
		expect(second.pages).toBe(2);
	});

	test("a NON-continuation resets — this is the filter change, and the deep link", () => {
		const first = ordersNextPage(null, ordersPage(["a", "b"], "cursor-2"), "reset");
		const refiltered = ordersNextPage(first, ordersPage(["x"], null), "reset");
		// The previous filter's rows are not the new filter's answer. Extending
		// here is how a filtered list shows rows that do not match it.
		expect(refiltered.orders.map((o) => o.id)).toEqual(["x"]);
		expect(refiltered.pages).toBe(1);
		expect(refiltered.firstPage).toBe(true);
	});

	test("the products list makes the same two calls, keyed on the product id", () => {
		const stock = { threshold: 3, unreadable: false, filterUnavailable: false };
		const productsPage = (ids: readonly string[], nextCursor: string | null) => ({
			products: ids.map((productId) => ({ productId })) as never,
			nextCursor,
			total: undefined,
			stock,
			vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 } as never,
		});
		const first = productsNextPage(null, productsPage(["p1", "p2"], "cursor-2"), "reset");
		const second = productsNextPage(first, productsPage(["p2", "p3"], null), "extend");
		expect(second.products.map((p) => p.productId)).toEqual(["p1", "p2", "p3"]);
		expect(second.pages).toBe(2);
		expect(productsNextPage(second, productsPage(["p9"], null), "reset").products).toHaveLength(1);
	});
});

function productsLoaded() {
	return productsNextPage(
		null,
		{
			products: [{ productId: "p1" }, { productId: "p2" }] as never,
			nextCursor: "cursor-2",
			total: 12,
			stock: { threshold: 3, unreadable: false, filterUnavailable: false },
			vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 } as never,
		},
		"reset",
	);
}

/** Four more low-stock rows, another cursor behind them, and no total — the
 *  case where the service calculated none. */
const PAGE_TWO = {
	products: [
		{ productId: "p3" },
		{ productId: "p4" },
		{ productId: "p5" },
		{ productId: "p6" },
	] as never,
	nextCursor: "cursor-3",
	total: undefined,
	stock: { threshold: 3, unreadable: false, filterUnavailable: false },
	vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 } as never,
};

describe("a total the service never calculated stays ABSENT through a merge", () => {
	test("on both lists — `0` is a count nobody made", () => {
		// A service older than the exact count sends none on either list, and the
		// products list withholds it by design on a page its filter could not be
		// applied to. Coercing that to zero inside the merge is the one place this
		// change could invent a number, and it would then be handed to the count
		// line as fact.
		const firstOrders = ordersNextPage(null, ordersPage(["a"], "cursor-2"), "reset");
		expect(firstOrders.total).toBeUndefined();
		expect(ordersNextPage(firstOrders, ordersPage(["b"], null), "extend").total).toBeUndefined();

		const stock = { threshold: 3, unreadable: false, filterUnavailable: false };
		const productsPage = (ids: readonly string[], nextCursor: string | null) => ({
			products: ids.map((productId) => ({ productId })) as never,
			nextCursor,
			total: undefined,
			stock,
			vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 } as never,
		});
		const firstProducts = productsNextPage(null, productsPage(["p1"], "cursor-2"), "reset");
		expect(firstProducts.total).toBeUndefined();
		expect(
			productsNextPage(firstProducts, productsPage(["p2"], null), "extend").total,
		).toBeUndefined();
	});
});

const stockPage = (
	ids: readonly string[],
	nextCursor: string | null,
	filterUnavailable: boolean,
	total: number | undefined,
) => ({
	products: ids.map((productId) => ({ productId })) as never,
	nextCursor,
	total,
	stock: { threshold: filterUnavailable ? null : 3, unreadable: false, filterUnavailable },
	vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 } as never,
});

describe("`filterUnavailable` LATCHES across a scan, because it describes the rows", () => {
	test("a page one that went out UNFILTERED keeps saying so after a continuation reports false", () => {
		// THE DIRECTION THE PLUGIN CANNOT SEE. Page one's settings read failed, so
		// no predicate was sent and its cursor carries none either — the
		// continuation is unfiltered too. But a continuation's predicate rode
		// inside that opaque cursor, so the plugin always answers `false` for it
		// (`resolveStockContext`'s decision 3). Taking the newest response at face
		// value would drop the banner and caption every product in the catalog as
		// "N low-stock products" at the click of `Load more`.
		const first = productsNextPage(null, stockPage(["p1"], "cursor-2", true, undefined), "reset");
		expect(first.stock.filterUnavailable).toBe(true);
		const second = productsNextPage(first, stockPage(["p2"], null, false, 137), "extend");
		expect(second.stock.filterUnavailable).toBe(true);
		// AND THE TOTAL GOES WITH IT. Not because the rows are a mixture — they
		// were all fetched WITHOUT the predicate — but because 137 is the count of
		// every product while the operator asked for the low-stock ones. Page one
		// withheld its own total on that ground, and honouring this one would jump
		// the caption to a confident exact number under a banner saying the filter
		// was skipped.
		expect(second.total).toBeUndefined();
	});

	test("a scan that was filtered throughout keeps its total and raises nothing", () => {
		// THE CONVERSE, so the latch cannot be satisfied by always answering true.
		const first = productsNextPage(null, stockPage(["p1"], "cursor-2", false, 137), "reset");
		const second = productsNextPage(first, stockPage(["p2"], null, false, 137), "extend");
		expect(second.stock.filterUnavailable).toBe(false);
		expect(second.total).toBe(137);
	});

	test("a RESET drops the latch — a re-applied filter is a new question", () => {
		// `apply()` nulls the cursor, so the next response arrives as a reset and
		// the previous scan's degradation must not outlive it.
		const first = productsNextPage(null, stockPage(["p1"], "cursor-2", true, undefined), "reset");
		const reset = productsNextPage(first, stockPage(["p9"], null, false, 4), "reset");
		expect(reset.stock.filterUnavailable).toBe(false);
		expect(reset.total).toBe(4);
	});
});

describe("a cursor belongs to the filter it was issued under", () => {
	const filter = { status: "paid" };

	test("it is sent while that filter is still applied", () => {
		expect(continuationCursor({ filter, value: "cursor-2" }, filter)).toBe("cursor-2");
	});

	test("a filter change makes it not a continuation of anything", () => {
		// The pair this refuses to form: the NEW filter with the OLD filter's
		// cursor. Sending it merges rows from two different predicates into one
		// list and captions them with a single confident count.
		expect(continuationCursor({ filter, value: "cursor-2" }, { status: "failed" })).toBeUndefined();
		expect(continuationCursor(null, filter)).toBeUndefined();
	});
});

describe("a page that fails BEHIND one that succeeded", () => {
	const loaded = productsLoaded();

	test("keeps every accumulated row, the count AND the cursor", () => {
		const after = pageAfterFailure(loaded, true);
		// Untouched, exactly as on the Orders list: a request that failed behind one
		// that succeeded disproves nothing this page states.
		expect(after).toBe(loaded);
		expect(after?.products).toHaveLength(2);
		expect(after?.total).toBe(12);
		// THE CURSOR IS THE REGRESSION THIS PINS. Nulling it flipped `hasNext`
		// false, which flipped the outcome to a completed scan, which dropped the
		// qualifier off the count — a whole-set claim made while another page is
		// known to be out there. `Load more` is guarded on the failure instead.
		expect(after?.nextCursor).toBe("cursor-2");
	});

	test("a FIRST page that failed still takes the answer with it (F2)", () => {
		const after = pageAfterFailure(loaded, false);
		expect(after?.products).toEqual([]);
		expect(after?.total).toBeUndefined();
		expect(after?.nextCursor).toBeNull();
	});

	test("the count keeps its qualifier while a page is still out there", () => {
		const after = pageAfterFailure(productsNextPage(loaded, PAGE_TWO, "extend"), true);
		expect(
			listOutcome({
				count: after?.products.length ?? 0,
				filtered: true,
				firstPage: after?.firstPage ?? true,
				hasNext: after?.nextCursor != null,
				countScope: "narrowed-after-fetch",
				noun: PRODUCTS_LOW_STOCK_NOUN,
				empty: PRODUCTS_EMPTY,
				noMatch: PRODUCTS_LOW_STOCK_NO_MATCH,
				scopeSuffix: ACCUMULATED_SUFFIX,
			}).countLine,
		).toBe("6 low-stock products loaded so far");
	});

	test("zero rows with a cursor behind them stay a SCAN, not an empty state", () => {
		// The worse half of the same defect. A low-stock page holding no rows used
		// to flip to `Clear filters` when the next page failed — the scan
		// dead-ending, with the only way on a Retry above the fold.
		const emptied = pageAfterFailure({ ...loaded, products: [] }, true);
		expect(
			listOutcome({
				count: emptied?.products.length ?? 0,
				filtered: true,
				firstPage: true,
				hasNext: emptied?.nextCursor != null,
				countScope: "narrowed-after-fetch",
				noun: PRODUCTS_LOW_STOCK_NOUN,
				empty: PRODUCTS_EMPTY,
				noMatch: PRODUCTS_LOW_STOCK_NO_MATCH,
			}).kind,
		).toBe("scan");
	});
});

describe("where a failure is drawn, and what it may claim", () => {
	test("a CONTINUATION failure goes inline, under a title the rows do not disprove", () => {
		const notice = failureNotice({
			title: "Products could not be reached",
			description: "Try again.",
			paging: true,
		});
		// The service's whole-collection refusal is dropped: the rows still on
		// screen are the answer to a request that worked.
		expect(notice?.title).toBe(PRODUCTS_PAGE_FAILED_TITLE);
		expect(notice?.inline).toBe(true);
	});

	test("a cold or stale failure keeps the service's words, at the top", () => {
		const notice = failureNotice({
			title: "Products could not be reached",
			description: "Try again.",
			paging: false,
		});
		expect(notice?.title).toBe("Products could not be reached");
		expect(notice?.inline).toBe(false);
		expect(failureNotice(null)).toBeNull();
	});

	test("a REFRESH that re-read nothing is titled as one, and still keeps its rows", () => {
		// Same survival rules as a page move — inline, rows untouched — because the
		// window on screen was never replaced. Only the name differs, and it has to:
		// the operator pressed Refresh, not Next.
		const products = failureNotice({
			title: "Products could not be reached",
			description: "Try again.",
			paging: true,
			refresh: true,
		});
		expect(products?.title).toBe(REFRESH_FAILED_TITLE);
		expect(products?.inline).toBe(true);

		const orders = ordersFailureCard(
			{
				title: "Orders could not be reached",
				description: "Try again.",
				paging: true,
				refresh: true,
			},
			true,
		);
		expect(orders.title).toBe(REFRESH_FAILED_TITLE);
		expect(orders.kind).toBe("partial");
		expect(orders.answerVisible).toBe(true);
		expect(orders.inline).toBe(true);
	});
});

/**
 * WHAT A REFRESH RE-READS, AND WHAT IT LEAVES OF THE WALK.
 *
 * The window is the pages ON SCREEN — `span` responses ending at the stack's last
 * entry — and the walk re-reads exactly those, anchored where the window opens.
 * These are the arithmetic; what the walk does with the answers is next door in
 * `load-more-dom.test.tsx`, where there is a document to count rows in.
 */
describe("planning a refresh of the window on screen", () => {
	test("a scan built from page one is re-walked FROM page one", () => {
		// Page 1 + two `Load more`: three responses, two cursors behind them.
		const walk = refreshWalk({ cursors: ["c1", "c2"], grounded: true }, 3);
		// No token, because page one is asked for by sending none — and that is
		// what makes its answer authoritative about the whole set.
		expect(walk.anchor).toBeUndefined();
		expect(walk.depth).toBe(3);
		expect(walk.kept).toEqual([]);
		expect(walk.grounded).toBe(true);
	});

	test("a page reached by PAGING re-reads that page alone, and keeps the walk behind it", () => {
		// Three `Next` presses: one page on screen, two cursors behind it.
		const walk = refreshWalk({ cursors: ["c1", "c2"], grounded: true }, 1);
		expect(walk.anchor).toBe("c2");
		expect(walk.depth).toBe(1);
		// EVERYTHING UP TO AND INCLUDING THE ANCHOR SURVIVES: those pages are not
		// being re-read, so their boundaries are not being re-derived, and
		// `Previous` still has somewhere to go.
		expect(walk.kept).toEqual(["c1", "c2"]);
	});

	test("a window opened by a LINK is anchored on that link's page, never on page one", () => {
		// A deep link plus one `Load more`. Walking two pages from page one would
		// land somewhere else entirely and caption it as a refresh of these rows.
		const walk = refreshWalk({ cursors: ["cA", "cB"], grounded: false }, 2);
		expect(walk.anchor).toBe("cA");
		expect(walk.kept).toEqual(["cA"]);
		expect(walk.grounded).toBe(false);
	});

	test("an ungrounded stack is never walked back past its deepest entry", () => {
		// Arithmetic that cannot arise today, clamped rather than trusted: the
		// failure it would cause is silently relocating the operator to page one.
		const walk = refreshWalk({ cursors: ["cA"], grounded: false }, 4);
		expect(walk.anchor).toBe("cA");
		expect(walk.kept).toEqual(["cA"]);
	});

	test("a span below one is one page — a window is never zero responses wide", () => {
		expect(refreshWalk({ cursors: [], grounded: true }, 0).depth).toBe(1);
		expect(refreshWalk({ cursors: [], grounded: true }, Number.NaN).depth).toBe(1);
	});

	test("the walk's own boundaries become the stack, and a SHORT walk a short stack", () => {
		const walk = refreshWalk({ cursors: ["c1", "c2"], grounded: true }, 3);
		// Ran to the end: two fresh boundaries, so three pages and a page number of 3.
		expect(refreshedTrail(walk, ["f1", "f2"])).toEqual({ cursors: ["f1", "f2"], grounded: true });
		// Refused at its third page: two pages re-read, and a stack that says two.
		// A stack still claiming three would number the pages wrongly and offer a
		// `Previous` into a page this list never established.
		expect(refreshedTrail(walk, ["f1"])).toEqual({ cursors: ["f1"], grounded: true });
	});

	test("the pages BELOW the window keep their own cursors", () => {
		const walk = refreshWalk({ cursors: ["c1", "c2", "c3"], grounded: true }, 2);
		expect(walk.anchor).toBe("c2");
		expect(refreshedTrail(walk, ["f3"])).toEqual({ cursors: ["c1", "c2", "f3"], grounded: true });
	});
});

describe("the Refresh control", () => {
	test("says what pressing it costs, before it is pressed", () => {
		const control = refreshControl({ busy: false, refreshing: false });
		expect(control.label).toBe(REFRESH_LABEL);
		expect(control.unavailable).toBe(false);
		expect(control.title).toBe(REFRESH_TITLE);
	});

	test("ANY read in flight makes it unavailable — one at a time, across the screen", () => {
		// A refresh over a pending `Load more` would rebuild the window and then
		// have the older page land on top of it, merged against boundaries that no
		// longer exist.
		expect(refreshControl({ busy: true, refreshing: false }).unavailable).toBe(true);
		expect(refreshControl({ busy: true, refreshing: true }).label).toBe(REFRESHING_LABEL);
	});
});

describe("did the predicate actually move", () => {
	test("the same fields are the same predicate, whoever built the object", () => {
		expect(sameFilter({ status: "paid" }, { status: "paid" })).toBe(true);
		expect(sameFilter({}, {})).toBe(true);
	});

	test("an explicitly absent field is an absent field", () => {
		// A filter seeded from an address and one built by the panel are built by
		// different paths; `{}` and `{ status: undefined }` are one predicate.
		expect(sameFilter({ status: undefined }, {})).toBe(true);
		expect(sameFilter({ status: undefined, search: "x" }, { search: "x" })).toBe(true);
	});

	test("a changed, added or removed field is a different predicate", () => {
		expect(sameFilter({ status: "paid" }, { status: "failed" })).toBe(false);
		expect(sameFilter({ status: "paid" }, { status: "paid", search: "x" })).toBe(false);
		expect(sameFilter({ status: "paid", search: "x" }, { status: "paid" })).toBe(false);
		// `false` is a stated value, not an absence — the low-stock checkbox is the
		// one boolean here, and unchecking it is a real change.
		expect(sameFilter({ lowStock: false }, {})).toBe(false);
	});
});

describe("what the count line calls rows drawn from more than one response", () => {
	const base = {
		filtered: false,
		firstPage: true,
		hasNext: true,
		// "service-filtered": this describe block is about the ACCUMULATED_SUFFIX
		// / firstPage-survives-the-merge mechanics generically, decoupled from
		// whether any one caller narrows a page after fetching it — and the last
		// test below needs the whole-set claim this scope allows on completion.
		countScope: "service-filtered",
		noun: PRODUCTS_NOUN,
		empty: PRODUCTS_EMPTY,
		noMatch: PRODUCTS_LOW_STOCK_NO_MATCH,
	} as const;

	test("one response keeps the shared page-scoped phrasing", () => {
		expect(listOutcome({ ...base, count: 25 }).countLine).toBe("25 products on this page");
	});

	test("two responses say what is true of both", () => {
		expect(listOutcome({ ...base, count: 50, scopeSuffix: ACCUMULATED_SUFFIX }).countLine).toBe(
			"50 products loaded so far",
		);
	});

	test("F29: the count names what it counted", () => {
		// ITS OWN SCOPE, NOT `base`'S: this case models a page-scoped caller, so
		// it states `narrowed-after-fetch` explicitly rather than inheriting
		// `base`'s `service-filtered` — which happens to read the same here only
		// because `base`'s `hasNext: true` keeps `complete` false either way. A
		// caller that inherited the wrong scope by accident is exactly the shape
		// of the defect this file's fix closed.
		expect(
			listOutcome({
				...base,
				count: 3,
				filtered: true,
				countScope: "narrowed-after-fetch",
				noun: PRODUCTS_LOW_STOCK_NOUN,
			}).countLine,
		).toBe("3 low-stock products on this page");
		expect(
			listOutcome({
				...base,
				count: 1,
				filtered: true,
				countScope: "narrowed-after-fetch",
				noun: PRODUCTS_LOW_STOCK_NOUN,
			}).countLine,
		).toBe("1 low-stock product on this page");
	});

	test("a completed scan claims the whole set, suffix or not", () => {
		// Pages one and two, with nothing behind them: `firstPage` survived the
		// merge, so the render has standing to count the collection.
		expect(
			listOutcome({ ...base, count: 40, hasNext: false, scopeSuffix: ACCUMULATED_SUFFIX })
				.countLine,
		).toBe("40 products");
	});
});
