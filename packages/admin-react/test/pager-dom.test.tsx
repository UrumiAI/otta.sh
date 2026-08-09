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
	PAGE_STATE_KEY,
	entryState,
	hasPreviousPage,
	pageNumber,
	pagerView,
	poppedPage,
	pushedPage,
	readTrailState,
	seedTrail,
	trailState,
} from "../src/accumulate.js";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrdersScreen } = await import("../src/orders/orders-screen.js");
const { ProductsScreen } = await import("../src/products/products-screen.js");
const {
	NEXT_AT_END_TITLE,
	NEXT_RELEASES_SCAN_TITLE,
	PREVIOUS_AT_START_TITLE,
	PREVIOUS_UNWALKED_TITLE,
} = await import("@otta-sh/admin-presentation");

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

	test("the same cursor pushed twice is ONE page — the stack cannot outrun the walk", () => {
		// AN INVARIANT, NOT A GUARD. The screens make the control unavailable while a
		// request is in flight, but "unavailable" is a rendered state: two presses
		// resolved inside one batch, a synthetic double event, or a service that
		// answers two consecutive pages with the same `nextCursor` would each push
		// the same token twice and leave the position quietly one too deep — which
		// is the one defect a page number exists to avoid.
		const once = pushedPage(FIRST_PAGE, "c2");
		expect(pushedPage(once, "c2")).toEqual(once);
		// A DIFFERENT cursor is a different page and is pushed normally.
		expect(pageNumber(pushedPage(once, "c3"))).toBe(3);
	});

	test("the stack and the cursor agree, or the move is inert", () => {
		// `Previous` is offered only when there is a page recorded behind this one,
		// and every path that clears the cursor (a filter apply, a refused deep
		// link) resets the stack in the same commit. Should the two ever disagree
		// anyway, the pop cannot invent a page that was never walked to: it answers
		// with the page it is already on.
		expect(hasPreviousPage(seedTrail("c-deep"))).toBe(false);
		expect(poppedPage(seedTrail("c-deep")).cursor).toBe("c-deep");
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
		expect(pagerView({ ...base, total: 70, trail: walked, hasNext: false }).position).toBe(
			"Page 3 of 3",
		);
		expect(pagerView({ ...base, total: undefined, trail: walked, hasNext: false }).position).toBe(
			"Page 3 of 3",
		);
	});

	test("a page count that OUTRUNS the last page is a disagreement, and dashes", () => {
		// THE CASE THE OVERRIDE GOT WRONG. Standing on page 3 with no cursor after
		// it while the count implies six pages is two statements that cannot both
		// be true — a concurrent write between the count and the page, or a service
		// disagreeing with itself. "Page 3 of 3" beside "137 orders" picks a winner
		// this render has no grounds to pick, so it states neither.
		const walked = pushedPage(pushedPage(FIRST_PAGE, "c2"), "c3");
		expect(pagerView({ ...base, trail: walked, hasNext: false }).position).toBe("Page 3 of —");
	});

	test("an accumulated window states its RANGE, and `Next` says what it costs", () => {
		// Fifty rows beginning at page one are not "Page 2", and pressing `Next`
		// over them releases the pages above — said in front of the click rather
		// than discovered after it.
		const view = pagerView({
			...base,
			rows: 50,
			trail: pushedPage(FIRST_PAGE, "c2"),
			hasNext: true,
			span: 2,
		});
		expect(view.position).toBe("Pages 1–2 of 6");
		expect(view.next.title).toBe(NEXT_RELEASES_SCAN_TITLE);
		// With one page on screen there is nothing to release and nothing to warn
		// about.
		expect(pagerView({ ...base, trail: FIRST_PAGE, hasNext: true }).next.title).toBeUndefined();
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

	test("a walked stack survives a round trip through a history entry", () => {
		// What the screens store and `popstate` reads back — the whole reason Back
		// onto page four still knows it is page four.
		const walked = pushedPage(pushedPage(FIRST_PAGE, "c2"), "c3");
		expect(readTrailState({ ottaOrder: null, [PAGE_STATE_KEY]: trailState(walked) })).toEqual(
			walked,
		);
		expect(readTrailState(entryState(null, { ottaOrder: null }, seedTrail("c-deep")))).toEqual(
			seedTrail("c-deep"),
		);
	});

	test("every writer MERGES into the entry rather than composing a fresh one", () => {
		// FIVE WRITERS, ONE SHAPE. A key added for one of them is silently absent
		// from the other four, and the loss only surfaces two traversals later as a
		// pager that has forgotten where it is — so none of them may compose an
		// object literal of its own.
		const entry = entryState({ ottaOrder: "o-1", hostKey: 7 }, { ottaOrder: null });
		expect(entry["hostKey"]).toBe(7);
		expect(entry["ottaOrder"]).toBeNull();
		// A writer with no opinion about the page leaves whatever is there alone.
		const walked = pushedPage(FIRST_PAGE, "c2");
		const carried = entryState(entryState(null, {}, walked), { ottaOrder: "o-9" });
		expect(readTrailState(carried)).toEqual(walked);
		// And one WITH an opinion states it.
		expect(readTrailState(entryState(carried, {}, FIRST_PAGE))).toEqual(FIRST_PAGE);
	});

	test("an entry with no stack, a malformed one, or a hostile one is a deep link", () => {
		// `history.state` is the same kind of input a URL is, and it is not a
		// trusted channel: anything sharing this document can write it, it survives
		// every reload, and it may have been written by an older build. A shape
		// that does not match is "no stack", never a throw inside a `popstate`
		// listener and never a value taken on faith.
		expect(readTrailState(null)).toBeNull();
		expect(readTrailState({ ottaOrder: null })).toBeNull();
		expect(readTrailState({ [PAGE_STATE_KEY]: { cursors: "c2", grounded: true } })).toBeNull();
		expect(readTrailState({ [PAGE_STATE_KEY]: { cursors: [1, 2], grounded: true } })).toBeNull();
		expect(readTrailState({ [PAGE_STATE_KEY]: { cursors: [""], grounded: true } })).toBeNull();
		expect(readTrailState({ [PAGE_STATE_KEY]: { cursors: [] } })).toBeNull();
		expect(readTrailState({ [PAGE_STATE_KEY]: "cursors" })).toBeNull();
		expect(readTrailState({ [PAGE_STATE_KEY]: [] })).toBeNull();
		expect(readTrailState("{}")).toBeNull();
		expect(readTrailState(JSON.parse('{"ottaPage":{"cursors":["c2"]}}'))).toBeNull();
		// A WELL-FORMED ONE IS COPIED, never aliased: the caller holds a value, not
		// a window onto an object whatever else shares this document can still
		// write.
		const shared = { [PAGE_STATE_KEY]: { cursors: ["c2"], grounded: true } };
		const read = readTrailState(shared);
		shared[PAGE_STATE_KEY].cursors.push("c3");
		expect(read?.cursors).toEqual(["c2"]);
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
	readonly orderId?: string;
	readonly filter?: { readonly status?: string };
}

let asked: Request[] = [];

/** A refusal, in the ONE shape every failure reaches this console as: a rejected
 *  token, an expired session, a 500 and a dead connection are all this value by
 *  the time a screen sees them. */
function refusal(subject: string, status = 500): Response {
	return envelope({
		ok: false,
		title: `${subject} (HTTP ${String(status)})`,
		description: "The request was not completed.",
	});
}

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
	// THE WINDOW, NOT ITS LAST PAGE: fifty rows beginning at page one are not
	// "Page 2", and an operator reading the top of that list would be told the
	// wrong number.
	expect(position(view, "orders")).toBe("Pages 1–2 of 6");
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

// ── the browser's own Back, and the pager ────────────────────────────────────

/** A REAL traversal, not a hand-dispatched `popstate`: `happy-dom` resolves the
 *  entry, moves the address and delivers the event, all asynchronously. */
async function traverse(direction: "back" | "forward"): Promise<void> {
	await React.act(async () => {
		if (direction === "back") window.history.back();
		else window.history.forward();
		await new Promise((resolve) => setTimeout(resolve, 25));
	});
	await settle();
}

test("browser Back mid-walk keeps the position AND a live Previous", async () => {
	/*
	 * THE DEFECT THIS CLOSES. The address carries one cursor, so a traversal used
	 * to land on a page with no stack behind it: the position fell to a dash and
	 * `Previous` dimmed, two presses into a scan, for no reason visible on screen.
	 * A history ENTRY is not a link, and can carry what a link must not.
	 */
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();
	await press(view, "orders-next");
	await settle();
	expect(position(view, "orders")).toBe("Page 3 of 6");

	await traverse("back");

	// STILL GROUNDED. The entry knew it was page two, so the pager does too.
	expect(position(view, "orders")).toBe("Page 2 of 6");
	expect(search().get("cursor")).toBe(PAGE_TWO);
	expect(element(view, "orders-prev").getAttribute("aria-disabled")).toBeNull();
	expect(element(view, "orders-prev").getAttribute("title")).toBeNull();
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 26, 50));

	// FORWARD RETURNS TO THE PAGE JUST LEFT, still knowing which one it is.
	await traverse("forward");
	expect(position(view, "orders")).toBe("Page 3 of 6");
	expect(element(view, "orders-prev").getAttribute("aria-disabled")).toBeNull();

	// AND PREVIOUS STILL WORKS from a traversed-to page, which is the half a
	// dashed position would have taken away. (It PUSHES, so it truncates the
	// forward entries — see the entry-kind test below.)
	await traverse("back");
	asked = [];
	await press(view, "orders-prev");
	await settle();
	expect(asked.at(-1)?.cursor).toBeUndefined();
	expect(position(view, "orders")).toBe("Page 1 of 6");
});

test("Previous onto page one PUSHES — it is a journey, not a correction", async () => {
	/*
	 * THE TWO MEANINGS THAT USED TO SHARE ONE VALUE. "No cursor" was read as "the
	 * list is correcting an address that would not open", which REPLACES the
	 * entry — right for a refused deep link, and wrong for an operator who
	 * deliberately stepped back, whose entry for the page they stepped FROM was
	 * being silently overwritten.
	 */
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();
	const depth = window.history.length;

	await press(view, "orders-prev");
	await settle();
	expect(search().get("cursor")).toBeNull();
	expect(window.history.length).toBe(depth + 1);

	// AND THE PAGE IT STEPPED FROM IS STILL BEHIND IT.
	await traverse("back");
	expect(search().get("cursor")).toBe(PAGE_TWO);
	expect(position(view, "orders")).toBe("Page 2 of 6");
});

test("a refused deep link still CORRECTS in place, entry and stack together", async () => {
	// The other half of the same discriminator: a page that would not open must
	// not bury the entry the operator is standing on under one they never asked
	// for, or their Back walks into the refused link they just arrived from.
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
	const depth = window.history.length;
	view = await mount(<OrdersScreen />);
	await settle();

	expect(window.history.length).toBe(depth);
	expect(search().get("cursor")).toBeNull();
	expect(position(view, "orders")).toBe("Page 1 of 6");
});

test("a FAILED Previous onto page one leaves the rows exactly where they are", async () => {
	/*
	 * THE ROWS ARE NOT DISPROVED BY THE MOVE THAT FAILED. `Previous` onto page one
	 * sends no cursor, and reading "was there a cursor?" as "was this a fresh
	 * load?" made this failure clear a screenful of rows that were still a true
	 * answer to the query that produced them — the exact opposite of the rule a
	 * failed `Load more` already follows.
	 */
	let calls = 0;
	serve((request) => {
		calls += 1;
		if (calls > 2) return refusal("Orders are unavailable", 500);
		return envelope({
			ok: true,
			orders:
				request.cursor === undefined ? ids("o", 1, 25).map(order) : ids("o", 26, 50).map(order),
			nextCursor: request.cursor === undefined ? PAGE_TWO : PAGE_THREE,
			total: 137,
			vocabulary: VOCABULARY,
		});
	});
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 26, 50));

	await press(view, "orders-prev");
	await settle();

	// THE ROWS STAND, and the refusal is drawn beside them rather than over the
	// space they used to occupy.
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 26, 50));
	expect(absent(view, "orders-load-more-failure")).toBe(false);
	expect(absent(view, "orders-failure")).toBe(true);
	// The filter panel and the count line are untouched, because nothing about
	// them was disproved either.
	expect(element(view, "orders-intro").textContent).toContain("137 orders");
});

