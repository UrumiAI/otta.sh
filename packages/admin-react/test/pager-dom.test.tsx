/**
 * @vitest-environment happy-dom
 *
 * PREVIOUS, NEXT, AND `Page N of M` — the pager, in the two halves it is made
 * of.
 *
 * THE ALGEBRA FIRST. Where the operator is in a keyset scan is a value: a
 * CLIENT-SIDE STACK of the cursors they have paged through, pushed on the way
 * forward and popped on the way back. Nothing on the wire changes, and no
 * reverse keyset query exists — the exactness comes from replaying a cursor the
 * service already issued. That value has its own rules (what a deep link seeds
 * it with, when a pop lands on page one, when the position is simply not
 * knowable) and they are pinned as pure functions, because a bug in them is a
 * wrong page number rather than a wrong pixel.
 *
 * THEN THE WIRING, which only a document can settle: that `Next` REPLACES the
 * rows rather than accumulating them, that `Previous` RE-REQUESTS the popped
 * cursor rather than restoring rows from memory (the stack holds cursors, not
 * pages — so what comes back is the store as it stands now, and one round trip
 * is what buys that), that the address follows both, and that a filter apply
 * resets the stack so `Previous` can never walk into another predicate's pages.
 *
 * EVERY RESPONSE IS SERVED HERE, `total` included, so `Page N of M` is proven
 * against a service that reports the exact count and against one that does not —
 * absent is an em dash, never "of 1".
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	FIRST_PAGE,
	hasPreviousPage,
	pageNumber,
	pagerView,
	poppedPage,
	pushedPage,
	seedTrail,
} from "../src/accumulate.js";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrdersScreen } = await import("../src/orders/orders-screen.js");
const { ProductsScreen } = await import("../src/products/products-screen.js");
const { NEXT_AT_END_TITLE, PREVIOUS_AT_START_TITLE, PREVIOUS_UNWALKED_TITLE } =
	await import("@otta-sh/admin-presentation");

// ── the stack, as a value ────────────────────────────────────────────────────

describe("the cursor stack — where the operator is, as a value", () => {
	test("a fresh list is page one, with nothing behind it", () => {
		expect(pageNumber(FIRST_PAGE)).toBe(1);
		expect(hasPreviousPage(FIRST_PAGE)).toBe(false);
	});

	test("each page walked forward is one push, and the number follows", () => {
		const two = pushedPage(FIRST_PAGE, "c2");
		const three = pushedPage(two, "c3");
		expect(pageNumber(two)).toBe(2);
		expect(pageNumber(three)).toBe(3);
		expect(hasPreviousPage(three)).toBe(true);
	});

	test("a pop names the cursor of the page it returns to", () => {
		// THE WHOLE MECHANISM: the stack holds the cursors the service already
		// issued, so going back is replaying one of them. No reverse keyset query
		// exists, and none is needed.
		const three = pushedPage(pushedPage(FIRST_PAGE, "c2"), "c3");
		const back = poppedPage(three);
		expect(back.cursor).toBe("c2");
		expect(pageNumber(back.trail)).toBe(2);
	});

	test("popping the LAST cursor lands page one — no cursor at all", () => {
		const back = poppedPage(pushedPage(FIRST_PAGE, "c2"));
		expect(back.cursor).toBeUndefined();
		expect(pageNumber(back.trail)).toBe(1);
		expect(hasPreviousPage(back.trail)).toBe(false);
	});

	test("a DEEP LINK seeds a page whose number is not knowable", () => {
		// The hazard this exists for: an address names ONE page. The list can go
		// forward from it and come back to it, but it cannot know whether it was
		// page 2 or page 40, and inventing "page 2" because the stack is one deep
		// would be a number an operator would reconcile against and lose.
		const seeded = seedTrail("c-deep");
		expect(pageNumber(seeded)).toBeUndefined();
		// AND `Previous` IS NOT OFFERED, because popping would land page one, which
		// is not the page before this one.
		expect(hasPreviousPage(seeded)).toBe(false);
	});

	test("a deep link that pages forward can still come back to where it landed", () => {
		const seeded = seedTrail("c-deep");
		const onward = pushedPage(seeded, "c-next");
		expect(hasPreviousPage(onward)).toBe(true);
		expect(poppedPage(onward).cursor).toBe("c-deep");
		// Still not knowable, one page further along.
		expect(pageNumber(onward)).toBeUndefined();
	});

	test("an absent or empty seed is page one — a trimmed link is not a page", () => {
		expect(seedTrail(undefined)).toEqual(FIRST_PAGE);
		expect(seedTrail("")).toEqual(FIRST_PAGE);
	});

	test("popping a stack with nowhere to go changes nothing", () => {
		// Total rather than partial: the controls guard this, and a helper that
		// threw (or silently invented page one) would make the guard load-bearing.
		expect(poppedPage(FIRST_PAGE).trail).toEqual(FIRST_PAGE);
		const seeded = seedTrail("c-deep");
		expect(poppedPage(seeded).trail).toEqual(seeded);
	});
});

describe("what the pager offers, and what it says", () => {
	const base = { rows: 25, total: 137, pageSize: 25, busy: false, withdrawn: false };

	test("page one of six: forward only, and the dimmed control says why", () => {
		const view = pagerView({ ...base, trail: FIRST_PAGE, hasNext: true });
		expect(view.visible).toBe(true);
		expect(view.position).toBe("Page 1 of 6");
		expect(view.previous.unavailable).toBe(true);
		expect(view.previous.title).toBe(PREVIOUS_AT_START_TITLE);
		expect(view.next.unavailable).toBe(false);
		expect(view.next.title).toBeUndefined();
	});

	test("the LAST page is the page count, whatever the arithmetic says", () => {
		// This render has DIRECT evidence — the service returned no cursor after
		// these rows — while a derived count is arithmetic over two statements
		// taken at different moments. Direct evidence wins, and it is also the only
		// thing that can answer at all when the service sends no total.
		const walked = pushedPage(pushedPage(FIRST_PAGE, "c2"), "c3");
		expect(pagerView({ ...base, trail: walked, hasNext: false }).position).toBe("Page 3 of 3");
		expect(pagerView({ ...base, total: undefined, trail: walked, hasNext: false }).position).toBe(
			"Page 3 of 3",
		);
	});

	test("NO total is an em dash, never `of 1` and never `of 0`", () => {
		const view = pagerView({ ...base, total: undefined, trail: FIRST_PAGE, hasNext: true });
		expect(view.position).toBe("Page 1 of —");
		expect(view.position).not.toContain("of 1");
		expect(view.position).not.toContain("of 0");
	});

	test("a deep-linked page dims Previous and says it is the address's fault, not an error", () => {
		const view = pagerView({ ...base, trail: seedTrail("c-deep"), hasNext: true });
		expect(view.previous.unavailable).toBe(true);
		expect(view.previous.title).toBe(PREVIOUS_UNWALKED_TITLE);
		expect(view.position).toBe("Page — of 6");
	});

	test("the last page dims Next and says so", () => {
		const view = pagerView({ ...base, trail: pushedPage(FIRST_PAGE, "c2"), hasNext: false });
		expect(view.next.unavailable).toBe(true);
		expect(view.next.title).toBe(NEXT_AT_END_TITLE);
		expect(view.previous.unavailable).toBe(false);
	});

	test("a request in flight dims both WITHOUT claiming a reason it does not have", () => {
		const view = pagerView({
			...base,
			trail: pushedPage(FIRST_PAGE, "c2"),
			hasNext: true,
			busy: true,
		});
		expect(view.previous.unavailable).toBe(true);
		expect(view.next.unavailable).toBe(true);
		// Busy is not "first page" and not "last page": no title is the honest
		// answer for a control that is merely momentarily unavailable.
		expect(view.previous.title).toBeUndefined();
		expect(view.next.title).toBeUndefined();
	});

	test("nothing to page is no pager at all", () => {
		// A collection that fits on one page must not grow two dead controls and a
		// line saying `Page 1 of 1`.
		expect(pagerView({ ...base, trail: FIRST_PAGE, hasNext: false }).visible).toBe(false);
	});

	test("a withdrawn pager is withdrawn whatever the stack says", () => {
		// The failure and the paging-stopped states take the whole control away —
		// see the DOM half.
		expect(
			pagerView({ ...base, trail: pushedPage(FIRST_PAGE, "c2"), hasNext: true, withdrawn: true })
				.visible,
		).toBe(false);
	});
});

// ── the wiring ───────────────────────────────────────────────────────────────

const VOCABULARY = {
	statuses: ["paid", "failed"],
	statusAny: "any",
	periods: [{ key: "last30", label: "Last 30 days" }],
	cancellationReasons: [],
	oneClickCancellationReasons: [],
	reconciliationOutcomes: [],
	pageLimit: 25,
};

const PRODUCTS_VOCABULARY = {
	statuses: [{ value: "any", label: "Any status" }],
	kinds: [{ value: "any", label: "Any kind" }],
	any: "any",
	pageLimit: 25,
};

/** Service-shaped opaque tokens: base64URL of `{pos, filter, limit}`, which is
 *  what the route emits and what an address therefore has to survive. */
