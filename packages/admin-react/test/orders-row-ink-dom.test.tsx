/**
 * @vitest-environment happy-dom
 *
 * The Orders list's row ink, through a real render of the real screen.
 *
 * WHY A DOCUMENT. Every claim here is about which element carries a decision,
 * and the screen only reaches its table after an effect resolves — so a static
 * render never draws a row at all. A live mount is the only tier that can read
 * the status cell of the `failed` row and the status cells of the rows beside
 * it out of the same paint.
 *
 * WHY THE ASSERTIONS ARE SCOPED TO A CELL AND NEVER TO THE MARKUP STRING. A
 * substring search for a pill in the page's HTML answers "somewhere on this
 * screen" and calls it "on this row", which is precisely how a decision that is
 * per-row gets a test that cannot tell rows apart. Each assertion below starts
 * from the row whose id it names and reads that row's own cells.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrdersList } = await import("../src/orders/orders-list.js");
const { orderStateCell } = await import("@otta-sh/admin-presentation");

let mounted: Mounted | null = null;

function order(id: string, state: string, totalCents: number) {
	return {
		id,
		state,
		currency: "USD",
		buyerRef: `buyer_${id}`,
		customerId: `cust_${id}`,
		paymentMethod: "card",
		createdAt: "2026-03-04T10:15:00.000Z",
		totalCents,
		reconciliationFlag: null,
	};
}

/** Four rows spanning the four statuses this screen has to draw differently —
 *  one exception and three ordinary ones. */
const ROWS = [
	order("ord_paid", "paid", 4500),
	order("ord_failed", "failed", 1999),
	order("ord_delivered", "delivered", 12000),
	order("ord_cancelled", "cancelled", 800),
];

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockResolvedValue(
		new Response(
			JSON.stringify({
				data: {
					ok: true,
					orders: ROWS,
					nextCursor: null,
					vocabulary: {
						statuses: ["paid", "failed", "delivered", "cancelled"],
						statusAny: "any",
						periods: [{ key: "any", label: "Any time" }],
						cancellationReasons: [],
						oneClickCancellationReasons: [],
					},
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		),
	);
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

async function mountList(): Promise<HTMLElement> {
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	// The first page arrives through a promise chain the mount's own `act` does
	// not outlive — the response, its `json()`, and the state that follows are
	// three microtask turns apart. A second flush is what puts rows on screen.
	await mounted.rerender(node);
	return mounted.container;
}

/** A row by the id it carries, and only that row. */
function row(container: HTMLElement, id: string): HTMLTableRowElement {
	const found = container.querySelector<HTMLTableRowElement>(`tr[data-row-id="${id}"]`);
	if (found === null) throw new Error(`no row for ${id}`);
	return found;
}

function cell(container: HTMLElement, id: string, index: number): HTMLTableCellElement {
	const found = row(container, id).cells.item(index);
	if (found === null) throw new Error(`row ${id} has no cell ${String(index)}`);
	return found;
}

const STATUS = 2;
const IDENTITY = 3;
const TOTAL = 4;

test("the one status that needs attention is the only one wearing a ring", async () => {
	const container = await mountList();

	const failed = cell(container, "ord_failed", STATUS);
	const pill = failed.querySelector("[data-tone]");
	expect(pill).not.toBeNull();
	expect(pill?.getAttribute("data-tone")).toBe("fail");
	// The pill wraps the shared phrase; it does not make one.
	expect(pill?.textContent).toBe(orderStateCell("failed"));

	// THE POINT OF THE DECISION, and the thing a symmetric "pill every status"
	// change breaks: three ordinary statuses in the same column, all bare. A
	// mark on every row marks nothing.
	for (const id of ["ord_paid", "ord_delivered", "ord_cancelled"]) {
		const bare = cell(container, id, STATUS);
		expect(bare.querySelector("[data-tone]")).toBeNull();
		expect(bare.textContent).toBe(orderStateCell(id === "ord_paid" ? "paid" : id.slice(4)));
	}
});

test("the row's two anchors carry the weight and the rest recedes", async () => {
	const container = await mountList();

	expect(cell(container, "ord_paid", 1).style.fontWeight).toBe("600");
	expect(cell(container, "ord_paid", TOTAL).style.fontWeight).toBe("600");
	// Recessive, and stated as opacity so the ink is the same ink at less of it —
	// never a second foreground colour, which cannot be safe in both themes.
	expect(cell(container, "ord_paid", 0).style.opacity).toBe("0.72");
	// The status column keeps its default weight: the pill is the only thing in
	// it that is allowed to stand out.
	expect(cell(container, "ord_paid", STATUS).style.fontWeight).toBe("");
});

test("the money column is end-aligned, header and cells together", async () => {
	const container = await mountList();

	expect(cell(container, "ord_paid", TOTAL).style.textAlign).toBe("end");

	const headers = container.querySelectorAll<HTMLTableCellElement>("th.otta-th");
	const totalHeader = headers.item(TOTAL);
	// A header end-aligned by the cell alone would leave the word over the wrong
	// edge of its own column, so the span inside it is what is read here.
	const span = totalHeader.querySelector("span");
	expect(span?.textContent).toBe("Total");
	expect(span?.style.textAlign).toBe("end");
});

test("the way in is underlined and its hit area exceeds its glyphs", async () => {
	const container = await mountList();

	const link = cell(container, "ord_failed", IDENTITY).querySelector("a");
	expect(link).not.toBeNull();
	expect(link?.style.fontWeight).toBe("600");
	expect(link?.style.textDecorationLine).toBe("underline");
	// Colour stays inherited — the sheet bans fixed foregrounds for theme
	// reasons, so weight and a rule under the word are the whole affordance.
	expect(link?.style.color).toBe("inherit");
	// Padding paid back by an equal negative margin: a bigger target, an
	// unchanged row height.
	expect(link?.style.padding).not.toBe("");
	expect(link?.style.margin).not.toBe("");
});

test("the copy control fades rather than leaving the tab order", async () => {
	const container = await mountList();

	const copy = cell(container, "ord_failed", IDENTITY).querySelector("button");
	expect(copy).not.toBeNull();
	// THE LOAD-BEARING DETAIL. `visibility` or `display` would take the control
	// out of the tab order, so a keyboard operator could never reach a button
	// revealed only by a pointer. The class is opacity-driven, and no inline
	// declaration may outrank its reveal triggers.
	expect(copy?.classList.contains("otta-copy-reveal")).toBe(true);
	expect(copy?.style.visibility).toBe("");
	expect(copy?.style.display).toBe("");
	expect(copy?.style.opacity).toBe("");
	// Still a real, named tab stop while faded.
	expect(copy?.hasAttribute("disabled")).toBe(false);
	expect(copy?.getAttribute("aria-label")).toBe("Copy full order id ord_failed");
});