test("an unavailable control carries its reason where a screen reader will read it", async () => {
	// `title` is a POINTER affordance; a described-by node is read out with the
	// control's name every time, by every screen reader, however the operator
	// arrived at it.
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();

	const previous = element(view, "orders-prev");
	const describedBy = previous.getAttribute("aria-describedby");
	expect(describedBy).not.toBeNull();
	const reason = view.container.querySelector(`#${CSS.escape(String(describedBy))}`);
	expect(reason?.textContent).toBe(PREVIOUS_AT_START_TITLE);
	expect(reason?.className).toContain("otta-sr-only");
	// The tooltip is a bonus, not the mechanism.
	expect(previous.getAttribute("title")).toBe(PREVIOUS_AT_START_TITLE);

	// AND AN AVAILABLE CONTROL DESCRIBES NOTHING — a permanent "you may press
	// this" would be read out on every visit and mean nothing.
	expect(element(view, "orders-next").getAttribute("aria-describedby")).toBeNull();
});

test("products: a pager step keeps the banner a settings blip raised", async () => {
	/*
	 * THE SHARPEST DEFECT THE PAGER INTRODUCED, and the reason the latch rides on
	 * the CONTINUATION rather than on the merge. `filterUnavailable` is page one's
	 * answer to "was the low-stock filter ever applied to what you are looking
	 * at"; every request carrying a cursor reports `false` by contract, because
	 * the predicate rode inside the opaque token. Reading that `false` as an
	 * answer drops the banner at the click of `Next` and starts captioning every
	 * product in the catalog as low stock.
	 */
	serve((request) => {
		const blind = { threshold: null, unreadable: false, filterUnavailable: true };
		const seeing = { threshold: 5, unreadable: false, filterUnavailable: false };
		return envelope(
			request.cursor === undefined
				? {
						ok: true,
						products: ids("p", 1, 25).map(product),
						nextCursor: PAGE_TWO,
						stock: blind,
						vocabulary: PRODUCTS_VOCABULARY,
					}
				: {
						ok: true,
						products: ids("p", 26, 50).map(product),
						nextCursor: PAGE_THREE,
						// The contractual `false` plus a total for the WHOLE catalog — the
						// pair that must not be believed on a continuation.
						total: 137,
						stock: seeing,
						vocabulary: PRODUCTS_VOCABULARY,
					},
		);
	});
	window.history.replaceState(null, "", "/products?low=1");
	view = await mount(<ProductsScreen />);
	await settle();
	expect(absent(view, "products-stock-degraded")).toBe(false);

	await press(view, "products-next");
	await settle();

	// THE BANNER STANDS, page one's answer intact.
	expect(rowIds(view, "products-row")).toEqual(ids("p", 26, 50));
	expect(absent(view, "products-stock-degraded")).toBe(false);
	// AND THE TOTAL IS STILL WITHHELD: 137 counts every product while the
	// merchant asked for the low-stock ones, so neither the caption nor the page
	// count may state it.
	expect(element(view, "products-intro").textContent).not.toContain("137");
	expect(position(view, "products")).toBe("Page 2 of —");
});

