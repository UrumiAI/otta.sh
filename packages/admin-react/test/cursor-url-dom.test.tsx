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
import {
	CURSOR_RESET_DESCRIPTION,
	CURSOR_RESET_TITLE,
	PAGING_STOPPED_DESCRIPTION,
	PAGING_STOPPED_TITLE,
} from "../src/accumulate.js";
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
 *  exactly why the console may not diagnose one: a rejected token, an expired
 *  session, a 500 and a dead connection are all this same value, and only the
 *  plugin's client (which can read the service's refusal code) can tell them
 *  apart. */
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
		// A CURSOR THE SERVICE REFUSED — mismatched against the filters beside it,
		// or undecodable. The plugin performs the prescribed recovery (drop the
		// token, re-issue page one) before answering, so what the console receives
		// is a real FIRST PAGE carrying the fact that it did not get the page it
		// asked for. One console request, not two.
		return envelope({
			ok: true,
			orders: ids("o", 1, 20).map(order),
			nextCursor: PAGE_TWO,
			cursorRejected: true,
			vocabulary: VOCABULARY,
		});
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
		// A refused cursor, already recovered from by the plugin — page one's rows
		// plus the fact. See the Orders fake above.
		return envelope({
			ok: true,
			products: ids("p", 1, 3).map(product),
			nextCursor: PAGE_TWO,
			cursorRejected: true,
			stock,
			vocabulary: PRODUCTS_VOCABULARY,
		});
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

	// ONE CONSOLE REQUEST, carrying the filters AND the page it was told to open —
	// which is the pairing that lets the service notice the disagreement at all.
	// The page-one recovery happens below this tier, so a retry loop is not even
	// expressible here.
	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBe("tampered");
	expect(asked[0]?.filter?.status).toBe("paid");

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

test("a failure leaves the page in the address, for a reload to restore", async () => {
	/*
	 * THE CASE THE FIRST CUT GOT WRONG, twice over.
	 *
	 * Every failure reaches this console in ONE shape, so the screen cannot tell a
	 * token the route rejected from a session that expired, a 500, or a laptop
	 * that went offline — and the first cut reset the page and rewrote the address
	 * the moment ANY of them arrived, deleting the only record of where the
	 * operator was. Sign back in, reload, and you silently landed on page one.
	 *
	 * A FAILURE NOW RESETS NOTHING. The refused-cursor case does not arrive here
	 * as a failure at all: the plugin's client reads the service's own refusal
	 * code, performs the page-one recovery and reports it as a successful page
	 * (the test above). So everything that DOES arrive as a failure keeps the
	 * cursor — in state and in the address — and the link the operator followed is
	 * still intact and still reloadable.
	 */
	serve(() => refusal("Orders are unavailable", 401));
	window.history.replaceState(
		null,
		"",
		`/orders?status=paid&cursor=${encodeURIComponent(PAGE_TWO)}`,
	);
	view = await mount(<OrdersScreen />);
	await settle();

	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBe(PAGE_TWO);
	expect(element(view, "orders-failure").textContent).toContain("Orders are unavailable");
	expect(absent(view, "orders-cursor-reset")).toBe(true);
	// AND THE PAGE IS STILL IN THE ADDRESS.
	expect(search().get("cursor")).toBe(PAGE_TWO);
	expect(search().get("status")).toBe("paid");
});

test("the address correction ARRIVES WITH the rows it describes", async () => {
	// The other half of the same rule. The address stops naming a page only in the
	// same transition that puts page one on screen — never speculatively, on a
	// response that might yet turn out to be an outage.
	serveOrders();
	window.history.replaceState(null, "", `/orders?cursor=${encodeURIComponent(PAGE_THREE)}`);
	view = await mount(<OrdersScreen />);
	await settle();

	expect(asked).toHaveLength(1);
	expect(search().get("cursor")).toBeNull();
	expect(rowIds(view, "orders-row")).toEqual(ids("o", 1, 20));
	// AND IT IS PAGE ONE, not a continuation that merged onto nothing: the count
	// line is the page's own, and `Load more` is offered from the top again.
	expect(element(view, "orders-intro").textContent).toContain("20 orders on this page");
});

/**
 * A REFUSAL MID-SCAN COSTS SOMETHING A REFUSAL ON ARRIVAL DOES NOT, and the two
 * are answered differently for that reason alone. The condition is identical —
 * the service would not continue from this token — but on arrival there is
 * nothing to lose, and twenty rows in there is a scan the operator built.
 */
