/**
 * @vitest-environment happy-dom
 *
 * `Load more` counted in rendered rows (F24), and the low-stock scan saying what
 * it is (F29).
 *
 * WHY A DOCUMENT IS THE RIGHT TIER FOR THIS. The merge itself is pure and is
 * pinned next door; what a pure test cannot see is the part that was actually
 * broken — the effect that fires the second request and the state it writes the
 * response into. The defect was one assignment inside that effect, invisible to
 * every test that called the exported helpers directly, and visible immediately
 * to anything that counts `<tr>` elements before and after a click.
 *
 * EVERY RESPONSE IS SERVED HERE, successes included, so a failure is a
 * transition this file chooses rather than an environment it has to arrange.
 */
import { PRODUCTS_PAGE_FAILED_TITLE } from "@otta-sh/admin-presentation";
import {
	REFRESH_BUSY_TITLE,
	REFRESH_HALTED_TITLE,
	REFRESH_FAILED_TITLE,
	REFRESH_STOPPED_TITLE,
	REFRESH_UNCHANGED_NOTE,
} from "../src/accumulate.js";
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrdersList } = await import("../src/orders/orders-list.js");
const { OrdersScreen } = await import("../src/orders/orders-screen.js");
const { ProductsList } = await import("../src/products/products-list.js");

const VOCABULARY = {
	statuses: ["paid", "failed"],
	statusAny: "any",
	periods: [{ key: "last30", label: "Last 30 days" }],
	cancellationReasons: [],
	oneClickCancellationReasons: [],
	reconciliationOutcomes: [],
	pageLimit: 20,
};

const PRODUCTS_VOCABULARY = {
	statuses: [{ value: "any", label: "Any status" }],
	kinds: [{ value: "any", label: "Any kind" }],
	any: "any",
	pageLimit: 20,
};

function order(id: string, customer: string) {
	return {
		id,
		state: "paid",
		currency: "USD",
		buyerRef: `buyer-${id}`,
		customerId: customer,
		paymentMethod: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		totalCents: 1234,
		reconciliationFlag: null,
	};
}

function product(productId: string) {
	return {
		productId,
		sku: `SKU-${productId}`,
		title: `Product ${productId}`,
		priceCents: 900,
		currency: "USD",
		productKind: "physical",
		active: true,
		deletedAt: null,
		onHand: 1,
	};
}

function ids(prefix: string, from: number, to: number): string[] {
	const out: string[] = [];
	for (let n = from; n <= to; n += 1) out.push(`${prefix}-${String(n)}`);
	return out;
}