// ── what a request with NO cursor on the wire is ─────────────────────────────

/** Page one, page two, and a THIRD answer for the page-one request the pager
 *  makes on the way back — which is where the wire and the operator's intent
 *  can disagree. */
function servePageOneAgain(again: (call: number) => Record<string, unknown>): void {
	let call = 0;
	serve((request) => {
		call += 1;
		if (request.cursor === undefined && call > 1) {
			return envelope({ ok: true, vocabulary: VOCABULARY, ...again(call) });
		}
		return envelope({
			ok: true,
			orders:
				request.cursor === undefined ? ids("o", 1, 25).map(order) : ids("o", 26, 50).map(order),
			nextCursor: request.cursor === undefined ? PAGE_TWO : PAGE_THREE,
			total: 137,
			vocabulary: VOCABULARY,
		});
	});
}

test("Previous onto page one is PAGE ONE — the count may state the whole set", async () => {
	/*
	 * THE CLASSIFIER READS THE WIRE, NOT THE INTENT. A request carrying no cursor
	 * comes back as the first page under the current predicate, whoever asked for
	 * it. Calling it a `replace` because the OPERATOR asked for a page captioned a
	 * render that IS page one as `firstPage: false` — which puts the "on this
	 * page" hedge on a count this render can prove outright.
	 */
	servePageOneAgain(() => ({ orders: ids("o", 1, 3).map(order), nextCursor: null }));
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();

	await press(view, "orders-prev");
	await settle();

	// The collection shrank under the operator; page one is now three rows with
	// nothing behind it, and this render is entitled to say so without a hedge.
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 1, 3));
	expect(element(view, "orders-intro").textContent).toContain("3 orders ·");
	expect(element(view, "orders-intro").textContent).not.toContain("on this page");
});

