/**
 * @vitest-environment happy-dom
 *
 * THE PAGE IS PART OF THE ADDRESS — proven by mounting the real screens
 * from real addresses and reading back what went on the wire.
 *
 * WHY A DOCUMENT IS THE ONLY TIER THAT CAN SETTLE THIS. The encode/decode half
 * is pure and is pinned next door in `url-state.test.ts`; what a pure test
 * cannot see is the seam this increment is actually about — the FIRST request a
 * mount issues. A cursor decoded from a URL has no filter object behind it,
 * while `PendingCursor` pairs a cursor with the REFERENCE of the filter it was
 * issued under, so a seed bound to the wrong object degrades every deep link
 * into a silent first-page reload that no assertion about strings would notice.
 * The proof is `asked[0].cursor`, and only a mounted screen produces it.
 *
 * WHAT A RELOAD RESTORES, STATED ONCE. The address carries the CURRENT page's
 * cursor — the last continuation the list applied — and a reload restores THAT
 * PAGE, not the accumulated stack of pages an operator scrolled through to
 * reach it. Deliberate: the cursor is one opaque token, an accumulated scan is N
 * of them, and a link that replays N requests is a different feature. Restoring
 * the accumulation belongs to the refresh-semantics work, not here.
 *
 * `happy-dom` TRACKS A REAL SESSION HISTORY for same-document navigations —
 * `pushState`, `back`, `forward` and the `popstate` they deliver all agree with
 * it — which is what lets the Back/Forward walk below be a real traversal rather
 * than a hand-dispatched event. (`url-state.test.ts` says history traversal
 * cannot be modelled outside a browser; that is about the multi-entry,
 * cross-document cases, and `products-back-history-dom.test.tsx` already relies
 * on the same single-document guarantee used here.)
 *
 * EVERY RESPONSE IS SERVED HERE, refusals included, so the refused-cursor case
 * is a transition this file chooses rather than an environment it has to
 * arrange.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CURSOR_RESET_DESCRIPTION, CURSOR_RESET_TITLE } from "../src/accumulate.js";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrdersScreen } = await import("../src/orders/orders-screen.js");
const { ProductsScreen } = await import("../src/products/products-screen.js");

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

/**
 * THE TOKENS THE SERVICE IN THIS FILE ISSUED, in the shape the real one issues:
 * base64URL of `{pos, filter, limit}`, `+`/`/` mapped to `-`/`_` and the padding
 * stripped. Anything else this fake refuses — the route decodes a token,
 * re-validates the filter inside it through zod and re-clamps the limit, all
 * failing closed to a 400, and that is what a console is entitled to rely on
 * when it puts a token in a public address.
 */
function token(payload: unknown): string {
	return btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PAGE_TWO = token({
	pos: { createdAt: "2026-03-02T10:20:00.000Z", id: "o-20" },
	filter: {},
	limit: 20,
});
const PAGE_THREE = token({
	pos: { createdAt: "2026-03-02T10:40:00.000Z", id: "o-40" },
	filter: {},
	limit: 20,
});

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
	readonly filter?: { readonly status?: string; readonly lowStock?: boolean };
}

/** Every request this run has been asked, in order — the record that tells a
 *  seeded continuation from a first page, and a single reset from a loop. */
let asked: Request[] = [];

function serve(handler: (request: Request) => Response): void {
	apiFetch.mockImplementation((_input, init) => {
		const request = JSON.parse(String(init?.body ?? "{}")) as Request;
		asked.push(request);
		return Promise.resolve(handler(request));
	});
}

/** A refusal, in the ONE shape every failure reaches this console as — which is
 *  exactly why the reset branch cannot diagnose: a rejected token, an expired
 *  session, a 500 and a dead connection are this same value. */
function refusal(subject: string, status = 400): Response {
	return envelope({
		ok: false,
		title: `${subject} (HTTP ${String(status)})`,
		description: "The request was not completed.",
	});
}

/** Three pages of orders, each reachable only with the previous page's token,
 *  plus a minimal record for the drill-in composition test. */
