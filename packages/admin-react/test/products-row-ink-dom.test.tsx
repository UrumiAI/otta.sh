/**
 * @vitest-environment happy-dom
 *
 * The Pricing & inventory list's row ink and its filter panel, through a real
 * render of the real screen.
 *
 * WHY A DOCUMENT. Every claim here is about which element carries a decision,
 * and the screen only reaches its table after an effect resolves — so a static
 * render never draws a row at all. A live mount is also the only tier that can
 * put a failure BEHIND a successful page, which is the difference between the
 * two filter-panel states asserted at the bottom.
 *
 * WHY THE ASSERTIONS ARE SCOPED TO A CELL AND NEVER TO THE MARKUP STRING. A
 * substring search for a ring in the page's HTML answers "somewhere on this
 * screen" and calls it "on this row", which is precisely how a decision that is
 * per-row gets a test that cannot tell rows apart. Each assertion below starts
 * from the row whose id it names and reads that row's own cells.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { ProductsList } = await import("../src/products/products-list.js");
const { CONSOLE_STYLES } = await import("../src/ui.js");
const { ABSENT, formatOptionalAmount, onHandCell, statusLabel } =
	await import("@otta-sh/admin-presentation");
type ProductSummary = import("../src/console-api.js").ProductSummary;

const THRESHOLD = 5;

function product(over: Partial<ProductSummary> & { productId: string }): ProductSummary {
	return {
		sku: `SKU-${over.productId}`,
		title: `Title ${over.productId}`,
		priceCents: 1_299_000,
		currency: "USD",
		productKind: "physical",
		active: true,
		onHand: 104,
		deletedAt: null,
		createdAt: "2026-03-04T10:15:00.000Z",
		...over,
	};
}

/**
 * Six rows spanning every status and every stock band this screen has to draw
 * differently — two happy paths and four exceptions.
 *
 * THE AMOUNTS ARE CHOSEN SO THE FORMATTER IS THE ONLY THING THAT CAN PRODUCE
 * THEM. `$19.99` reads identically whether it came from the formatter or from a
 * call site assembling a symbol and a division by a hundred, so a fixture made
 * only of small round amounts cannot tell those apart. One price crosses a
 * thousands separator, one is in a currency with no minor units at all, and one
 * is unset — and that last is the one a hard-coded `$0.00` would silently
 * satisfy, on the screen whose own rule is that absent is not zero.
 */
const ROWS: readonly ProductSummary[] = [
	product({ productId: "p_plain" }),
	product({ productId: "p_low", onHand: THRESHOLD, priceCents: 125_000, currency: "JPY" }),
	product({ productId: "p_out", onHand: 0, priceCents: 87_500 }),
	product({ productId: "p_unknown", onHand: null }),
	product({ productId: "p_unpriced", priceCents: null, currency: null }),
	product({ productId: "p_deleted", active: false, deletedAt: "2026-03-01T09:00:00.000Z" }),
];

const VOCABULARY = {
	any: "any",
	statuses: [
		{ value: "any", label: "Any status" },
		{ value: "true", label: "Active" },
	],
	kinds: [
		{ value: "any", label: "Any kind" },
		{ value: "physical", label: "Physical" },
	],
};