test("Previous onto an EMPTY page one gets the whole-collection words, not the page-scoped ones", async () => {
	// The other half of the same `firstPage`. "Nothing on this page" is the copy
	// for a page that ran off the end; page one running empty is the collection
	// being empty, which is a different sentence with a different offer.
	servePageOneAgain(() => ({ orders: [], nextCursor: null }));
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();

	await press(view, "orders-prev");
	await settle();

	expect(absent(view, "orders-empty")).toBe(false);
	expect(absent(view, "orders-page-zero")).toBe(true);
});

/** Pages of products where the low-stock threshold can be made unreadable per
 *  request — the settings blip whose banner the latch exists for. */
function serveProductsBlips(blindOn: (call: number, cursor: string | undefined) => boolean): void {
	let call = 0;
	serve((request) => {
		call += 1;
		const blind = blindOn(call, request.cursor);
		return envelope({
			ok: true,
			products:
				request.cursor === undefined ? ids("p", 1, 25).map(product) : ids("p", 26, 50).map(product),
			nextCursor: request.cursor === undefined ? PAGE_TWO : PAGE_THREE,
			...(blind ? {} : { total: 137 }),
			stock: blind
				? { threshold: null, unreadable: false, filterUnavailable: true }
				: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: PRODUCTS_VOCABULARY,
		});
	});
}