test("a refusal MID-SCAN keeps the accumulated pages and stops paging", async () => {
	let call = 0;
	serve((request) => {
		call += 1;
		if (request.cursor === undefined) {
			return envelope({
				ok: true,
				orders: ids("o", 1, 20).map(order),
				nextCursor: PAGE_TWO,
				vocabulary: VOCABULARY,
			});
		}
		if (call === 2) {
			return envelope({
				ok: true,
				orders: ids("o", 21, 40).map(order),
				nextCursor: PAGE_THREE,
				vocabulary: VOCABULARY,
			});
		}
		// The third request — a `Load more` from page two — is refused, and the
		// plugin's page-one recovery answers it with rows 1–20 and the flag.
		return envelope({
			ok: true,
			orders: ids("o", 1, 20).map(order),
			nextCursor: PAGE_TWO,
			cursorRejected: true,
			vocabulary: VOCABULARY,
		});
	});

	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-load-more");
	await settle();
	const accumulated = rowIds(view, "orders-row");
	expect(accumulated).toHaveLength(40);

	await press(view, "orders-load-more");
	await settle();

	// THE SCAN SURVIVES, UNREORDERED. The retry's page-one rows are discarded
	// rather than merged: merging them would move rows the operator scrolled past
	// twenty rows ago, and replacing with them would delete the scan outright.
	expect(rowIds(view, "orders-row")).toEqual(accumulated);
	// AND THE COUNT KEEPS ITS HEDGE. There really is more out there; withdrawing
	// the control is not the same as proving the collection ended here.
	expect(element(view, "orders-intro").textContent).toContain("40 orders loaded so far");

	// PAGING IS OVER until a filter or a reload starts a fresh scan.
	expect(absent(view, "orders-load-more")).toBe(true);
	const notice = element(view, "orders-paging-stopped");
	expect(notice.textContent).toContain(PAGING_STOPPED_TITLE);
	expect(notice.textContent).toContain(PAGING_STOPPED_DESCRIPTION);
	expect(notice.textContent).not.toMatch(/expired|invalid|refused|tampered/i);
	// IT IS NOT THE ARRIVAL NOTICE, and it does not steal focus: the operator's
	// hands are on the page.
	expect(absent(view, "orders-cursor-reset")).toBe(true);
	expect(document.activeElement).not.toBe(notice);

	// THE DEAD PAGE LEAVES THE ADDRESS — it names somewhere this screen can no
	// longer go — without pushing an entry for a journey nobody took.
	expect(search().get("cursor")).toBeNull();
});

test("a refusal on a scan that has matched NOTHING yet withdraws the note with the button", async () => {
	/*
	 * THE EDGE THE SPLIT INTRODUCED. A scan whose pages have matched nothing yet
	 * renders no rows and no empty state — it renders the SCAN NOTE, whose whole
	 * content is an instruction to press `Load more`, because a zero-row page with
	 * a cursor behind it is not the end of anything.
	 *
	 * The cursor is deliberately KEPT when paging stops (it is this render's
	 * evidence that more exists, and nulling it would state the accumulated rows as
	 * the whole set), so `hasNext` stays true and that branch stays live at exactly
	 * the moment its advice stops being true — printing "Load more scans further"
	 * directly above a notice explaining that paging has stopped.
	 */
	let call = 0;
	serve(() => {
		call += 1;
		const empty = { ok: true, orders: [], nextCursor: PAGE_TWO, vocabulary: VOCABULARY };
		return envelope(call === 1 ? empty : { ...empty, cursorRejected: true });
	});
	view = await mount(<OrdersScreen />);
	await settle();
	// A scan in progress with nothing matched: the note, and the button it names.
	expect(rowIds(view, "orders-row")).toHaveLength(0);
	expect(absent(view, "orders-scan-note")).toBe(false);
	expect(absent(view, "orders-load-more")).toBe(false);

	await press(view, "orders-load-more");
	await settle();

	// BOTH GO TOGETHER. The screen must not tell the operator to press a control
	// it has just taken away.
	expect(absent(view, "orders-load-more")).toBe(true);
	expect(absent(view, "orders-scan-note")).toBe(true);
	expect(element(view, "orders-paging-stopped").textContent).toContain(PAGING_STOPPED_TITLE);
	// And no empty state has appeared in its place claiming the collection is
	// empty — nothing here has earned a whole-set claim.
	expect(absent(view, "orders-empty")).toBe(true);
	expect(absent(view, "orders-no-match")).toBe(true);
});