function page(): Response {
	return new Response(
		JSON.stringify({
			data: {
				ok: true,
				products: ROWS,
				nextCursor: null,
				total: ROWS.length,
				stock: { unreadable: false, threshold: THRESHOLD, filterUnavailable: false },
				vocabulary: VOCABULARY,
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

let mounted: Mounted | null = null;

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockImplementation(() => Promise.resolve(page()));
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

async function mountList(): Promise<HTMLElement> {
	const node = <ProductsList onOpen={() => undefined} />;
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

function record(id: string): ProductSummary {
	const found = ROWS.find((r) => r.productId === id);
	if (found === undefined) throw new Error(`no fixture ${id}`);
	return found;
}

const TITLE = 0;
const SKU = 1;
const STATUS = 2;
const ON_HAND = 3;
const PRICE = 4;

test("the statuses that need attention are the only ones wearing a ring", async () => {
	const container = await mountList();

	// A tombstone is the one irreversible state; not-for-sale is a state a
	// merchant may have chosen, so it warns rather than fails.
	for (const [id, tone] of [
		["p_deleted", "fail"],
		["p_unpriced", "warn"],
	] as const) {
		const pill = cell(container, id, STATUS).querySelector("[data-tone]");
		expect(pill, id).not.toBeNull();
		expect(pill?.getAttribute("data-tone"), id).toBe(tone);
		// The ring wraps the shared phrase; it does not make one.
		expect(pill?.textContent, id).toBe(statusLabel(record(id)));
	}

	// THE POINT OF THE DECISION, and the thing a symmetric "ring every status"
	// change breaks: the ordinary rows in the same column, all bare. A mark on
	// every row marks nothing.
	for (const id of ["p_plain", "p_low", "p_out", "p_unknown"]) {
		const bare = cell(container, id, STATUS);
		expect(bare.querySelector("[data-tone]"), id).toBeNull();
		expect(bare.textContent, id).toBe(statusLabel(record(id)));
	}
});

test("the stock column rings the counts that stop a sale, and never an absence", async () => {
	const container = await mountList();

	for (const [id, tone] of [
		["p_out", "fail"],
		["p_low", "warn"],
	] as const) {
		const pill = cell(container, id, ON_HAND).querySelector("[data-tone]");
		expect(pill, id).not.toBeNull();
		expect(pill?.getAttribute("data-tone"), id).toBe(tone);
		expect(pill?.textContent, id).toBe(onHandCell(record(id).onHand, THRESHOLD));
	}

	// ABSENT IS NOT ZERO, and it is not an exception either. An unknown count is
	// the em dash and nothing else: no ring, and above all not a `0` the store
	// never counted.
	const unknown = cell(container, "p_unknown", ON_HAND);
	expect(unknown.querySelector("[data-tone]")).toBeNull();
	expect(unknown.textContent).toBe(ABSENT);
	expect(unknown.textContent).not.toBe("0");

	// A healthy count is a bare number.
	const healthy = cell(container, "p_plain", ON_HAND);
	expect(healthy.querySelector("[data-tone]")).toBeNull();
	expect(healthy.textContent).toBe("104");
});

test("the title anchors the row and the two operational numbers keep full strength", async () => {
	const container = await mountList();

	const link = cell(container, "p_plain", TITLE).querySelector("a");
	expect(link?.style.fontWeight).toBe("600");

	// Recessive, and stated as opacity so the ink is the same ink at less of it —
	// never a second foreground colour, which cannot be safe in both themes. The
	// SKU's declaration is on the code element, so the copy control beside it
	// keeps its own.
	expect(cell(container, "p_plain", SKU).querySelector("code")?.style.opacity).toBe("0.75");
	expect(cell(container, "p_plain", SKU).style.opacity).toBe("");
	expect(cell(container, "p_plain", STATUS).style.opacity).toBe("0.75");

	// On hand and price are what a merchant is on this screen to read: full
	// strength, and weight 400 by omission rather than by declaration.
	for (const index of [ON_HAND, PRICE]) {
		expect(cell(container, "p_plain", index).style.opacity).toBe("");
		expect(cell(container, "p_plain", index).style.fontWeight).toBe("");
	}

	// A ringed status is NOT dimmed: the recession exists because `active` is not
	// worth reading, and a pill exists because its answer is.
	expect(cell(container, "p_deleted", STATUS).style.opacity).toBe("");
});

test("the price column shows what the formatter makes of the record, on every row", async () => {
	const container = await mountList();

	// ALIGNMENT IS THE HALF THAT DOES NOT MATTER IF THE NUMBER IS WRONG. A cell
	// asserted only for its edge accepts a hand-assembled amount and accepts a
	// hard-coded `$0.00` — and "absent is not zero" is this console's own
	// signature defect, so the rendered VALUE is what has to be read.
	for (const fixture of ROWS) {
		const price = cell(container, fixture.productId, PRICE);
		expect(price.textContent, `row ${fixture.productId}`).toBe(
			formatOptionalAmount(fixture.priceCents, fixture.currency),
		);
	}

	// And the one that a zero would satisfy, named on its own so the loop above
	// cannot pass by agreeing with a broken formatter.
	expect(cell(container, "p_unpriced", PRICE).textContent).toBe(ABSENT);
});

test("the money column is end-aligned, header and cells together", async () => {
	const container = await mountList();

	expect(cell(container, "p_plain", PRICE).style.textAlign).toBe("end");

	const headers = container.querySelectorAll<HTMLTableCellElement>("th.otta-th");
	// A header end-aligned by the cell alone would leave the word over the wrong
	// edge of its own column, so the span inside it is what is read here.
	const span = headers.item(PRICE).querySelector("span");
	expect(span?.style.textAlign).toBe("end");

	// `On hand` is deliberately NOT end-aligned: its cells carry a trailing
	// phrase, so pushing them to the edge would align the words and leave the
	// digits ragged.
	expect(headers.item(ON_HAND).querySelector("span")).toBeNull();
	expect(cell(container, "p_plain", ON_HAND).style.textAlign).toBe("");
});

test("the way in takes its underline from the shared rule, not from a style object", async () => {
	const container = await mountList();

	const link = cell(container, "p_plain", TITLE).querySelector("a");
	expect(link).not.toBeNull();
	// THE LOAD-BEARING DETAIL. The rule goes solid on hover and on keyboard
	// focus, which no style object can express — and an inline decoration here
	// would outrank every one of the class's triggers, so there must not be one.
	expect(link?.classList.contains("otta-link")).toBe(true);
	expect(link?.style.textDecorationLine).toBe("");
	expect(link?.style.textDecorationColor).toBe("");
	// ROW HOVER IS THIS LIST'S ALONE (F18), and it arrives through a modifier the
	// Orders prefix does not carry. Both ends of that are asserted here: the class
	// on the link, and the trigger in the sheet that the class exists to match —
	// either one going missing takes the state away without touching the other.
	expect(link?.classList.contains("otta-link-row")).toBe(true);
	expect(
		CONSOLE_STYLES.split(/[\n,{]/)
			.map((part) => part.trim())
			.filter((part) => part.startsWith(".otta-row:hover") && part.includes("link")),
	).toEqual([".otta-row:hover .otta-link-row"]);
	// Colour stays inherited — the sheet bans fixed foregrounds for theme
	// reasons.
	expect(link?.style.color).toBe("inherit");
	// Padding paid back by an equal negative margin: a bigger target, an
	// unchanged row height.
	expect(link?.style.padding).not.toBe("");
	expect(link?.style.margin).not.toBe("");
	// Still a real link, so a modified click is still the browser's.
	expect(link?.getAttribute("href")).toBe("?product=p_plain");
});

test("a cold failure withdraws the filter panel; a stale one keeps it populated", async () => {
	// COLD: nothing has ever landed, so the two selects have no vocabulary to
	// offer and would render as empty menus beside an error.
	apiFetch.mockImplementation(() => Promise.resolve(new Response("", { status: 500 })));
	const cold = await mountList();
	expect(cold.querySelector('[data-testid="products-failure"]')).not.toBeNull();
	expect(cold.querySelector('[data-testid="products-filters"]')).toBeNull();
	expect(cold.querySelector('[data-testid="filter-status"]')).toBeNull();

	await mounted?.unmount();
	mounted = null;

	// STALE: a page landed, a later request failed. The operator's typed filters
	// are input rather than answer, so the panel stays — and its selects stay
	// populated, because the vocabulary survived the clear.
	//
	// THE FILTER IS GENUINELY CHANGED FIRST, and that is what makes this the stale
	// case rather than a refresh: `Apply filters` over an UNCHANGED predicate is a
	// refresh of the window on screen, and a refresh that fails leaves those rows
	// standing by design. A fresh load under a NEW predicate is the request whose
	// failure disproves them.
	apiFetch.mockImplementation(() => Promise.resolve(page()));
	const stale = await mountList();
	apiFetch.mockImplementation(() => Promise.resolve(new Response("", { status: 500 })));
	const search = stale.querySelector<HTMLInputElement>('[data-testid="filter-search"]');
	expect(search).not.toBeNull();
	await React.act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
			search,
			"widget",
		);
		search?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const apply = stale.querySelector<HTMLButtonElement>('[data-testid="apply-filters"]');
	expect(apply).not.toBeNull();
	if (apply !== null) await fire(apply, "click");

	expect(stale.querySelector('[data-testid="products-failure"]')).not.toBeNull();
	expect(stale.querySelector('[data-testid="products-filters"]')).not.toBeNull();
	const status = stale.querySelector<HTMLSelectElement>('[data-testid="filter-status"]');
	const kind = stale.querySelector<HTMLSelectElement>('[data-testid="filter-kind"]');
	// The count is what makes this the stale case rather than a bar that merely
	// exists: an option-less select is exactly the defect the cold branch above
	// removes.
	expect(status?.options.length).toBe(VOCABULARY.statuses.length);
	expect(kind?.options.length).toBe(VOCABULARY.kinds.length);
	// And the rows went with the failure, as they always do.
	expect(stale.querySelectorAll('[data-testid="products-row"]').length).toBe(0);
});