test("products: Previous onto page one CLEARS a banner the blip has stopped causing", async () => {
	// THE LATCH MUST BE ABLE TO END. A banner that only a filter change could
	// dismiss would sit over a catalogue whose threshold has been readable for an
	// hour, and the merchant has no way to tell a stale warning from a live one.
	serveProductsBlips((call) => call === 1);
	window.history.replaceState(null, "", "/products?low=1");
	view = await mount(<ProductsScreen />);
	await settle();
	expect(absent(view, "products-stock-degraded")).toBe(false);

	await press(view, "products-next");
	await settle();
	// Still latched across the continuation — the contractual `false` is not an
	// answer.
	expect(absent(view, "products-stock-degraded")).toBe(false);

	await press(view, "products-prev");
	await settle();

	// PAGE ONE, ANSWERED AUTHORITATIVELY, and the threshold read fine this time.
	expect(absent(view, "products-stock-degraded")).toBe(true);
	// AND THE NOUN FOLLOWS THE LATCH (F29): the rows really are the low-stock
	// ones now, so they are named as such, and the exact count comes back with
	// them.
	expect(element(view, "products-intro").textContent).toContain("137 low-stock products");
});

test("products: a blip ON the Previous request RAISES the banner", async () => {
	// The same rule from the other side: page one may raise as well as clear, and
	// a request that carried no cursor is page one.
	serveProductsBlips((call) => call === 3);
	window.history.replaceState(null, "", "/products?low=1");
	view = await mount(<ProductsScreen />);
	await settle();
	expect(absent(view, "products-stock-degraded")).toBe(true);

	await press(view, "products-next");
	await settle();
	expect(absent(view, "products-stock-degraded")).toBe(true);

	await press(view, "products-prev");
	await settle();

	expect(absent(view, "products-stock-degraded")).toBe(false);
	// AND THE NOUN GOES BACK TO THE PLAIN ONE (F29). These rows are every
	// product, because the predicate never went out; calling twenty-five of them
	// "low-stock products" is the exact mislabel that ruling exists to prevent,
	// and it is what a latch read off a continuation produces here.
	const intro = element(view, "products-intro").textContent ?? "";
	expect(intro).toContain("25 products on this page");
	expect(intro).not.toContain("low-stock");
	expect(intro).not.toContain("137");
});

