/**
 * @vitest-environment happy-dom
 *
 * The order NUMBER on the console (ADR-0033), through a real render.
 *
 * The server sends `orderNumber` ("#3F9A2", the domain's `orderNumber`) on every
 * list row and on the detail; the console prints it — the same label the shopper
 * reads off their email — and computes nothing of its own. Five characters WILL
 * collide eventually, so two rows on one page that share a number also show their
 * shortest-unique prefix: no two rows ever read the same. A payload without the
 * field (an older server) keeps the short id it always showed.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrdersList, orderNumberMatchesNote } = await import("../src/orders/orders-list.js");
const { OrderDetail } = await import("../src/orders/order-detail.js");
type DetailPayload = import("../src/console-api.js").DetailPayload;

const VOCABULARY = {
	statuses: ["paid"],
	statusAny: "any",
	periods: [{ key: "any", label: "Any time" }],
	cancellationReasons: [],
	oneClickCancellationReasons: [],
	reconciliationOutcomes: [],
	pageLimit: 25,
};

function row(id: string, orderNumber: string | undefined) {
	return {
		id,
		...(orderNumber !== undefined ? { orderNumber } : {}),
		state: "paid",
		currency: "USD",
		buyerRef: `buyer_${id}@example.test`,
		customerId: null,
		paymentMethod: "card",
		createdAt: "2026-03-04T10:15:00.000Z",
		totalCents: 1999,
		reconciliationFlag: null,
	};
}

const SOLO = "3f9a2b1c-7d4e-4a5b-9c8d-0123456789ab";
const TWIN_A = "fee1d111-0000-4000-8000-000000000001";
const TWIN_B = "fee1d222-0000-4000-8000-000000000002";
const LEGACY = "7e4ce728-0000-4000-8000-000000000000";

let mounted: Mounted | null = null;

function respond(data: unknown): void {
	apiFetch.mockImplementation(() =>
		Promise.resolve(
			new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		),
	);
}

beforeEach(() => {
	apiFetch.mockReset();
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

async function mountList(): Promise<HTMLElement> {
	respond({
		ok: true,
		orders: [
			row(SOLO, "#3F9A2"),
			row(TWIN_A, "#FEE1D"),
			row(TWIN_B, "#FEE1D"),
			row(LEGACY, undefined),
		],
		nextCursor: null,
		vocabulary: VOCABULARY,
	});
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	await mounted.rerender(node);
	return mounted.container;
}

function link(container: HTMLElement, id: string): HTMLAnchorElement {
	const found = container.querySelector<HTMLAnchorElement>(`a[data-order-id="${id}"]`);
	if (found === null) throw new Error(`no order link for ${id}`);
	return found;
}

test("each row's identity link prints the order number the server sent", async () => {
	const container = await mountList();
	expect(link(container, SOLO).textContent).toBe("#3F9A2");
	// The full id is still where a machine reads it.
	expect(link(container, SOLO).getAttribute("href")).toBe(`?order=${SOLO}`);
});

test("two rows sharing a number also show what tells them apart", async () => {
	const container = await mountList();
	const a = link(container, TWIN_A);
	const b = link(container, TWIN_B);
	expect(a.textContent).toContain("#FEE1D");
	expect(b.textContent).toContain("#FEE1D");
	expect(a.textContent).not.toBe(b.textContent);
	// The tie-breaker EXTENDS the number in its own format, so the whole cell is
	// itself a number the search accepts (and the refund confirm's prefix extends).
	expect(a.textContent).toBe("#FEE1D1");
	expect(b.textContent).toBe("#FEE1D2");
	expect(a.querySelector('[data-testid="order-number-disambiguator"]')?.textContent).toBe("1");
	// A number nobody else on the page has needs no disambiguation.
	expect(link(container, SOLO).querySelector('[data-testid="order-number-disambiguator"]')).toBe(
		null,
	);
});

test("a row without a number still prints in the number's format", async () => {
	const container = await mountList();
	expect(link(container, LEGACY).textContent).toBe("#7E4CE");
});

test("a tie-breaker is hex only — never the UUID's hyphen — so the cell stays searchable", async () => {
	// Two ids that agree through their first EIGHT characters: the unique prefix
	// crosses the hyphen at position 8.
	const DEEP_A = "abcdef12-3000-4000-8000-000000000001";
	const DEEP_B = "abcdef12-4000-4000-8000-000000000002";
	respond({
		ok: true,
		orders: [row(DEEP_A, "#ABCDE"), row(DEEP_B, "#ABCDE")],
		nextCursor: null,
		vocabulary: VOCABULARY,
	});
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	await mounted.rerender(node);
	expect(link(mounted.container, DEEP_A).textContent).toBe("#ABCDEF123");
	expect(link(mounted.container, DEEP_B).textContent).toBe("#ABCDEF124");
});

function detail(orderNumber: string | undefined): DetailPayload {
	return {
		ok: true,
		order: {
			id: SOLO,
			...(orderNumber !== undefined ? { orderNumber } : {}),
			state: "paid",
			currency: "USD",
			paymentMethod: "card",
			buyerRef: "buyer@example.test",
			customerId: null,
			createdAt: "2026-03-04T10:15:00.000Z",
			reconciliationFlag: null,
			reconciliationResolution: null,
			fulfillment: null,
			cancellation: null,
			shippingAddress: null,
			totals: {
				currency: "USD",
				subtotalCents: 1999,
				discountCents: 0,
				shippingCents: 0,
				taxCents: 0,
				totalCents: 1999,
				appliedCouponCode: null,
			},
			lines: [],
		},
		transitions: [],
		customer: null,
		timeline: { entries: [] },
		refunds: null,
		notes: [],
		vocabulary: VOCABULARY,
	};
}

async function showDetail(payload: DetailPayload): Promise<HTMLElement> {
	respond(payload);
	mounted = await mount(<OrderDetail orderId={SOLO} onBack={() => undefined} />);
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return mounted.container;
}

test("the detail names the order number beside its full id", async () => {
	const container = await showDetail(detail("#3F9A2"));
	expect(container.querySelector('[data-testid="detail-order-number"]')?.textContent).toBe(
		"#3F9A2",
	);
	expect(container.querySelector('[data-testid="detail-full-id"]')?.textContent).toBe(SOLO);
	expect(container.textContent).toContain("Order number");
});

test("a detail without a number has no number row, and still its full id", async () => {
	const container = await showDetail(detail(undefined));
	expect(container.querySelector('[data-testid="detail-order-number"]')).toBe(null);
	expect(container.querySelector('[data-testid="detail-full-id"]')?.textContent).toBe(SOLO);
});

test("the identity column is headed Order, not a second #", async () => {
	const container = await mountList();
	const headers = [...container.querySelectorAll("th")].map((th) => th.textContent?.trim());
	expect(headers).toContain("Order");
	expect(headers).not.toContain("Order #");
});

test("a search by number that answers several orders says so; one answer, or another search, does not", () => {
	const twins = [{ id: TWIN_A }, { id: TWIN_B }, { id: SOLO }];
	expect(orderNumberMatchesNote("#fee1d", twins)).toBe(
		"#FEE1D matches 2 orders. An order number can be shared — confirm the buyer, date and total before acting.",
	);
	expect(orderNumberMatchesNote(" #FEE1D ", twins)).toMatch(/^#FEE1D matches 2 orders\./);
	// Only ID-prefix matches count: a row found by its buyer reference is not
	// another order with this number.
	expect(orderNumberMatchesNote("#FEE1D", [{ id: TWIN_A }, { id: SOLO }])).toBeNull();
	// Shorter than a number is a prefix hunt, not a number.
	expect(orderNumberMatchesNote("#FEE1", twins)).toBeNull();
	expect(orderNumberMatchesNote("fee1d", twins)).toBeNull();
	expect(orderNumberMatchesNote("jo@example.com", twins)).toBeNull();
	expect(orderNumberMatchesNote(undefined, twins)).toBeNull();
});

test("the note renders above the rows when the applied search is a shared number", async () => {
	respond({
		ok: true,
		orders: [row(TWIN_A, "#FEE1D"), row(TWIN_B, "#FEE1D")],
		nextCursor: null,
		total: 2,
		vocabulary: VOCABULARY,
	});
	const node = <OrdersList onOpen={() => undefined} initialFilter={{ search: "#FEE1D" }} />;
	mounted = await mount(node);
	await mounted.rerender(node);
	const note = mounted.container.querySelector('[data-testid="orders-number-matches-note"]');
	expect(note?.textContent).toMatch(/^#FEE1D matches 2 orders\./);
});