function token(payload: unknown): string {
	return btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PAGE_TWO = token({ pos: { createdAt: "2026-03-02T10:20:00.000Z", id: "o-25" }, limit: 25 });
const PAGE_THREE = token({ pos: { createdAt: "2026-03-02T10:40:00.000Z", id: "o-50" }, limit: 25 });
const PAGE_FOUR = token({ pos: { createdAt: "2026-03-02T11:00:00.000Z", id: "o-75" }, limit: 25 });

function order(id: string) {
	return {
		id,
		state: "paid",
		currency: "USD",
		buyerRef: `buyer-${id}`,
		customerId: null,
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
		onHand: 4,
		createdAt: "2026-01-01T00:00:00.000Z",
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
	readonly filter?: { readonly status?: string };
}

let asked: Request[] = [];

function serve(handler: (request: Request) => Response): void {
	apiFetch.mockImplementation((_input, init) => {
		const request = JSON.parse(String(init?.body ?? "{}")) as Request;
		asked.push(request);
		return Promise.resolve(handler(request));
	});
}

/** Pages of 25, each reachable only with the one before it, and the service's
 *  exact count of the set beside them: 137 rows at 25 a page is SIX pages, the
 *  last one short. Every page here has another behind it, so `M` is the derived
 *  figure throughout and the last-page rule is exercised on its own fixture
 *  below rather than accidentally here. */
function serveOrders(opts: { total?: number } = { total: 137 }): void {
	serve((request) => {
		const total = opts.total;
		const body = (orders: readonly unknown[], nextCursor: string | null) =>
			envelope({
				ok: true,
				orders,
				nextCursor,
				...(total !== undefined ? { total } : {}),
				vocabulary: VOCABULARY,
			});
		if (request.cursor === undefined) return body(ids("o", 1, 25).map(order), PAGE_TWO);
		if (request.cursor === PAGE_TWO) return body(ids("o", 26, 50).map(order), PAGE_THREE);
		if (request.cursor === PAGE_THREE) return body(ids("o", 51, 75).map(order), PAGE_FOUR);
		return body(ids("o", 76, 100).map(order), null);
	});
}

function element(view: Mounted, testId: string): HTMLElement {
	const found = view.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (found === null) throw new Error(`no ${testId} on the screen`);
	return found;
}

function absent(view: Mounted, testId: string): boolean {
	return view.container.querySelector(`[data-testid="${testId}"]`) === null;
}

function rowIds(view: Mounted, testId: string): (string | null)[] {
	return [...view.container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)].map((tr) =>
		tr.getAttribute("data-row-id"),
	);
}

function press(view: Mounted, testId: string): Promise<void> {
	return fire(element(view, testId), "click");
}

function position(view: Mounted, screen: string): string {
	return element(view, `${screen}-page-position`).textContent ?? "";
}

/** Settle the request the last interaction issued. */
async function settle(): Promise<void> {
	for (let round = 0; round < 3; round += 1) {
		await React.act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

function retype(field: HTMLInputElement | HTMLSelectElement, value: string): void {
	const proto = field instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
	Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(field, value);
	field.dispatchEvent(
		new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
	);
}

function search(): URLSearchParams {
	return new URLSearchParams(window.location.search);
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
	window.history.replaceState(null, "", "/");
});

test("Next walks forward one page at a time, and the address walks with it", async () => {
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();

	expect(position(view, "orders")).toBe("Page 1 of 6");
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 1, 25));

	await press(view, "orders-next");
	await settle();
	// THE PAGE REPLACES, it does not accumulate: `Next` moves a window, while
	// `Load more` extends one, and the two are different acts.
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 26, 50));
	expect(position(view, "orders")).toBe("Page 2 of 6");
	expect(search().get("cursor")).toBe(PAGE_TWO);

	await press(view, "orders-next");
	await settle();
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 51, 75));
	expect(position(view, "orders")).toBe("Page 3 of 6");
	expect(search().get("cursor")).toBe(PAGE_THREE);
});