function serveOrders(): void {
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
		if (request.cursor === undefined) {
			return envelope({
				ok: true,
				orders: ids("o", 1, 20).map(order),
				nextCursor: PAGE_TWO,
				vocabulary: VOCABULARY,
			});
		}
		if (request.cursor === PAGE_TWO) {
			return envelope({
				ok: true,
				orders: ids("o", 21, 40).map(order),
				nextCursor: PAGE_THREE,
				vocabulary: VOCABULARY,
			});
		}
		return refusal("Orders are unavailable");
	});
}

function serveProducts(): void {
	serve((request) => {
		const stock = { threshold: 5, unreadable: false, filterUnavailable: false };
		if (request.resource === "products.detail") {
			return envelope({
				ok: true,
				product: {
					productId: "p-1",
					sku: "SKU-p-1",
					title: "Product p-1",
					priceCents: 900,
					currency: "USD",
					taxClass: null,
					compareAtCents: null,
					compareAtCurrency: null,
					unitCostCents: null,
					unitCostCurrency: null,
					inventoryPolicy: "deny",
					weightGrams: null,
					lengthMm: null,
					widthMm: null,
					heightMm: null,
					productKind: "physical",
					active: true,
					deletedAt: null,
					onHand: 4,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-02T00:00:00.000Z",
				},
				taxClasses: [],
				threshold: 5,
				vocabulary: PRODUCTS_VOCABULARY,
			});
		}
		if (request.cursor === undefined) {
			return envelope({
				ok: true,
				products: ids("p", 1, 3).map(product),
				nextCursor: PAGE_TWO,
				stock,
				vocabulary: PRODUCTS_VOCABULARY,
			});
		}
		if (request.cursor === PAGE_TWO) {
			return envelope({
				ok: true,
				products: ids("p", 4, 6).map(product),
				nextCursor: PAGE_THREE,
				stock,
				vocabulary: PRODUCTS_VOCABULARY,
			});
		}
		return refusal("Pricing & inventory is unavailable");
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

/** Settle the request the last interaction issued. Two rounds, because the
 *  response lands through a promise chain the first flush does not outlive. */
async function settle(): Promise<void> {
	for (let round = 0; round < 3; round += 1) {
		await React.act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

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
	// A clean address for the next test — a leftover entry must not seed the next
	// one's Back/Forward.
	window.history.replaceState(null, "", "/");
});

// ── the address gains a page ─────────────────────────────────────────────────

test("paging puts the page in the address, and the rows already read stay on screen", async () => {
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();
	expect(search().get("cursor")).toBeNull();

	await press(view, "orders-load-more");
	await settle();

	// THE TOKEN, VERBATIM. It is round-tripped through the encoder, so the `+`
	// and `/` in it survive rather than decoding back as a space.
	expect(search().get("cursor")).toBe(PAGE_TWO);
	// AND THE ACCUMULATION IS UNTOUCHED: writing the address is a history write,
	// not a remount, so the 20 rows the operator was reading are still there.
	expect(rowIds(view, "orders-row")).toHaveLength(40);
});

test("a reload of that address lands on THAT page, not on page one", async () => {
	serveOrders();
	window.history.replaceState(null, "", `/orders?cursor=${encodeURIComponent(PAGE_TWO)}`);
	view = await mount(<OrdersScreen />);
	await settle();

	// THE SEED, AND THE WHOLE HAZARD: the FIRST request of the mount carries the
	// decoded token. A `PendingCursor` bound to anything but the filter object
	// this mount applies would be refused as stale and this would be `undefined`
	// — a deep link degraded into a first-page reload, silently.
	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBe(PAGE_TWO);
	// THAT PAGE, not the stack behind it: page two's rows alone. The accumulated
	// scan is not what a cursor describes.
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 21, 40));
	expect(absent(view, "orders-cursor-reset")).toBe(true);
});

test("the filter and the page travel together, in one address", async () => {
	serveOrders();
	window.history.replaceState(
		null,
		"",
		`/orders?status=paid&cursor=${encodeURIComponent(PAGE_TWO)}`,
	);
	view = await mount(<OrdersScreen />);
	await settle();

	expect(asked[0]?.filter?.status).toBe("paid");
	expect(asked[0]?.cursor).toBe(PAGE_TWO);
	// The panel shows WHY the list holds these rows, exactly as a filtered deep
	// link without a cursor does.
	expect(element(view, "orders-filter-summary").textContent).toContain("status: paid");
});

test("an EMPTY cursor parameter is page one — absent and empty are not two states", async () => {
	serveOrders();
	window.history.replaceState(null, "", "/orders?cursor=");
	view = await mount(<OrdersScreen />);
	await settle();

	expect(asked[0]?.cursor).toBeUndefined();
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 1, 20));
});

