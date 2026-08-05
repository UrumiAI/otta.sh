/**
 * What a second page does to the first (F24), and what the count calls the rows
 * once the narrowing is on (F29).
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
	PRODUCTS_LOAD_MORE_FAILED_TITLE,
	PRODUCTS_LOW_STOCK_NOUN,
	PRODUCTS_LOW_STOCK_NO_MATCH,
	PRODUCTS_NOUN,
	listOutcome,
} from "@otta-sh/admin-presentation";
import { describe, expect, test } from "vitest";
import { continuationCursor, mergeById } from "../src/accumulate.js";
import { nextPage as ordersNextPage } from "../src/orders/orders-list.js";
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
		const first = ordersNextPage(null, ordersPage(["a", "b"], "cursor-2", 4), false);
		expect(first.orders).toHaveLength(2);
		expect(first.pages).toBe(1);

		const second = ordersNextPage(first, ordersPage(["c", "d"], null, 4), true);
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
		const first = ordersNextPage(null, ordersPage(["a", "b"], "cursor-2"), false);
		const refiltered = ordersNextPage(first, ordersPage(["x"], null), false);
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
		const first = productsNextPage(null, productsPage(["p1", "p2"], "cursor-2"), false);
		const second = productsNextPage(first, productsPage(["p2", "p3"], null), true);
		expect(second.products.map((p) => p.productId)).toEqual(["p1", "p2", "p3"]);
		expect(second.pages).toBe(2);
		expect(productsNextPage(second, productsPage(["p9"], null), false).products).toHaveLength(1);
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
		false,
	);
}

/** Four more low-stock rows, another cursor behind them, and the total the
 *  narrowing withholds. */
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
		// The narrowing withholds the total on the products list by design, and a
		// service older than the exact count sends none on either. Coercing that to
		// zero inside the merge is the one place this change could invent a number,
		// and it would then be handed to the count line as fact.
		const firstOrders = ordersNextPage(null, ordersPage(["a"], "cursor-2"), false);
		expect(firstOrders.total).toBeUndefined();
		expect(ordersNextPage(firstOrders, ordersPage(["b"], null), true).total).toBeUndefined();

		const stock = { threshold: 3, unreadable: false, filterUnavailable: false };
		const productsPage = (ids: readonly string[], nextCursor: string | null) => ({
			products: ids.map((productId) => ({ productId })) as never,
			nextCursor,
			total: undefined,
			stock,
			vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 } as never,
		});
		const firstProducts = productsNextPage(null, productsPage(["p1"], "cursor-2"), false);
		expect(firstProducts.total).toBeUndefined();
		expect(productsNextPage(firstProducts, productsPage(["p2"], null), true).total).toBeUndefined();
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
		const after = pageAfterFailure(productsNextPage(loaded, PAGE_TWO, true), true);
		expect(
			listOutcome({
				count: after?.products.length ?? 0,
				filtered: true,
				firstPage: after?.firstPage ?? true,
				hasNext: after?.nextCursor != null,
				noun: PRODUCTS_LOW_STOCK_NOUN,
				empty: PRODUCTS_EMPTY,
				noMatch: PRODUCTS_LOW_STOCK_NO_MATCH,
				scopeSuffix: ACCUMULATED_SUFFIX,
			}).countLine,
		).toBe("6 low-stock products loaded so far");
	});

	test("zero rows with a cursor behind them stay a SCAN, not an empty state", () => {
		// The worse half of the same defect. A low-stock page that narrowed to
		// nothing used to flip to `Clear filters` when the next page failed — the
		// scan dead-ending, with the only way on a Retry above the fold.
		const emptied = pageAfterFailure({ ...loaded, products: [] }, true);
		expect(
			listOutcome({
				count: emptied?.products.length ?? 0,
				filtered: true,
				firstPage: true,
				hasNext: emptied?.nextCursor != null,
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
			continuation: true,
		});
		// The service's whole-collection refusal is dropped: the rows still on
		// screen are the answer to a request that worked.
		expect(notice?.title).toBe(PRODUCTS_LOAD_MORE_FAILED_TITLE);
		expect(notice?.inline).toBe(true);
	});

	test("a cold or stale failure keeps the service's words, at the top", () => {
		const notice = failureNotice({
			title: "Products could not be reached",
			description: "Try again.",
			continuation: false,
		});
		expect(notice?.title).toBe("Products could not be reached");
		expect(notice?.inline).toBe(false);
		expect(failureNotice(null)).toBeNull();
	});
});

describe("what the count line calls rows drawn from more than one response", () => {
	const base = {
		filtered: false,
		firstPage: true,
		hasNext: true,
		noun: PRODUCTS_NOUN,
		empty: PRODUCTS_EMPTY,
		noMatch: PRODUCTS_LOW_STOCK_NO_MATCH,
	};

	test("one response keeps the shared page-scoped phrasing", () => {
		expect(listOutcome({ ...base, count: 25 }).countLine).toBe("25 products on this page");
	});

	test("two responses say what is true of both", () => {
		expect(listOutcome({ ...base, count: 50, scopeSuffix: ACCUMULATED_SUFFIX }).countLine).toBe(
			"50 products loaded so far",
		);
	});

	test("F29: the narrowing names what it counted", () => {
		expect(
			listOutcome({ ...base, count: 3, filtered: true, noun: PRODUCTS_LOW_STOCK_NOUN }).countLine,
		).toBe("3 low-stock products on this page");
		expect(
			listOutcome({ ...base, count: 1, filtered: true, noun: PRODUCTS_LOW_STOCK_NOUN }).countLine,
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