test("a deep link to the LAST page keeps its pager on screen", async () => {
	// The pure tier pins the predicate; this pins that a real screen renders it.
	// Neither control can move, which is exactly when the position is the only
	// thing that can answer the question that operator arrived with.
	serve(() =>
		envelope({
			ok: true,
			orders: ids("o", 126, 137).map(order),
			nextCursor: null,
			total: 137,
			vocabulary: VOCABULARY,
		}),
	);
	window.history.replaceState(null, "", `/orders?cursor=${encodeURIComponent(PAGE_THREE)}`);
	view = await mount(<OrdersScreen />);
	await settle();

	expect(absent(view, "orders-pager")).toBe(false);
	expect(element(view, "orders-prev").getAttribute("aria-disabled")).toBe("true");
	expect(element(view, "orders-next").getAttribute("aria-disabled")).toBe("true");
	expect(position(view, "orders")).toBe("Page — of 6");
});

// ── the record drill-in carries the page too ─────────────────────────────────

/** The list fake plus the one record the drill-in opens. */
function serveOrdersWithDetail(): void {
	serve((request) => {
		if (request.resource === "orders.detail") {
			return envelope({
				ok: true,
				order: {
					id: String(request.orderId),
					state: "paid",
					currency: "USD",
					paymentMethod: null,
					buyerRef: "buyer@example.test",
					customerId: null,
					createdAt: "2026-01-01T00:00:00.000Z",
					reconciliationFlag: null,
					reconciliationResolution: null,
					fulfillment: null,
					cancellation: null,
					shippingAddress: null,
					totals: {
						currency: "USD",
						subtotalCents: 1234,
						discountCents: 0,
						shippingCents: 0,
						taxCents: 0,
						totalCents: 1234,
						appliedCouponCode: null,
					},
					lines: [],
				},
				transitions: [],
				customer: null,
				timeline: null,
				refunds: null,
				notes: [],
				vocabulary: VOCABULARY,
			});
		}
		const first = request.cursor === undefined;
		return envelope({
			ok: true,
			orders: first ? ids("o", 1, 25).map(order) : ids("o", 26, 50).map(order),
			nextCursor: first ? PAGE_TWO : PAGE_THREE,
			total: 137,
			vocabulary: VOCABULARY,
		});
	});
}

test("a record opened from page two, RELOADED, comes back to a list that knows its page", async () => {
	/*
	 * THE ENTRY THE DRILL-IN PUSHES IS A LIST ENTRY WEARING A RECORD'S ADDRESS,
	 * and it has to carry the list's stack: the operator opened this record FROM
	 * page two. Composing that entry from `{ottaOrder: id}` alone — which is what
	 * it did — dropped the walk one click after it was earned, so `Back to orders`
	 * from a reloaded record landed on a page that could not name itself.
	 */
	serveOrdersWithDetail();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();
	expect(position(view, "orders")).toBe("Page 2 of 6");

	await fire(element(view, "order-link"), "click");
	await settle();
	expect(search().get("order")).toBe("o-26");

	// A RELOAD: the document goes and comes back on the same entry, which is what
	// `history.state` is for.
	await view.unmount();
	view = await mount(<OrdersScreen />);
	await settle();
	expect(absent(view, "orders-back")).toBe(false);

	// `Back to orders` on a mount that pushed nothing REPLACES the address rather
	// than popping — and must not take the stack with it.
	await press(view, "orders-back");
	await settle();
	expect(position(view, "orders")).toBe("Page 2 of 6");
	expect(element(view, "orders-prev").getAttribute("aria-disabled")).toBeNull();
});

test("Back and Forward around a record keep the list's position", async () => {
	serveOrdersWithDetail();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();

	await fire(element(view, "order-link"), "click");
	await settle();

	await traverse("back");
	expect(absent(view, "orders-pager")).toBe(false);
	expect(position(view, "orders")).toBe("Page 2 of 6");
	expect(element(view, "orders-prev").getAttribute("aria-disabled")).toBeNull();

	await traverse("forward");
	expect(search().get("order")).toBe("o-26");

	await traverse("back");
	expect(position(view, "orders")).toBe("Page 2 of 6");
});