test("Previous RE-REQUESTS the popped cursor — it does not restore rows from memory", async () => {
	/*
	 * THE CHOICE, PINNED. The stack holds CURSORS, so going back is a request
	 * under a token the service already issued: exact, and answered with the store
	 * as it stands NOW. Restoring the rows a page arrived with would be one fewer
	 * round trip and would show an operator a page that may be minutes stale — and
	 * would disagree with a reload of the very same address, which fetches.
	 */
	let visits = 0;
	serve((request) => {
		const body = (orders: readonly unknown[], nextCursor: string | null) =>
			envelope({ ok: true, orders, nextCursor, total: 137, vocabulary: VOCABULARY });
		if (request.cursor === undefined) return body(ids("o", 1, 25).map(order), PAGE_TWO);
		if (request.cursor === PAGE_TWO) {
			visits += 1;
			// The second visit to page two sees a row that was edited in between.
			return body(
				visits === 1 ? ids("o", 26, 50).map(order) : ids("o", 26, 49).map(order),
				PAGE_THREE,
			);
		}
		return body(ids("o", 51, 75).map(order), null);
	});
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();
	await press(view, "orders-next");
	await settle();

	asked = [];
	await press(view, "orders-prev");
	await settle();

	// A REQUEST WENT OUT, carrying the popped cursor verbatim.
	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBe(PAGE_TWO);
	// And the rows are the ones the store holds now, not the ones this screen
	// had in hand.
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 26, 49));
	expect(position(view, "orders")).toBe("Page 2 of 6");
	expect(search().get("cursor")).toBe(PAGE_TWO);
});