// ── Back and Forward walk the pages ──────────────────────────────────────────

test("Back returns to the previous page and Forward returns to the one just left", async () => {
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-load-more");
	await settle();
	expect(search().get("cursor")).toBe(PAGE_TWO);

	// BACK. A page is a place, so paging PUSHED an entry — which is the only
	// reason there is anything here to come back from.
	await traverse("back");
	expect(search().get("cursor")).toBeNull();
	expect(asked.at(-1)?.cursor).toBeUndefined();
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 1, 20));

	// FORWARD, onto the page the operator actually visited.
	await traverse("forward");
	expect(search().get("cursor")).toBe(PAGE_TWO);
	expect(asked.at(-1)?.cursor).toBe(PAGE_TWO);
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 21, 40));
});

test("opening a record from a paged list keeps the page, and Back returns to it", async () => {
	// THE COMPOSITION: `?cursor=` and `?order=` share one address, and the
	// drill-in must not drop the page the list was on — otherwise Back out of a
	// record lands on page one of a scan the operator was twenty rows into.
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-load-more");
	await settle();

	// The identity cell's link, which is the row's own way in — a bare click on
	// the row itself is refused by the drag guard without a preceding mousedown.
	await fire(element(view, "order-link"), "click");
	await settle();
	expect(search().get("order")).toBe("o-1");
	expect(search().get("cursor")).toBe(PAGE_TWO);

	await traverse("back");
	expect(search().get("order")).toBeNull();
	expect(search().get("cursor")).toBe(PAGE_TWO);
	// The list is rebuilt from the address, so it comes back at the page the
	// address names rather than at page one.
	expect(asked.at(-1)?.cursor).toBe(PAGE_TWO);
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 21, 40));
});

test("applying a filter takes the page OUT of the address", async () => {
	serveOrders();
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-load-more");
	await settle();
	expect(search().get("cursor")).toBe(PAGE_TWO);

	await React.act(async () => {
		retype(element(view as Mounted, "filter-status") as HTMLSelectElement, "failed");
	});
	await press(view, "apply-filters");
	await settle();

	// A filter change is page one of a NEW set — the list clears its cursor, and
	// the address has to say the same thing or a reload would replay a page of
	// the predicate the operator just left.
	expect(search().get("cursor")).toBeNull();
	expect(search().get("status")).toBe("failed");
	expect(asked.at(-1)?.cursor).toBeUndefined();
	expect(asked.at(-1)?.filter?.status).toBe("failed");
});

// ── an address the service will not honour ───────────────────────────────────