function envelope(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

interface Request {
	readonly resource?: string;
	readonly cursor?: string;
	readonly filter?: {
		readonly status?: string;
		readonly lowStock?: boolean;
		readonly search?: string;
	};
}

function requestOf(init: RequestInit | undefined): Request {
	return JSON.parse(String(init?.body ?? "{}")) as Request;
}

/** Every request this run has been asked, so a reset can be told from an
 *  extension by what went on the wire as well as by what came back. */
let asked: Request[] = [];

function serve(handler: (request: Request) => Response): void {
	apiFetch.mockImplementation((_input, init) => {
		const request = requestOf(init);
		asked.push(request);
		return Promise.resolve(handler(request));
	});
}

/** Two pages of orders, the second reachable only with the first's cursor. */
function servePages(options: { failPageTwo?: boolean; overlap?: boolean } = {}): void {
	serve((request) => {
		if (request.cursor === undefined) {
			return envelope({
				ok: true,
				orders: ids("o", 1, 20).map((id) => order(id, `Customer ${id}`)),
				nextCursor: "cursor-2",
				vocabulary: VOCABULARY,
			});
		}
		if (options.failPageTwo === true) {
			return envelope({
				ok: false,
				title: "The next page could not be read",
				description: "Try again.",
			});
		}
		const second = options.overlap === true ? ids("o", 20, 39) : ids("o", 21, 40);
		return envelope({
			ok: true,
			orders: second.map((id) => order(id, `Customer ${id}`)),
			nextCursor: "cursor-3",
			vocabulary: VOCABULARY,
		});
	});
}

/**
 * Pages of products under "Low stock only" — deliberately the flagship path,
 * because it is the one where the service WITHHOLDS the total, so the count line
 * is the render's own claim about its own rows and a lost qualifier is a false
 * statement rather than a cosmetic one.
 *
 * `failFrom` is the page number from which the service refuses, so "page 1
 * succeeded and page 2 failed" is `failFrom: 2` and needs no handler flipping.
 */
function serveProductPages(
	options: { failFrom?: number; overlap?: boolean; emptyFirstPage?: boolean } = {},
): void {
	serve((request) => {
		const n = request.cursor === undefined ? 1 : Number(request.cursor.slice("cursor-".length));
		if (options.failFrom !== undefined && n >= options.failFrom) {
			return envelope({
				ok: false,
				// The service always answers a WHOLE-COLLECTION refusal; what the
				// screen is entitled to repeat from it is the point of these tests.
				title: "Products could not be reached",
				description: "Try again in a moment.",
			});
		}
		const page =
			options.emptyFirstPage === true && n === 1
				? []
				: // The repeat sits in the MIDDLE of page 1, where "keep the
					// first-arrival position" and "append in incoming order" disagree.
					options.overlap === true && n === 2
					? ["p-2", "p-4", "p-5"]
					: ids("p", n * 3 - 2, n * 3);
		return envelope({
			ok: true,
			products: page.map(product),
			nextCursor: `cursor-${String(n + 1)}`,
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: PRODUCTS_VOCABULARY,
		});
	});
}

/** Retype a controlled field the way a merchant would, through the setter React
 *  tracks rather than the property the component would not see move. */
function retype(field: HTMLInputElement | HTMLSelectElement, value: string): void {
	const proto = field instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
	Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(field, value);
	field.dispatchEvent(
		new Event(field instanceof HTMLSelectElement ? "change" : "input", {
			bubbles: true,
		}),
	);
}

function element(view: Mounted, testId: string): HTMLElement {
	const found = view.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (found === null) throw new Error(`no ${testId} on the screen`);
	return found;
}

function absent(view: Mounted, testId: string): boolean {
	return view.container.querySelector(`[data-testid="${testId}"]`) === null;
}

function rows(view: Mounted, testId: string): HTMLElement[] {
	return [...view.container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
}

function rowIds(view: Mounted, testId: string): (string | null)[] {
	return rows(view, testId).map((tr) => tr.getAttribute("data-row-id"));
}

function text(view: Mounted, testId: string): string {
	return view.container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

function press(view: Mounted, testId: string): Promise<void> {
	const button = view.container.querySelector(`[data-testid="${testId}"]`);
	if (button === null) throw new Error(`no ${testId} on the screen`);
	return fire(button, "click");
}

/** Settle the request the last interaction issued. */
async function settle(): Promise<void> {
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

let view: Mounted | undefined;

beforeEach(() => {
	asked = [];
	apiFetch.mockReset();
	window.history.replaceState(null, "", "/orders");
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
});

test("a healthy Load more APPENDS — 20 rows become 40, and the first 20 are the same rows", async () => {
	servePages();
	view = await mount(<OrdersList onOpen={() => {}} />);
	await settle();
	const first = rowIds(view, "orders-row");
	expect(first).toHaveLength(20);
	// The count line is the rendered rows, not the payload's opinion of them.
	expect(text(view, "orders-intro")).toContain("20 orders on this page");

	await press(view, "orders-load-more");
	await settle();
	const both = rowIds(view, "orders-row");
	expect(both).toHaveLength(40);
	expect(both.slice(0, 20)).toEqual(first);
	// F24's deliberate divergence: rows from two responses are not "on this page".
	expect(text(view, "orders-intro")).toContain("40 orders loaded so far");
});

test("Retry after a failed page 2 APPENDS to the rows already accumulated", async () => {
	servePages({ failPageTwo: true });
	view = await mount(<OrdersList onOpen={() => {}} />);
	await settle();
	expect(rows(view, "orders-row")).toHaveLength(20);

	await press(view, "orders-load-more");
	await settle();
	// The partial-failure state: the accumulated rows and their count stand, and
	// the error is where `Load more` was.
	expect(rows(view, "orders-row")).toHaveLength(20);
	expect(text(view, "orders-intro")).toContain("20 orders on this page");
	expect(view.container.querySelector('[data-testid="orders-load-more-failure"]')).not.toBeNull();

	servePages();
	await press(view, "orders-load-more-failure-action");
	await settle();
	// THE ACCEPTANCE CRITERION: Retry adds to what survived rather than
	// replacing it.
	const both = rowIds(view, "orders-row");
	expect(both).toHaveLength(40);
	expect(both[0]).toBe("o-1");
	expect(text(view, "orders-intro")).toContain("40 orders loaded so far");
});

test("an id on BOTH pages renders once, and the count agrees with the rows", async () => {
	servePages({ overlap: true });
	view = await mount(<OrdersList onOpen={() => {}} />);
	await settle();
	await press(view, "orders-load-more");
	await settle();
	const both = rowIds(view, "orders-row");
	// 20 + 20 with `o-20` on both pages: 39 rows, not 40, and no duplicate.
	expect(both).toHaveLength(39);
	expect(new Set(both).size).toBe(39);
	expect(both.filter((id) => id === "o-20")).toHaveLength(1);
	expect(text(view, "orders-intro")).toContain("39 orders loaded so far");
});

test("a filter change RESETS accumulation to page 1 of the new filter", async () => {
	servePages();
	view = await mount(<OrdersList onOpen={() => {}} />);
	await settle();
	await press(view, "orders-load-more");
	await settle();
	expect(rows(view, "orders-row")).toHaveLength(40);

	const select = view.container.querySelector<HTMLSelectElement>('[data-testid="filter-status"]');
	if (select === null) throw new Error("no status filter");
	await React.act(async () => {
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
			select,
			"failed",
		);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await press(view, "apply-filters");
	await settle();

	// The re-query goes out WITHOUT a cursor — an extension here would show the
	// previous filter's rows under the new filter.
	expect(asked.at(-1)?.cursor).toBeUndefined();
	expect(asked.at(-1)?.filter?.status).toBe("failed");
	expect(rows(view, "orders-row")).toHaveLength(20);
	expect(text(view, "orders-intro")).toContain("20 orders on this page");
});

test("a deep-linked filtered URL starts a FRESH accumulation, and Back restarts one", async () => {
	servePages();
	window.history.replaceState(null, "", "/orders?status=paid");
	view = await mount(<OrdersScreen />);
	await settle();
	// Seeded from the address, and asked for as a first page.
	expect(asked[0]?.filter?.status).toBe("paid");
	expect(asked[0]?.cursor).toBeUndefined();
	expect(rows(view, "orders-row")).toHaveLength(20);

	await press(view, "orders-load-more");
	await settle();
	expect(rows(view, "orders-row")).toHaveLength(40);

	// A traversal is the one moment the address knows something the mounted list
	// does not, so the screen rebuilds the list from it — and the rebuilt list
	// starts at whatever page the address now names. Accumulated pages are NOT
	// restored: the address carries ONE page's cursor, never the stack of
	// pages a scan walked through.
	//
	// A REAL Back, not a hand-dispatched `popstate`. Now that `Load more` pushes
	// the page it moved to, dispatching the event alone would re-derive the
	// address the click just wrote — page two — and assert the opposite of what
	// this test is about. This lands on the entry BEFORE that push: the filtered
	// list, at page one.
	await React.act(async () => {
		window.history.back();
		await new Promise((resolve) => setTimeout(resolve, 25));
	});
	await settle();
	expect(asked.at(-1)?.cursor).toBeUndefined();
	expect(rows(view, "orders-row")).toHaveLength(20);
	expect(text(view, "orders-intro")).toContain("20 orders on this page");
});

test("F29: the count names what it counted, on a genuinely low-stock-filtered page", async () => {
	serve((request) =>
		envelope({
			ok: true,
			products: (request.cursor === undefined ? ids("p", 1, 3) : ids("p", 4, 5)).map(product),
			nextCursor: request.cursor === undefined ? "cursor-2" : "cursor-3",
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: PRODUCTS_VOCABULARY,
		}),
	);
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	expect(text(view, "products-intro")).toContain("3 low-stock products on this page");
	// No paging note beside `Load more`: the predicate is the SERVICE's now, so
	// `Load more` really does fetch the next page of the filtered set rather
	// than re-scanning for matches, and there is nothing left to caveat.
	expect(absent(view, "products-low-stock-paging-note")).toBe(true);

	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(5);
	expect(text(view, "products-intro")).toContain("5 low-stock products loaded so far");
});

test("a genuinely low-stock-filtered catalog that fits on ONE page is COMPLETE, not page-scoped", async () => {
	// THE OLD DEFECT THIS PINNED, INVERTED. "Low stock only" used to have no
	// service predicate — it kept the low-stock rows out of whatever RAW page
	// was fetched — so `nextCursor: null` on the first response proved only
	// that the raw fetch stopped there, never that every low-stock row in the
	// catalog was on screen, and `countScope: "narrowed-after-fetch"` refused
	// to read it as complete for exactly that reason. The predicate is the
	// SERVICE's now: a first page with no next cursor is drawn from a query
	// that already applied the threshold, so `firstPage && !hasNext` really
	// does mean the whole filtered set is on screen — the same claim any other
	// `service-filtered` list on this screen is entitled to make, which is why
	// `countScope` is unconditional now.
	serve(() =>
		envelope({
			ok: true,
			products: ids("p", 1, 3).map(product),
			nextCursor: null,
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: PRODUCTS_VOCABULARY,
		}),
	);
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	expect(rows(view, "products-row")).toHaveLength(3);
	// WHOLE-SET PHRASING — the fetch really is the entire low-stock set, so the
	// page-scoped qualifier no longer applies.
	expect(text(view, "products-intro")).toContain("3 low-stock products");
	expect(text(view, "products-intro")).not.toContain("on this page");
	// No `Load more`, because there really is nothing left to fetch, and no
	// paging note — that affordance described a mechanism this screen no
	// longer has.
	expect(absent(view, "products-load-more")).toBe(true);
	expect(absent(view, "products-low-stock-paging-note")).toBe(true);
});

test("an accumulated fetch that exhausts the catalog DROPS 'loaded so far' once it is provably complete", async () => {
	// THE HALF THE F29 TEST (ABOVE) NEVER REACHES: its second response always
	// carries a non-null `nextCursor`, so `hasNext` never goes false once pages
	// accumulate. Here a scan runs three responses deep and the THIRD exhausts
	// the catalog — `firstPage` stays true throughout (the render started at
	// page one), so `complete = firstPage && !hasNext` goes true on exactly
	// this response.
	//
	// THAT IS NOW CORRECT, where it once was the defect: the predicate is the
	// SERVICE's, so a keyset scan that runs out of matching rows has PROVEN the
	// four accumulated rows are the entire low-stock set, not merely "what a
	// client-side narrowing happened to keep before the raw fetch stopped".
	// Continuing to hedge with "loaded so far" past that proof would be the
	// less honest sentence, not the safer one.
	let call = 0;
	serve(() => {
		call += 1;
		const page =
			call === 1
				? { products: ids("p", 1, 2), nextCursor: "cursor-2" }
				: call === 2
					? { products: ids("p", 3, 3), nextCursor: "cursor-3" }
					: { products: ids("p", 4, 4), nextCursor: null };
		return envelope({
			ok: true,
			products: page.products.map(product),
			nextCursor: page.nextCursor,
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: PRODUCTS_VOCABULARY,
		});
	});
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	expect(rows(view, "products-row")).toHaveLength(2);

	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(3);
	// STILL HEDGED — there is provably another page out there (`hasNext` is
	// true), so the accumulated count cannot yet claim completeness.
	expect(text(view, "products-intro")).toContain("3 low-stock products loaded so far");

	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(4);
	// THE SCAN RAN OUT OF CATALOG ON ITS THIRD REQUEST — a fact the query
	// proved, not a coincidence of where the client happened to stop — so the
	// count drops the qualifier and states the whole low-stock set plainly.
	expect(text(view, "products-intro")).toContain("4 low-stock products");
	expect(text(view, "products-intro")).not.toContain("loaded so far");
	expect(absent(view, "products-load-more")).toBe(true);
});

test("a filterUnavailable page keeps the SERVICE'S noun, and states no total the plugin did not send", async () => {
	// END TO END: the operator checked "Low stock only", but the plugin could
	// not read the threshold this time (`stock.filterUnavailable`) — the
	// outgoing request never carried a predicate, so every product on the page
	// is listed under the ORDINARY noun, and the plugin withholds any `total`
	// it might otherwise have forwarded (`resolveStockContext`: a `total` here
	// would caption an UNFILTERED page as though "Low stock only" had been
	// honoured). Reading `narrowed` off the checkbox alone would render
	// "low-stock products" for rows that are every product, directly above the
	// banner already saying the filter was not applied.
	serve(() =>
		envelope({
			ok: true,
			products: ids("p", 1, 5).map(product),
			nextCursor: "cursor-2",
			// NO `total` — see above. The wire never carries one on this scope.
			stock: { threshold: null, unreadable: false, filterUnavailable: true },
			vocabulary: PRODUCTS_VOCABULARY,
		}),
	);
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	expect(rows(view, "products-row")).toHaveLength(5);
	// THE ORDINARY NOUN, page-scoped — an unfiltered page with more behind it,
	// entitled to nothing stronger than the rows it can back up on its own.
	expect(text(view, "products-intro")).toContain("5 products on this page");
	expect(text(view, "products-intro")).not.toContain("low-stock");
	expect(text(view, "products-stock-degraded")).toContain(
		"the Low stock only filter was not applied",
	);
});

/**
 * THE PRODUCTS LIST GETS THE SAME TREATMENT AS ORDERS, and not as a courtesy.
 * F24 gave it the same accumulated-pages state, so it inherits that state's
 * design; the tests below are where the two screens' behaviour is held level.
 */

test("a healthy Load more APPENDS on the products list — 3 rows become 6", async () => {
	serveProductPages();
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	const first = rowIds(view, "products-row");
	expect(first).toHaveLength(3);

	await press(view, "products-load-more");
	await settle();
	const both = rowIds(view, "products-row");
	expect(both).toHaveLength(6);
	expect(both.slice(0, 3)).toEqual(first);
	expect(text(view, "products-intro")).toContain("6 low-stock products loaded so far");
});

test("a continuation failure on the products list keeps the rows, the cursor's claim AND the qualifier", async () => {
	// Two pages land, then the third is refused: the state in which the count line
	// used to drop its qualifier and claim the catalog.
	serveProductPages({ failFrom: 3 });
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(6);

	await press(view, "products-load-more");
	await settle();

	// EVERY ROW STANDS — a request that failed behind two that succeeded
	// disproves none of them.
	expect(rows(view, "products-row")).toHaveLength(6);
	// AND SO DOES THE QUALIFIER. This is the false whole-set claim: destroying the
	// cursor flipped `hasNext` false, which flipped the outcome to a completed
	// scan, which turned this line into a bare "6 low-stock products".
	expect(text(view, "products-intro")).toContain("6 low-stock products loaded so far");
	expect(text(view, "products-intro")).not.toContain("6 low-stock products ·");

	// INLINE, WHERE THE CONTROL WAS, exactly as on Orders — and under a title the
	// rows on screen do not disprove, rather than the service's whole-collection
	// refusal carried to the top of the screen above them.
	expect(text(view, "products-load-more-failure")).toContain(PRODUCTS_PAGE_FAILED_TITLE);
	expect(text(view, "products-load-more-failure")).not.toContain("Products could not be reached");
	expect(absent(view, "products-failure")).toBe(true);
	// The offer that just failed is not made twice.
	expect(absent(view, "products-load-more")).toBe(true);
});

test("a products page narrowed to nothing under a failed continuation stays a SCAN", async () => {
	// The worse half of the same defect: with the cursor destroyed, this flipped
	// to an empty state offering `Clear filters`, and the scan dead-ended.
	serveProductPages({ emptyFirstPage: true, failFrom: 2 });
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	expect(rows(view, "products-row")).toHaveLength(0);
	expect(text(view, "products-scan-note").length).toBeGreaterThan(0);

	await press(view, "products-load-more");
	await settle();
	// Still a scan with somewhere left to go, and the way on is the Retry that
	// replaced the button rather than one the merchant must scroll up to find.
	expect(text(view, "products-scan-note").length).toBeGreaterThan(0);
	expect(absent(view, "products-no-match")).toBe(true);
	expect(absent(view, "products-page-zero")).toBe(true);
	expect(absent(view, "products-load-more-failure")).toBe(false);
});

test("Retry after a failed page 2 APPENDS on the products list", async () => {
	// THE WRITTEN ACCEPTANCE CRITERION, on the screen that had no coverage of it.
	serveProductPages({ failFrom: 2 });
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	const first = rowIds(view, "products-row");
	expect(first).toHaveLength(3);

	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(3);

	serveProductPages();
	await press(view, "products-load-more-failure-action");
	await settle();
	const both = rowIds(view, "products-row");
	expect(both).toHaveLength(6);
	expect(both.slice(0, 3)).toEqual(first);
	expect(text(view, "products-intro")).toContain("6 low-stock products loaded so far");
});

test("an id repeated in the MIDDLE of an earlier products page renders once, in its place", async () => {
	serveProductPages({ overlap: true });
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	await press(view, "products-load-more");
	await settle();
	const both = rowIds(view, "products-row");
	// p-2 arrives again on page 2, from the middle of page 1. Appending in
	// incoming order would print p-1, p-3, p-2, p-4, p-5.
	expect(both).toEqual(["p-1", "p-2", "p-3", "p-4", "p-5"]);
	expect(both.filter((id) => id === "p-2")).toHaveLength(1);
	expect(text(view, "products-intro")).toContain("5 low-stock products loaded so far");
});

test("a filter change RESETS accumulation on the products list", async () => {
	serveProductPages();
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(6);

	await React.act(async () => {
		retype(element(view as Mounted, "filter-search") as HTMLInputElement, "widget");
	});
	await press(view, "apply-filters");
	await settle();

	expect(asked.at(-1)?.cursor).toBeUndefined();
	expect(asked.at(-1)?.filter?.search).toBe("widget");
	expect(rows(view, "products-row")).toHaveLength(3);
	expect(text(view, "products-intro")).toContain("3 low-stock products on this page");
});

/**
 * A FILTER CHANGE AND A STALE `Load more`, IN ONE COMMIT.
 *
 * Both lists used to raise `busy` inside the effect rather than in the click
 * that applies a filter, leaving one commit in which the applied filter had
 * already moved and `Load more` still rendered enabled over the previous page's
 * cursor. A click landing there sent the NEW filter with the OLD cursor as a
 * continuation, and the rows of two different predicates merged into one list
 * under a single confident count.
 *
 * DISPATCHING BOTH IN ONE REACT BATCH IS THAT COMMIT, made deterministic: the
 * two handlers run against the render they were drawn from, before any re-render
 * can withdraw the control. Human reachability was never the point — the
 * invariant is "a filter change resets accumulation, full stop", and it has to
 * hold under an interleaving rather than because one is unlikely.
 */
test("orders: a filter change and a stale Load more in one batch cannot pair up", async () => {
	servePages();
	view = await mount(<OrdersList onOpen={() => {}} />);
	await settle();
	await press(view, "orders-load-more");
	await settle();
	expect(rows(view, "orders-row")).toHaveLength(40);

	const applyNow = element(view, "apply-filters");
	const loadMore = element(view, "orders-load-more");
	await React.act(async () => {
		retype(element(view as Mounted, "filter-status") as HTMLSelectElement, "failed");
	});
	await React.act(async () => {
		applyNow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		loadMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await settle();

	// The request that went out is the new filter's FIRST page. A cursor here is
	// the defect: it belongs to the filter that was applied before this one.
	expect(asked.at(-1)?.filter?.status).toBe("failed");
	expect(asked.at(-1)?.cursor).toBeUndefined();
	// And nothing merged across the two filters — 20 rows, not 60, and a count
	// line that says what it can back up.
	expect(rows(view, "orders-row")).toHaveLength(20);
	expect(text(view, "orders-intro")).toContain("20 orders on this page");
});

test("products: a filter change and a stale Load more in one batch cannot pair up", async () => {
	serveProductPages();
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(6);

	const applyNow = element(view, "apply-filters");
	const loadMore = element(view, "products-load-more");
	await React.act(async () => {
		retype(element(view as Mounted, "filter-search") as HTMLInputElement, "widget");
	});
	await React.act(async () => {
		applyNow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		loadMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await settle();

	expect(asked.at(-1)?.filter?.search).toBe("widget");
	expect(asked.at(-1)?.cursor).toBeUndefined();
	expect(rows(view, "products-row")).toHaveLength(3);
	expect(text(view, "products-intro")).toContain("3 low-stock products on this page");
});

/**
 * THE SHORT ID IS COMPUTED OVER THE ROWS ON SCREEN, and once those accumulate,
 * the set it is unique against grows under it.
 *
 * That is correct — a prefix computed over a subset is unique against the wrong
 * population and can collide on screen, which is the one failure §1.3's rule
 * exists to prevent. But it is a VISIBLE change to an earlier increment's
 * surface: a row an operator has already read can lengthen its own id when the
 * next page arrives carrying a colliding one. It is worth one test so the
 * behaviour is a decision on the record rather than a surprise.
 */
test("a colliding id on page 2 lengthens the prefix a page-1 row already showed", async () => {
	const ORIGINAL = "abcd0000-0000-4000-8000-000000000001";
	const COLLIDING = "abcd9999-0000-4000-8000-000000000002";
	serve((request) =>
		envelope({
			ok: true,
			orders: (request.cursor === undefined
				? [ORIGINAL, "efab1111-0000-4000-8000-000000000003"]
				: [COLLIDING]
			).map((id) => order(id, `Customer ${id.slice(0, 4)}`)),
			nextCursor: request.cursor === undefined ? "cursor-2" : null,
			vocabulary: VOCABULARY,
		}),
	);
	view = await mount(<OrdersList onOpen={() => {}} />);
	await settle();
	const link = (id: string): HTMLElement | null =>
		view?.container.querySelector<HTMLElement>(`[data-order-id="${id}"]`) ?? null;
	// Unique among the two rows on screen at the floor length.
	expect(link(ORIGINAL)?.textContent).toBe("abcd");

	await press(view, "orders-load-more");
	await settle();
	// The colliding id arrives, and BOTH extend by exactly the one character that
	// separates them. The full id on the row never moved.
	expect(link(ORIGINAL)?.textContent).toBe("abcd0");
	expect(link(COLLIDING)?.textContent).toBe("abcd9");
	expect(link(ORIGINAL)?.getAttribute("href")).toBe(`?order=${encodeURIComponent(ORIGINAL)}`);
});

/**
 * WHAT `Refresh` DOES TO A SCAN THAT HAS ACCUMULATED — the act correction 03
 * found missing.
 *
 * WHY A DOCUMENT. The arithmetic of the walk is pure and pinned next door; what
 * only a live mount can show is the part that was actually absent — the requests
 * that go out, in order, and the rows that are on screen when they have all come
 * back. Every claim below is counted in rendered rows or read off the wire.
 *
 * THE SERVICE HERE IS MUTABLE ON PURPOSE. A refresh that cannot be told from a
 * re-render is a refresh that proves nothing, so the collection is edited between
 * the scan and the click: a row is deleted, and another's customer changes.
 */
const CATALOG_PAGE = 2;

/** The collection the fixture service is currently serving. */
let catalog: { id: string; buyerRef: string }[] = [];
/** Requests to answer normally before the service starts refusing — `null` never
 *  refuses. Set immediately before the act under test. */
let refuseAfter: number | null = null;
/** The same, for the refusal the plugin recovers from by re-issuing page one. */
let rejectAfter: number | null = null;
let served = 0;
let issuedCursors = 0;

function stockCatalog(size: number): void {
	catalog = ids("o", 1, size).map((id) => ({ id, buyerRef: `buyer-${id}` }));
	refuseAfter = null;
	rejectAfter = null;
	served = 0;
	issuedCursors = 0;
}

/** Answer normally for `n` more requests, then refuse. */
function refuseAfterRequests(n: number): void {
	served = 0;
	refuseAfter = n;
}

/** Answer normally for `n` more requests, then answer page one with the flag the
 *  plugin's client sets when the service refused the token it sent. */
function rejectAfterRequests(n: number): void {
	served = 0;
	rejectAfter = n;
}

/**
 * A tiny keyset service over {@link catalog}, paged at two.
 *
 * EVERY CURSOR IT ISSUES IS UNIQUE, even for the same position, which is what
 * lets the wire log prove the walk FOLLOWED the fresh boundaries rather than
 * replaying the ones the scan was built with.
 */
function serveCatalog(): void {
	serve((request) => {
		served += 1;
		if (refuseAfter !== null && served > refuseAfter) {
			return envelope({
				ok: false,
				title: "Orders could not be reached",
				description: "Try again in a moment.",
			});
		}
		const rejected = rejectAfter !== null && served > rejectAfter;
		const start =
			rejected || request.cursor === undefined ? 0 : Number(request.cursor.split("-")[1]);
		const window = catalog.slice(start, start + CATALOG_PAGE);
		const end = start + window.length;
		issuedCursors += 1;
		return envelope({
			ok: true,
			...(rejected ? { cursorRejected: true } : {}),
			orders: window.map((row) => ({
				...order(row.id, `Customer ${row.id}`),
				buyerRef: row.buyerRef,
			})),
			nextCursor: end < catalog.length ? `at-${String(end)}-${String(issuedCursors)}` : null,
			vocabulary: VOCABULARY,
		});
	});
}

/** Page one and two `Load more` — three responses, six rows, more behind them. */
async function scanThreePages(): Promise<Mounted> {
	stockCatalog(10);
	serveCatalog();
	const scan = await mount(<OrdersList onOpen={() => {}} />);
	await settle();
	await press(scan, "orders-load-more");
	await settle();
	await press(scan, "orders-load-more");
	await settle();
	expect(rowIds(scan, "orders-row")).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
	return scan;
}

test("a refresh re-reads every page on screen, from page one, following fresh cursors", async () => {
	view = await scanThreePages();
	asked = [];

	await press(view, "orders-refresh");
	await settle();

	// THREE REQUESTS FOR THREE PAGES, in order: the first carries no token,
	// because a grounded window opens on page one, and each one after it carries
	// the cursor the PREVIOUS RESPONSE issued — never the one the scan was built
	// with, which describes a boundary that may have moved.
	expect(asked).toHaveLength(3);
	expect(asked[0]?.cursor).toBeUndefined();
	expect(asked[1]?.cursor).toBe("at-2-4");
	expect(asked[2]?.cursor).toBe("at-4-5");
	// The depth is kept: three pages in, three pages out.
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
	expect(text(view, "orders-intro")).toContain("6 orders loaded so far");
	expect(text(view, "orders-page-position")).toContain("Pages 1–3");
});

test("a refresh shows what changed, and stops showing what has gone", async () => {
	view = await scanThreePages();
	// Between the scan and the click: one row is edited, and one is deleted.
	const edited = catalog.find((row) => row.id === "o-1");
	if (edited !== undefined) edited.buyerRef = "buyer-renamed";
	catalog = catalog.filter((row) => row.id !== "o-3");
	expect(text(view, "orders-table")).toContain("buyer-o-1");

	await press(view, "orders-refresh");
	await settle();

	// THE EDIT LANDS.
	expect(text(view, "orders-table")).toContain("buyer-renamed");
	expect(text(view, "orders-table")).not.toContain("buyer-o-1");
	// AND THE DELETED ROW GOES. It is in none of the pages the walk re-read, and
	// keeping it would have the screen assert a record that is not there at the
	// exact moment the operator asked whether it still was. The depth is what is
	// kept — three pages — so the window closes over the row that left.
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2", "o-4", "o-5", "o-6", "o-7"]);
	expect(text(view, "orders-intro")).toContain("6 orders loaded so far");
});

test("a refresh that stops part-way keeps what it re-read, and says the rest is not shown", async () => {
	view = await scanThreePages();
	// Two pages answer, the third does not.
	refuseAfterRequests(2);

	await press(view, "orders-refresh");
	await settle();

	// WHAT IS ON SCREEN IS WHAT WAS RE-READ, and nothing else: a window half
	// reconciled would carry one count line over rows taken at two moments.
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2", "o-3", "o-4"]);
	expect(text(view, "orders-intro")).toContain("4 orders loaded so far");
	// The position says two pages, because the stack was truncated with the
	// window — a stack still claiming three would number these rows wrongly.
	expect(text(view, "orders-page-position")).toContain("Pages 1–2");
	expect(text(view, "orders-refresh-stopped")).toContain(REFRESH_STOPPED_TITLE);
	// NOTHING IS WITHDRAWN: the last page it did re-read carries a live cursor, so
	// `Load more` is exactly how the missing depth comes back — which is what the
	// sentence tells the operator to do.
	expect(absent(view, "orders-load-more")).toBe(false);
	expect(absent(view, "orders-paging-stopped")).toBe(true);

	refuseAfter = null;
	await press(view, "orders-load-more");
	await settle();
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
	expect(absent(view, "orders-refresh-stopped")).toBe(true);
});

test("a refresh that re-reads NOTHING leaves the window exactly as it was", async () => {
	view = await scanThreePages();
	refuseAfterRequests(0);

	await press(view, "orders-refresh");
	await settle();

	// Nothing was replaced, so nothing is lost: the window on screen is still the
	// coherent one it was a moment ago, and the card says the refresh did not
	// happen rather than describing a page move nobody made.
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
	expect(text(view, "orders-load-more-failure")).toContain(REFRESH_FAILED_TITLE);
	expect(text(view, "orders-load-more-failure")).toContain(REFRESH_UNCHANGED_NOTE);
	expect(absent(view, "orders-refresh-stopped")).toBe(true);

	// AND RETRY RE-ISSUES THE WHOLE WALK, not the one page a Retry used to mean.
	refuseAfter = null;
	asked = [];
	await press(view, "orders-load-more-failure-action");
	await settle();
	expect(asked).toHaveLength(3);
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
});

test("a refresh whose page is REFUSED does not relocate the operator, and stops offering the token that was refused", async () => {
	view = await scanThreePages();
	// The first request answers; the second is refused and recovered to page one
	// by the plugin's client, which is right for a deep link and wrong here.
	rejectAfterRequests(1);

	await press(view, "orders-refresh");
	await settle();

	// The recovered page-one payload is discarded rather than merged, so the
	// window is the one page that genuinely answered.
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2"]);
	// AND PAGING IS WITHDRAWN, not merely narrated. The committed window's own
	// `nextCursor` IS the token that was just refused, so `Load more` from here
	// would re-send it — a notice saying "Load more gathers them again" would be
	// walking the operator into the paging-stopped state one click later.
	expect(absent(view, "orders-load-more")).toBe(true);
	expect(absent(view, "orders-pager")).toBe(true);
	// UNDER ITS OWN SENTENCE. The paging-stopped notice opens by promising the rows
	// on screen are unaffected, and this walk has just replaced them with fewer
	// pages; the refresh-stopped one ends by naming the one control that cannot
	// help. Neither may stand here.
	expect(absent(view, "orders-paging-stopped")).toBe(true);
	expect(absent(view, "orders-refresh-stopped")).toBe(true);
	const halted = text(view, "orders-refresh-halted");
	expect(halted).toContain(REFRESH_HALTED_TITLE);
	expect(halted).toContain("came back shorter");
	expect(halted).not.toContain("Load more");
	// And it is announced, for the same reason the other stop is: rows the operator
	// had are no longer on screen.
	expect(element(view, "orders-refresh-halted").contains(document.activeElement)).toBe(true);

	// And the way out is the act the sentence names first: a fresh walk re-derives
	// every boundary, so the offer comes back rather than staying gone.
	rejectAfter = null;
	await press(view, "orders-refresh");
	await settle();
	expect(absent(view, "orders-refresh-halted")).toBe(true);
	expect(absent(view, "orders-load-more")).toBe(false);
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2"]);
	// The position comes back with the paging it belongs to.
	expect(text(view, "orders-page-position")).toContain("Page 1");
});

test("`Apply filters` over an UNCHANGED predicate refreshes the scan instead of collapsing it", async () => {
	view = await scanThreePages();
	asked = [];

	await press(view, "apply-filters");
	await settle();

	// It is the same query restated, so there is no licence to throw the scan
	// away: three requests go out, and three pages come back.
	expect(asked).toHaveLength(3);
	expect(asked[0]?.cursor).toBeUndefined();
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
	expect(text(view, "orders-intro")).toContain("6 orders loaded so far");
});

test("`Apply filters` over a CHANGED predicate still collapses to page one", async () => {
	view = await scanThreePages();
	asked = [];

	await React.act(async () => {
		retype(element(view as Mounted, "filter-status") as HTMLSelectElement, "failed");
	});
	await press(view, "apply-filters");
	await settle();

	// A cursor is meaningless against a predicate it was not issued under, so the
	// window cannot survive this one — and this is the only act licensed to end it.
	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBeUndefined();
	expect(asked[0]?.filter?.status).toBe("failed");
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2"]);
	expect(text(view, "orders-intro")).toContain("2 orders on this page");
});

test("no two reads at once: Refresh is unavailable while a page is in flight, and refuses its click", async () => {
	view = await scanThreePages();
	// A `Load more` that has not answered yet.
	let release: ((response: Response) => void) | null = null;
	apiFetch.mockImplementation(
		() =>
			new Promise<Response>((resolve) => {
				release = resolve;
			}),
	);
	await press(view, "orders-load-more");

	const refresh = element(view, "orders-refresh");
	expect(refresh.getAttribute("aria-disabled")).toBe("true");
	// It keeps its tab stop while unavailable — this is the control the operator's
	// focus is sitting on — and it refuses its own click rather than starting a
	// rebuild the pending page would then land on top of.
	expect(refresh.tagName).toBe("BUTTON");
	expect(refresh.hasAttribute("disabled")).toBe(false);
	asked = [];
	await press(view, "orders-refresh");
	expect(asked).toHaveLength(0);

	await React.act(async () => {
		(release as ((response: Response) => void) | null)?.(
			envelope({ ok: true, orders: [], nextCursor: null, vocabulary: VOCABULARY }),
		);
	});
	await settle();
	expect(element(view, "orders-refresh").getAttribute("aria-disabled")).toBeNull();
});

/**
 * ON PRICING & INVENTORY THE FIRST RESPONSE OF A WALK IS A VERDICT, not just
 * rows.
 *
 * Only page one can say whether the low-stock predicate was actually applied —
 * every continuation reports `false` by contract, because the predicate rode
 * inside the opaque token — so a refresh that opens on page one is entitled to
 * raise that banner and, as here, to take it down. Getting this wrong in either
 * direction is a banner that can never be dismissed, or a catalog captioned as
 * low stock.
 */
test("a refresh clears a low-stock banner its page-one answer disproves, and keeps the scan", async () => {
	let unreadable = true;
	serve((request) => {
		const n = request.cursor === undefined ? 1 : Number(request.cursor.slice("cursor-".length));
		return envelope({
			ok: true,
			products: ids("p", n * 3 - 2, n * 3).map(product),
			nextCursor: `cursor-${String(n + 1)}`,
			stock: {
				threshold: unreadable ? null : 5,
				unreadable: false,
				filterUnavailable: request.cursor === undefined && unreadable,
			},
			vocabulary: PRODUCTS_VOCABULARY,
		});
	});
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(6);
	expect(absent(view, "products-stock-degraded")).toBe(false);
	// The filter was not applied, so these are every product, and the count says so.
	expect(text(view, "products-intro")).toContain("6 products loaded so far");

	// The store's threshold becomes readable again.
	unreadable = false;
	await press(view, "products-refresh");
	await settle();

	expect(absent(view, "products-stock-degraded")).toBe(true);
	expect(rows(view, "products-row")).toHaveLength(6);
	expect(text(view, "products-intro")).toContain("6 low-stock products loaded so far");
});

test("a refresh plans from the stack the ROWS were fetched by, not the one a failed page move advanced", async () => {
	view = await scanThreePages();
	// A `Load more` that fails. The stack keeps the entry it pushed on the click —
	// deliberately, so the pager is withdrawn rather than pretending the operator
	// never asked — while the rows on screen are still the three pages behind it.
	refuseAfterRequests(0);
	await press(view, "orders-load-more");
	await settle();
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);

	refuseAfter = null;
	asked = [];
	await press(view, "orders-refresh");
	await settle();

	// ONE ENTRY OF DRIFT WOULD MOVE THE ANCHOR A WHOLE PAGE: planning from the raw
	// stack would open this walk on page two and render pages 2–4 as the window
	// that starts at page one. The operator asked for the same query restated.
	expect(asked[0]?.cursor).toBeUndefined();
	expect(rowIds(view, "orders-row")).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
});

test("the low-stock verdict and the withheld total survive a Next, then a Refresh", async () => {
	// Page one cannot read the store's threshold; every continuation reports the
	// filter as available BY CONTRACT, because the predicate rode inside the token.
	// That contractual `false` is the value a refresh must not believe.
	serve((request) => {
		const n = request.cursor === undefined ? 1 : Number(request.cursor.slice("cursor-".length));
		return envelope({
			ok: true,
			products: ids("p", n * 3 - 2, n * 3).map(product),
			nextCursor: `cursor-${String(n + 1)}`,
			total: 137,
			stock: {
				threshold: null,
				unreadable: false,
				filterUnavailable: request.cursor === undefined,
			},
			vocabulary: PRODUCTS_VOCABULARY,
		});
	});
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	expect(absent(view, "products-stock-degraded")).toBe(false);

	await press(view, "products-next");
	await settle();
	expect(absent(view, "products-stock-degraded")).toBe(false);
	// The exact count is withheld with it: a confident 137 under a banner saying
	// the filter was skipped is the claim this pair exists to prevent.
	expect(text(view, "products-intro")).not.toContain("137");

	await press(view, "products-refresh");
	await settle();

	// A WALK ANCHORED ON A CONTINUATION CANNOT ANSWER THIS QUESTION, so it carries
	// the answer in rather than taking the contractual `false` at face value —
	// which would drop the banner and restore the total at the click of a control
	// that has nothing to do with filtering.
	expect(absent(view, "products-stock-degraded")).toBe(false);
	expect(text(view, "products-intro")).not.toContain("137");
	expect(rows(view, "products-row")).toHaveLength(3);
});

test("a Retry that replays a refresh reads as a refresh while it runs", async () => {
	view = await scanThreePages();
	refuseAfterRequests(0);
	await press(view, "orders-refresh");
	await settle();
	expect(text(view, "orders-load-more-failure")).toContain(REFRESH_FAILED_TITLE);

	// The retry re-issues the WHOLE walk, so the control that names that act must
	// not sit there live, unbusy, over a walk already in flight.
	apiFetch.mockImplementation(() => new Promise<Response>(() => {}));
	await press(view, "orders-load-more-failure-action");
	expect(text(view, "orders-refresh")).toContain("Refreshing");
	expect(element(view, "orders-refresh").getAttribute("aria-disabled")).toBe("true");
	// And says why it is dimmed rather than stating a cost it is refusing to incur.
	expect(element(view, "orders-refresh").getAttribute("title")).toBe(REFRESH_BUSY_TITLE);
});

test("Apply is unavailable while a read is in flight, rather than silently doing nothing", async () => {
	stockCatalog(10);
	let release: ((response: Response) => void) | null = null;
	apiFetch.mockImplementation(
		() =>
			new Promise<Response>((resolve) => {
				release = resolve;
			}),
	);
	view = await mount(<OrdersList onOpen={() => {}} />);
	// The very first load: `refresh` would refuse an Apply here, and a live button
	// over a refusal is a control that lies about what it does.
	const apply = element(view, "apply-filters") as HTMLButtonElement;
	expect(apply.disabled).toBe(true);

	serveCatalog();
	await React.act(async () => {
		(release as ((response: Response) => void) | null)?.(
			envelope({ ok: true, orders: [], nextCursor: null, vocabulary: VOCABULARY }),
		);
	});
	await settle();
	expect((element(view, "apply-filters") as HTMLButtonElement).disabled).toBe(false);
});

test("the notice that says rows are no longer shown is announced, not merely rendered", async () => {
	view = await scanThreePages();
	refuseAfterRequests(2);
	await press(view, "orders-refresh");
	await settle();

	// The licence to remove rows rests on the operator being able to perceive that
	// it happened — a live region inserted with its text already in place is the
	// one case assistive technology need not announce, so focus is handed to it.
	const notice = element(view, "orders-refresh-stopped");
	expect(notice.contains(document.activeElement)).toBe(true);
});

/**
 * THE POP DIRECTION — the case an arithmetic answer got backwards.
 *
 * `Previous` POPS the stack and THEN asks, so after it the stack is already one
 * entry shorter than the window on screen. Deriving "what the rows were fetched
 * by" by subtracting an entry therefore lands two pages behind: page three
 * teleports to page one, under the words "the same query restated". What a refresh
 * plans from is not arithmetic on the current stack — it is the stack that was
 * true when the rows arrived, which is kept rather than computed.
 */
async function walkToPageThree(): Promise<Mounted> {
	stockCatalog(10);
	serveCatalog();
	const scan = await mount(<OrdersList onOpen={() => {}} />);
	await settle();
	await press(scan, "orders-next");
	await settle();
	await press(scan, "orders-next");
	await settle();
	expect(rowIds(scan, "orders-row")).toEqual(["o-5", "o-6"]);
	return scan;
}

test("a refresh after a FAILED Previous re-reads the page on screen, not two pages back", async () => {
	view = await walkToPageThree();
	refuseAfterRequests(0);
	await press(view, "orders-prev");
	await settle();
	// The move failed, so the rows are still page three's — and the stack has
	// already popped to page two.
	expect(rowIds(view, "orders-row")).toEqual(["o-5", "o-6"]);

	refuseAfter = null;
	asked = [];
	await press(view, "orders-refresh");
	await settle();

	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBe("at-4-2");
	expect(rowIds(view, "orders-row")).toEqual(["o-5", "o-6"]);
});

test("a refresh after a REFUSED Previous re-reads the page on screen", async () => {
	view = await walkToPageThree();
	// The service rejects the popped token and recovers to page one; mid-scan that
	// payload is discarded and paging is withdrawn, so the rows are still page
	// three's — and the stack has still already popped.
	rejectAfterRequests(0);
	await press(view, "orders-prev");
	await settle();
	expect(rowIds(view, "orders-row")).toEqual(["o-5", "o-6"]);

	rejectAfter = null;
	asked = [];
	await press(view, "orders-refresh");
	await settle();

	expect(asked[0]?.cursor).toBe("at-4-2");
	expect(rowIds(view, "orders-row")).toEqual(["o-5", "o-6"]);
});

test("the same, on a window a LINK opened: it is never walked back to page one", async () => {
	stockCatalog(10);
	serveCatalog();
	// A deep link to page three, then one `Load more`: an ungrounded window two
	// responses wide. Subtracting an entry here reached the very state the plan's
	// clamp calls unreachable — an ungrounded walk anchored on nothing, which is
	// page one, which is not where this operator is.
	view = await mount(<OrdersList onOpen={() => {}} initialCursor="at-4-0" />);
	await settle();
	await press(view, "orders-load-more");
	await settle();
	expect(rowIds(view, "orders-row")).toEqual(["o-5", "o-6", "o-7", "o-8"]);

	refuseAfterRequests(0);
	await press(view, "orders-prev");
	await settle();
	refuseAfter = null;
	asked = [];
	await press(view, "orders-refresh");
	await settle();

	// Anchored on the link's own page, two deep, exactly as the window is.
	expect(asked[0]?.cursor).toBe("at-4-0");
	expect(asked).toHaveLength(2);
	expect(rowIds(view, "orders-row")).toEqual(["o-5", "o-6", "o-7", "o-8"]);
});