test("Previous off the bottom of the stack is page one, cursor and all", async () => {
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();

	asked = [];
	await press(view, "orders-prev");
	await settle();

	// NO CURSOR ON THE WIRE — page one is the absence of one, not a token for it.
	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBeUndefined();
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 1, 25));
	expect(position(view, "orders")).toBe("Page 1 of 6");
	// And the address is corrected through the same one path the list has always
	// announced its page on.
	expect(search().get("cursor")).toBeNull();
});

test("an unavailable control is focusable, explains itself, and issues nothing", async () => {
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();

	const previous = element(view, "orders-prev");
	// `aria-disabled`, NOT `disabled`: a control that leaves the tab order under
	// the operator's fingers takes the focus with it, and `Next` becomes
	// unavailable at exactly the moment it is being pressed.
	expect(previous.getAttribute("aria-disabled")).toBe("true");
	expect(previous.hasAttribute("disabled")).toBe(false);
	expect(previous.getAttribute("title")).toBe(PREVIOUS_AT_START_TITLE);
	expect(previous.className).toContain("otta-focusable");

	asked = [];
	await press(view, "orders-prev");
	await settle();
	expect(asked).toHaveLength(0);
});

test("paging onto the LAST page keeps the focus it was pressed with", async () => {
	// Two pages: 25 then 5, and an exact count of 30. `Next` goes unavailable the
	// moment it lands, which is the case a `disabled` attribute would answer by
	// dropping focus to `document.body`.
	serve((request) =>
		envelope(
			request.cursor === undefined
				? {
						ok: true,
						orders: ids("o", 1, 25).map(order),
						nextCursor: PAGE_TWO,
						total: 30,
						vocabulary: VOCABULARY,
					}
				: {
						ok: true,
						orders: ids("o", 26, 30).map(order),
						nextCursor: null,
						total: 30,
						vocabulary: VOCABULARY,
					},
		),
	);
	view = await mount(<OrdersScreen />);
	await settle();

	const next = element(view, "orders-next");
	next.focus();
	await press(view, "orders-next");
	await settle();

	expect(position(view, "orders")).toBe("Page 2 of 2");
	expect(element(view, "orders-next").getAttribute("aria-disabled")).toBe("true");
	expect(element(view, "orders-next").getAttribute("title")).toBe(NEXT_AT_END_TITLE);
	// THE FOCUS IS STILL THERE, on the same element.
	expect(document.activeElement).toBe(element(view, "orders-next"));
});