test("a cursor the service refuses resets to page one, legibly, and exactly once", async () => {
	serveOrders();
	window.history.replaceState(null, "", "/orders?status=paid&cursor=tampered");
	const depthOnArrival = window.history.length;
	view = await mount(<OrdersScreen />);
	await settle();

	// TWO REQUESTS, NEVER MORE. The seeded continuation was refused, so the list
	// drops the cursor and asks for page one of the SAME filters. A retry loop
	// here is the failure mode this guard exists to prevent.
	expect(asked).toHaveLength(2);
	expect(asked[0]?.cursor).toBe("tampered");
	expect(asked[1]?.cursor).toBeUndefined();
	expect(asked[1]?.filter?.status).toBe("paid");

	// AND THE OPERATOR IS LOOKING AT A LIST, not at a dead error pane: rows, the
	// filter panel, and one sentence saying why they are not where the link said.
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 1, 20));
	expect(absent(view, "orders-failure")).toBe(true);

	// THE SENTENCE ITSELF, verbatim from the constants — so a reword has to be a
	// deliberate edit here too, and so the two screens cannot drift apart on copy
	// that explains the same mechanism.
	const notice = element(view, "orders-cursor-reset");
	expect(notice.textContent).toContain(CURSOR_RESET_TITLE);
	expect(notice.textContent).toContain(CURSOR_RESET_DESCRIPTION);
	// IT STATES NO CAUSE. This tier cannot tell a rejected token from an expired
	// session, and copy that named one would send an operator to fix the wrong
	// thing in the confident voice of a screen that had diagnosed something.
	expect(notice.textContent).not.toMatch(/expired|invalid|tampered|edited|shared before/i);

	// AND IT IS ANNOUNCED. A live region inserted with its text already in place
	// is the one case assistive technology may skip, and this one arrives unbidden
	// with nothing to click, so focus is handed to it.
	expect(document.activeElement).toBe(notice);

	// THE ADDRESS IS CORRECTED IN PLACE — and REPLACED, never pushed. A push would
	// bury the entry the operator is standing on under one they never asked for,
	// so their Back would walk into the refused link they just arrived from.
	expect(search().get("cursor")).toBeNull();
	expect(search().get("status")).toBe("paid");
	expect(window.history.length).toBe(depthOnArrival);
});

test("the reset notice is withdrawn once the operator pages again", async () => {
	serveOrders();
	window.history.replaceState(null, "", "/orders?cursor=tampered");
	view = await mount(<OrdersScreen />);
	await settle();
	expect(absent(view, "orders-cursor-reset")).toBe(false);

	await press(view, "orders-load-more");
	await settle();

	// The sentence is about the ARRIVAL. Once the operator has moved on under
	// their own steam it describes nothing on screen.
	expect(absent(view, "orders-cursor-reset")).toBe(true);
	expect(search().get("cursor")).toBe(PAGE_TWO);
});

test("a failure that is NOT the token leaves the page in the address, for a reload to restore", async () => {
	/*
	 * THE CASE THE FIRST CUT GOT WRONG. Every failure reaches this console as one
	 * shape, so the reset branch cannot tell a token the route rejected from a
	 * session that expired, a 500, or a laptop that went offline — and the first
	 * cut rewrote the address the moment ANY of them arrived, deleting the only
	 * record of where the operator was. Sign back in, reload, and you silently
	 * landed on page one.
	 *
	 * The fallback to page one still happens (it is the right answer either way),
	 * but the ADDRESS is only corrected once a request actually succeeds. Here
	 * nothing does, so the link the operator followed is still intact and still
	 * reloadable — which is the whole difference.
	 */
	serve(() => refusal("Orders are unavailable", 401));
	window.history.replaceState(
		null,
		"",
		`/orders?status=paid&cursor=${encodeURIComponent(PAGE_TWO)}`,
	);
	view = await mount(<OrdersScreen />);
	await settle();

	expect(asked).toHaveLength(2);
	expect(asked[0]?.cursor).toBe(PAGE_TWO);
	expect(asked[1]?.cursor).toBeUndefined();
	// The cold-failure card is what the operator gets, with the service's own
	// words — the reset notice does not sit on top of it describing a list that
	// is not there.
	expect(element(view, "orders-failure").textContent).toContain("Orders are unavailable");
	expect(absent(view, "orders-cursor-reset")).toBe(true);
	// AND THE PAGE IS STILL IN THE ADDRESS.
	expect(search().get("cursor")).toBe(PAGE_TWO);
	expect(search().get("status")).toBe("paid");
});

test("the address is corrected only AFTER the fallback page one lands", async () => {
	// The other half of the same rule, from the recoverable direction: the first
	// request is refused, the second succeeds, and only then does the address stop
	// naming a page the operator is no longer on.
	let calls = 0;
	serve((request) => {
		calls += 1;
		if (request.cursor !== undefined) return refusal("Orders are unavailable");
		return envelope({
			ok: true,
			orders: ids("o", 1, 20).map(order),
			nextCursor: PAGE_TWO,
			vocabulary: VOCABULARY,
		});
	});
	window.history.replaceState(null, "", `/orders?cursor=${encodeURIComponent(PAGE_THREE)}`);
	view = await mount(<OrdersScreen />);
	await settle();

	expect(calls).toBe(2);
	expect(search().get("cursor")).toBeNull();
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 1, 20));
});

