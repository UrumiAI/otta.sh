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
import { PRODUCTS_LOAD_MORE_FAILED_TITLE } from "@otta-sh/admin-presentation";
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
	// starts at page one of whatever the address now names. Accumulated pages are
	// NOT restored; the URL carries a filter, never a page count.
	await React.act(async () => {
		window.dispatchEvent(new PopStateEvent("popstate"));
	});
	await settle();
	expect(asked.at(-1)?.cursor).toBeUndefined();
	expect(rows(view, "orders-row")).toHaveLength(20);
	expect(text(view, "orders-intro")).toContain("20 orders on this page");
});

test("F29: the narrowed count names what it counted, and the scan says it is one", async () => {
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
	// The note belongs beside the control it qualifies, and only while there is
	// something left to scan.
	expect(text(view, "products-low-stock-paging-note")).toBe(
		"Low stock only filters each page as it loads.",
	);

	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(5);
	expect(text(view, "products-intro")).toContain("5 low-stock products loaded so far");
});

test("a narrowed catalog that fits on ONE page still gets the page-scoped qualifier", async () => {
	// THE DEFECT THIS PINS. "Low stock only" has no service predicate — it keeps
	// the low-stock rows out of whatever page was fetched — so `nextCursor: null`
	// on the FIRST response means only "the fetch stopped here", never "every
	// low-stock row in the catalog is on screen". `listOutcome` used to read
	// `firstPage && !hasNext` as proof the counted set was complete regardless of
	// how it was counted, so a catalog that happened to fit on one page dropped
	// the qualifier and read as a whole-catalog claim — "3 low-stock products" —
	// which is exactly the claim `LOW_STOCK_FILTER_DESCRIPTION` and
	// `PRODUCTS_LOW_STOCK_NO_MATCH` both promise this filter never makes.
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
	// PAGE-SCOPED, NOT WHOLE-SET — the render never fetched a second page because
	// there was not one, not because it proved every low-stock row in the
	// catalog is on screen. Those are different claims and only the first is
	// true here.
	expect(text(view, "products-intro")).toContain("3 low-stock products on this page");
	// No `Load more`, because there really is nothing left to fetch — the
	// qualifier stands on its own, without the paging note that only renders
	// beside a live button.
	expect(absent(view, "products-load-more")).toBe(true);
	expect(absent(view, "products-low-stock-paging-note")).toBe(true);
});

test("a narrowed SCAN that exhausts the catalog keeps 'loaded so far'", async () => {
	// THE HALF THE F29 TEST (ABOVE) NEVER REACHES: its second response always
	// carries a non-null `nextCursor`, so `hasNext` never goes false once pages
	// accumulate and that test would stay green even if THIS fix were reverted.
	// Here a scan runs three responses deep and the THIRD exhausts the catalog —
	// `firstPage` stays true throughout (the render started at page one), so the
	// pre-fix `complete = firstPage && !hasNext` would have gone true on exactly
	// this response and dropped straight to whole-set phrasing on an accumulated,
	// still page-scoped count.
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
	expect(text(view, "products-intro")).toContain("3 low-stock products loaded so far");

	await press(view, "products-load-more");
	await settle();
	expect(rows(view, "products-row")).toHaveLength(4);
	// THE SCAN RAN OUT OF CATALOG ON ITS THIRD REQUEST, not out of doubt — the
	// four accumulated rows are still only what the scan happened to find, never
	// promoted to a whole-catalog claim just because nothing was left to fetch.
	expect(text(view, "products-intro")).toContain("4 low-stock products loaded so far");
	expect(absent(view, "products-load-more")).toBe(true);
});

test("a filterUnavailable page keeps the SERVICE'S noun and total, not the checkbox's", async () => {
	// END TO END: the operator checked "Low stock only", but the plugin could
	// not read the threshold this time (`stock.filterUnavailable`)
	// — narrowing did not apply, every product on the page is listed, and the
	// service's own exact `total` still arrived (`applyLowStockNarrowing` only
	// withholds `total` when it actually narrows). Reading `narrowed` off the
	// checkbox alone renders "137 low-stock products": a wrong number (a real
	// `total` refused, then a fallback describing only 5 rows) and a wrong noun,
	// directly above the banner already saying the filter was not applied. This
	// also distinguishes the real fix from a `firstPage: false` hack at the call
	// site: the hack alone would not honour a real `total` or pick the ordinary
	// noun here, because it never asks whether the narrowing actually applied.
	serve(() =>
		envelope({
			ok: true,
			products: ids("p", 1, 5).map(product),
			nextCursor: null,
			total: 137,
			stock: { threshold: null, unreadable: false, filterUnavailable: true },
			vocabulary: PRODUCTS_VOCABULARY,
		}),
	);
	view = await mount(<ProductsList onOpen={() => {}} initialFilter={{ lowStock: true }} />);
	await settle();
	expect(rows(view, "products-row")).toHaveLength(5);
	// THE SERVICE'S REAL TOTAL, HONOURED — an ordinary, service-filtered page once
	// the narrowing did not actually apply, entitled to the same exact figure any
	// other filtered list states.
	expect(text(view, "products-intro")).toContain("137 products");
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
	expect(text(view, "products-load-more-failure")).toContain(PRODUCTS_LOAD_MORE_FAILED_TITLE);
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