test("a service with no exact count still pages — M is an em dash, never `of 1`", async () => {
	serveOrders({});
	view = await mount(<OrdersScreen />);
	await settle();

	expect(position(view, "orders")).toBe("Page 1 of —");
	await press(view, "orders-next");
	await settle();
	expect(position(view, "orders")).toBe("Page 2 of —");
	// And the count line beside it keeps its own hedge rather than borrowing a
	// figure neither of them has.
	expect(element(view, "orders-intro").textContent).toContain("25 orders on this page");
});

test("a deep link cannot know its page: Previous is dimmed and says why", async () => {
	serveOrders();
	window.history.replaceState(null, "", `/orders?cursor=${encodeURIComponent(PAGE_TWO)}`);
	view = await mount(<OrdersScreen />);
	await settle();

	expect(rowIds(view, "orders-row")).toEqual(ids("o", 26, 50));
	// N IS ABSENT, and absent renders as a dash — the address named one page, and
	// nothing about it says which one.
	expect(position(view, "orders")).toBe("Page — of 6");
	const previous = element(view, "orders-prev");
	expect(previous.getAttribute("aria-disabled")).toBe("true");
	expect(previous.getAttribute("title")).toBe(PREVIOUS_UNWALKED_TITLE);

	// FORWARD FROM A DEEP LINK STILL COMES BACK. The seeded page is on the stack
	// even though its number is not, so `Previous` returns to it rather than to
	// page one.
	await press(view, "orders-next");
	await settle();
	expect(position(view, "orders")).toBe("Page — of 6");
	asked = [];
	await press(view, "orders-prev");
	await settle();
	expect(asked[0]?.cursor).toBe(PAGE_TWO);
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 26, 50));
	expect(search().get("cursor")).toBe(PAGE_TWO);
});

test("applying a filter RESETS the stack — Previous can never cross a predicate", async () => {
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();
	await press(view, "orders-next");
	await settle();
	expect(position(view, "orders")).toBe("Page 3 of 6");

	await React.act(async () => {
		retype(element(view as Mounted, "filter-status") as HTMLSelectElement, "failed");
	});
	await press(view, "apply-filters");
	await settle();

	// PAGE ONE OF A NEW SET, with nothing behind it. A stack that survived would
	// hand `Previous` a token issued under the predicate the operator just left —
	// which the service refuses, and which would land them on page one with a
	// notice for a journey they thought they understood.
	expect(position(view, "orders")).toBe("Page 1 of 6");
	expect(element(view, "orders-prev").getAttribute("aria-disabled")).toBe("true");
	expect(search().get("cursor")).toBeNull();
	expect(asked.at(-1)?.filter?.status).toBe("failed");
});