// ── the same rules on Pricing & inventory ────────────────────────────────────

test("products: a deep-linked page is the page that loads, filter and all", async () => {
	serveProducts();
	window.history.replaceState(null, "", `/products?low=1&cursor=${encodeURIComponent(PAGE_TWO)}`);
	view = await mount(<ProductsScreen />);
	await settle();

	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBe(PAGE_TWO);
	expect(asked[0]?.filter?.lowStock).toBe(true);
	expect(rowIds(view, "products-row")).toEqual(ids("p", 4, 6));
});

test("products: paging writes the address, and Back walks it", async () => {
	serveProducts();
	window.history.replaceState(null, "", "/products");
	view = await mount(<ProductsScreen />);
	await settle();

	await press(view, "products-load-more");
	await settle();
	expect(search().get("cursor")).toBe(PAGE_TWO);
	expect(rowIds(view, "products-row")).toHaveLength(6);

	await traverse("back");
	expect(search().get("cursor")).toBeNull();
	expect(asked.at(-1)?.cursor).toBeUndefined();
	expect(rowIds(view, "products-row")).toEqual(ids("p", 1, 3));
});

test("products: a cursor the service refuses resets to page one, legibly, and exactly once", async () => {
	serveProducts();
	window.history.replaceState(null, "", "/products?low=1&cursor=tampered");
	const depthOnArrival = window.history.length;
	view = await mount(<ProductsScreen />);
	await settle();

	expect(asked).toHaveLength(2);
	expect(asked[0]?.cursor).toBe("tampered");
	expect(asked[1]?.cursor).toBeUndefined();
	expect(asked[1]?.filter?.lowStock).toBe(true);
	expect(rowIds(view, "products-row")).toEqual(ids("p", 1, 3));
	expect(absent(view, "products-failure")).toBe(true);

	// THE SAME SENTENCE, from the same constants, announced the same way — the two
	// screens explain one mechanism and must not drift.
	const notice = element(view, "products-cursor-reset");
	expect(notice.textContent).toContain(CURSOR_RESET_TITLE);
	expect(notice.textContent).toContain(CURSOR_RESET_DESCRIPTION);
	expect(document.activeElement).toBe(notice);

	// Corrected in place, never pushed.
	expect(search().get("cursor")).toBeNull();
	expect(search().get("low")).toBe("1");
	expect(window.history.length).toBe(depthOnArrival);
});

test("products: a failure that is NOT the token leaves the page in the address", async () => {
	serve(() => refusal("Pricing & inventory is unavailable", 500));
	window.history.replaceState(null, "", `/products?low=1&cursor=${encodeURIComponent(PAGE_TWO)}`);
	view = await mount(<ProductsScreen />);
	await settle();

	expect(asked).toHaveLength(2);
	expect(asked[1]?.cursor).toBeUndefined();
	expect(absent(view, "products-cursor-reset")).toBe(true);
	expect(search().get("cursor")).toBe(PAGE_TWO);
});

test("products: opening a record from a paged list keeps the page, and Back returns to it", async () => {
	// The Products screen carries history machinery Orders does not — the
	// unsaved-work guard, the recorded detail address, the pasted-link
	// discriminator — so the drill-in composition is proven here as well as there
	// rather than assumed to behave the same.
	serveProducts();
	window.history.replaceState(null, "", "/products");
	view = await mount(<ProductsScreen />);
	await settle();
	await press(view, "products-load-more");
	await settle();
	expect(search().get("cursor")).toBe(PAGE_TWO);

	await fire(element(view, "product-link"), "click");
	await settle();
	expect(search().get("product")).toBe("p-1");
	expect(search().get("cursor")).toBe(PAGE_TWO);

	await traverse("back");
	expect(search().get("product")).toBeNull();
	expect(search().get("cursor")).toBe(PAGE_TWO);
	expect(asked.at(-1)?.cursor).toBe(PAGE_TWO);
	expect(rowIds(view, "products-row")).toEqual(ids("p", 4, 6));
});