test("a filter change after paging stopped starts a fresh scan", async () => {
	serve((request) =>
		request.cursor === undefined
			? envelope({
					ok: true,
					orders: ids("o", 1, 20).map(order),
					nextCursor: PAGE_TWO,
					vocabulary: VOCABULARY,
				})
			: envelope({
					ok: true,
					orders: ids("o", 1, 20).map(order),
					nextCursor: PAGE_TWO,
					cursorRejected: true,
					vocabulary: VOCABULARY,
				}),
	);
	view = await mount(<OrdersScreen />);
	await settle();
	await press(view, "orders-load-more");
	await settle();
	expect(absent(view, "orders-paging-stopped")).toBe(false);

	await React.act(async () => {
		retype(element(view as Mounted, "filter-status") as HTMLSelectElement, "failed");
	});
	await press(view, "apply-filters");
	await settle();

	// The offer is back, because this is a different scan.
	expect(absent(view, "orders-paging-stopped")).toBe(true);
	expect(absent(view, "orders-load-more")).toBe(false);
	expect(rowIds(view, "orders-row")).toHaveLength(20);
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

	expect(asked).toHaveLength(1);
	expect(asked[0]?.cursor).toBe("tampered");
	// THE FILTER RODE ALONGSIDE THE PAGE, which is what let the service notice the
	// disagreement rather than answer an unfiltered catalog under a low-stock
	// caption.
	expect(asked[0]?.filter?.lowStock).toBe(true);
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

test("products: a failure leaves the page in the address", async () => {
	serve(() => refusal("Pricing & inventory is unavailable", 500));
	window.history.replaceState(null, "", `/products?low=1&cursor=${encodeURIComponent(PAGE_TWO)}`);
	view = await mount(<ProductsScreen />);
	await settle();

	expect(asked).toHaveLength(1);
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

test("products: a settings blip mid-scan costs the paging, never the low-stock scan", async () => {
	/*
	 * THE CASE THIS RULING ABSORBS. "Low stock only" is a real service predicate
	 * now, and the threshold that expresses it is read from settings on every
	 * request — so a settings read that blinks between two pages sends a filter
	 * that no longer matches the token, and the route refuses to continue. That is
	 * correct of the route. What must not follow is the merchant losing four pages
	 * of a low-stock scan to a blip that lasted one request.
	 */
	let call = 0;
	serve((request) => {
		const stock = { threshold: 5, unreadable: false, filterUnavailable: false };
		call += 1;
		if (request.cursor === undefined) {
			return envelope({
				ok: true,
				products: ids("p", 1, 3).map(product),
				nextCursor: PAGE_TWO,
				stock,
				vocabulary: PRODUCTS_VOCABULARY,
			});
		}
		if (call === 2) {
			return envelope({
				ok: true,
				products: ids("p", 4, 6).map(product),
				nextCursor: PAGE_THREE,
				stock,
				vocabulary: PRODUCTS_VOCABULARY,
			});
		}
		return envelope({
			ok: true,
			products: ids("p", 1, 3).map(product),
			nextCursor: PAGE_TWO,
			cursorRejected: true,
			stock,
			vocabulary: PRODUCTS_VOCABULARY,
		});
	});

	window.history.replaceState(null, "", "/products?low=1");
	view = await mount(<ProductsScreen />);
	await settle();
	await press(view, "products-load-more");
	await settle();
	expect(rowIds(view, "products-row")).toEqual(ids("p", 1, 6));

	await press(view, "products-load-more");
	await settle();

	expect(rowIds(view, "products-row")).toEqual(ids("p", 1, 6));
	expect(element(view, "products-intro").textContent).toContain(
		"6 low-stock products loaded so far",
	);
	expect(absent(view, "products-load-more")).toBe(true);
	expect(element(view, "products-paging-stopped").textContent).toContain(PAGING_STOPPED_TITLE);
	expect(absent(view, "products-cursor-reset")).toBe(true);
	expect(search().get("cursor")).toBeNull();
	expect(search().get("low")).toBe("1");
});

test("products: a low-stock scan matching nothing yet withdraws the note with the button", async () => {
	// The same edge on the screen it is genuinely reachable from: a low-stock scan
	// several pages deep that has matched nothing, whose continuation is refused
	// by a settings blip.
	let call = 0;
	serve(() => {
		call += 1;
		const empty = {
			ok: true,
			products: [],
			nextCursor: PAGE_TWO,
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: PRODUCTS_VOCABULARY,
		};
		return envelope(call === 1 ? empty : { ...empty, cursorRejected: true });
	});
	window.history.replaceState(null, "", "/products?low=1");
	view = await mount(<ProductsScreen />);
	await settle();
	expect(absent(view, "products-scan-note")).toBe(false);
	expect(absent(view, "products-load-more")).toBe(false);

	await press(view, "products-load-more");
	await settle();

	expect(absent(view, "products-load-more")).toBe(true);
	expect(absent(view, "products-scan-note")).toBe(true);
	expect(element(view, "products-paging-stopped").textContent).toContain(PAGING_STOPPED_TITLE);
	expect(absent(view, "products-no-match")).toBe(true);
	expect(absent(view, "products-page-zero")).toBe(true);
});