/**
 * A REFRESH IS NOT A PAGE MOVE, and the pager is where that shows.
 *
 * The window an operator reached by PAGING is one page wide, so refreshing it is
 * one request — the page they are on, re-read — and everything the pager knows
 * about where they are has to survive it: the number, the walk behind it, and the
 * address. A refresh that pushed a history entry, renumbered the page or dropped
 * the stack would be a navigation wearing a refresh's label.
 */
test("a refresh of a paged window re-reads that page alone and keeps the walk behind it", async () => {
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();
	await press(view, "orders-next");
	await settle();
	expect(position(view, "orders")).toBe("Page 3 of 6");
	const entries = window.history.length;
	asked = [];

	await press(view, "orders-refresh");
	await settle();

	// ONE REQUEST, FOR THE PAGE ON SCREEN. A window reached by paging is one
	// response wide; walking three pages from page one would re-read two pages
	// nobody is looking at and land on rows that are not these.
	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBe(PAGE_THREE);
	expect(rowIds(view, "orders-row").at(0)).toBe("o-51");
	expect(position(view, "orders")).toBe("Page 3 of 6");
	// The address still names the same page, and no entry was pushed to say so:
	// the operator did not go anywhere.
	expect(search().get("cursor")).toBe(PAGE_THREE);
	expect(window.history.length).toBe(entries);

	// AND THE STACK BEHIND IT IS INTACT — those pages were never re-read, so their
	// boundaries were never re-derived, and `Previous` still goes where it went.
	expect(element(view, "orders-prev").getAttribute("aria-disabled")).toBeNull();
	await press(view, "orders-prev");
	await settle();
	expect(position(view, "orders")).toBe("Page 2 of 6");
	expect(rowIds(view, "orders-row").at(0)).toBe("o-26");
});

/**
 * A REFRESHED DEEP PAGE IS STILL A DEEP PAGE.
 *
 * The first response of a walk is classified off the WIRE — a request that carried
 * no token is page one, one that carried the window's anchor is not. Reading it off
 * the walk's GROUNDING instead conflates two different facts: grounding says the
 * page NUMBER is knowable, and an operator three `Next` presses in is grounded and
 * standing on page three. Both consequences of getting that wrong are captions.
 */
test("a refreshed last page keeps the page-scoped hedge instead of claiming the whole set", async () => {
	// No `total` on the wire, so the count line is this render's own claim about its
	// own rows — which is exactly where a wrong `firstPage` shows up.
	serveOrders({});
	view = await mount(<OrdersScreen />);
	await settle();
	for (let step = 0; step < 3; step += 1) {
		await press(view, "orders-next");
		await settle();
	}
	expect(element(view, "orders-intro").textContent).toContain("25 orders on this page");

	await press(view, "orders-refresh");
	await settle();

	// `firstPage: true` here would drop the hedge — a last page with nothing after
	// it and nothing before it is a COMPLETE collection — and state 25 rows as the
	// whole of Orders.
	expect(rowIds(view, "orders-row").at(0)).toBe("o-76");
	expect(element(view, "orders-intro").textContent).toContain("25 orders on this page");
});

test("a refreshed deep page that comes back empty says so about the page, not the collection", async () => {
	let secondPageReads = 0;
	serve((request) => {
		const body = (orders: readonly unknown[], nextCursor: string | null) =>
			envelope({ ok: true, orders, nextCursor, vocabulary: VOCABULARY });
		if (request.cursor === undefined) return body(ids("o", 1, 25).map(order), PAGE_TWO);
		secondPageReads += 1;
		// The rows are gone by the time the refresh asks for them again.
		return body(secondPageReads > 1 ? [] : ids("o", 26, 50).map(order), null);
	});
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-next");
	await settle();
	expect(rowIds(view, "orders-row")).toHaveLength(25);

	await press(view, "orders-refresh");
	await settle();

	// PAGE-SCOPED WORDS, because this render is page two of something. The
	// whole-collection empty state would tell an operator there are no orders at
	// all, standing on a page they reached by paging past twenty-five of them.
	expect(absent(view, "orders-page-zero")).toBe(false);
	expect(absent(view, "orders-empty")).toBe(true);
});