test("Load more and the pager share one position: the scan is where the pager is", async () => {
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();

	// LOAD MORE ADVANCES THE POSITION TOO. Both controls move to the next page;
	// they differ only in whether the rows above stay on screen.
	await press(view, "orders-load-more");
	await settle();
	expect(rowIds(view, "orders-row")).toHaveLength(50);
	expect(position(view, "orders")).toBe("Page 2 of 6");
	expect(element(view, "orders-intro").textContent).toContain("137 orders");

	// NEXT FROM AN ACCUMULATED SCAN pages on from the scan's last cursor, and the
	// stack records where it came from. The window collapses to one page — a
	// pager step is a move, not an extension — which is the stated cost of having
	// both controls.
	await press(view, "orders-next");
	await settle();
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 51, 75));
	expect(position(view, "orders")).toBe("Page 3 of 6");

	asked = [];
	await press(view, "orders-prev");
	await settle();
	expect(asked[0]?.cursor).toBe(PAGE_TWO);
	expect(position(view, "orders")).toBe("Page 2 of 6");
});

test("paging stopped withdraws the pager, not just the offer to continue", async () => {
	let call = 0;
	serve((request) => {
		call += 1;
		const body = (orders: readonly unknown[], extra: Record<string, unknown> = {}) =>
			envelope({
				ok: true,
				orders,
				nextCursor: PAGE_TWO,
				total: 137,
				vocabulary: VOCABULARY,
				...extra,
			});
		if (request.cursor === undefined) return body(ids("o", 1, 25).map(order));
		if (call === 2) return body(ids("o", 26, 50).map(order));
		return body(ids("o", 1, 25).map(order), { cursorRejected: true });
	});
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();
	expect(absent(view, "orders-pager")).toBe(false);

	await press(view, "orders-next");
	await settle();

	// The rows on screen are untouched and paging is over — and a `Previous` left
	// standing would page relative to a position the screen has just disowned in
	// the address.
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 26, 50));
	expect(absent(view, "orders-pager")).toBe(true);
	expect(absent(view, "orders-load-more")).toBe(true);
	expect(absent(view, "orders-paging-stopped")).toBe(false);
});

test("a refused deep link comes back as page one, with a stack to match", async () => {
	serve((request) =>
		envelope({
			ok: true,
			orders: ids("o", 1, 25).map(order),
			nextCursor: PAGE_TWO,
			total: 137,
			vocabulary: VOCABULARY,
			...(request.cursor !== undefined ? { cursorRejected: true } : {}),
		}),
	);
	window.history.replaceState(null, "", "/orders?cursor=tampered");
	view = await mount(<OrdersScreen />);
	await settle();

	// The rows ARE page one, so the position must say so rather than keeping the
	// unknowable page the address asked for.
	expect(absent(view, "orders-cursor-reset")).toBe(false);
	expect(position(view, "orders")).toBe("Page 1 of 6");
	expect(element(view, "orders-prev").getAttribute("title")).toBe(PREVIOUS_AT_START_TITLE);
});

test("products pages the same way, from the same stack", async () => {
	serve((request) => {
		const stock = { threshold: 5, unreadable: false, filterUnavailable: false };
		const body = (products: readonly unknown[], nextCursor: string | null) =>
			envelope({
				ok: true,
				products,
				nextCursor,
				total: 137,
				stock,
				vocabulary: PRODUCTS_VOCABULARY,
			});
		if (request.cursor === undefined) return body(ids("p", 1, 25).map(product), PAGE_TWO);
		if (request.cursor === PAGE_TWO) return body(ids("p", 26, 50).map(product), PAGE_THREE);
		return body(ids("p", 51, 75).map(product), PAGE_FOUR);
	});
	window.history.replaceState(null, "", "/products");
	view = await mount(<ProductsScreen />);
	await settle();

	expect(position(view, "products")).toBe("Page 1 of 6");
	await press(view, "products-next");
	await settle();
	expect(rowIds(view, "products-row")).toEqual(ids("p", 26, 50));
	expect(position(view, "products")).toBe("Page 2 of 6");
	expect(search().get("cursor")).toBe(PAGE_TWO);

	asked = [];
	await press(view, "products-prev");
	await settle();
	expect(asked[0]?.cursor).toBeUndefined();
	expect(rowIds(view, "products-row")).toEqual(ids("p", 1, 25));
	expect(position(view, "products")).toBe("Page 1 of 6");
	expect(search().get("cursor")).toBeNull();
});
