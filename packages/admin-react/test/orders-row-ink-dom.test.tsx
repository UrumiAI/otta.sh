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
const { CONSOLE_STYLES } = await import("../src/ui.js");
const { ABSENT, formatAmount, orderStateCell } = await import("@otta-sh/admin-presentation");

let mounted: Mounted | null = null;

function order(id: string, state: string, totalCents: number, currency = "USD") {
	return {
		id,
		state,
		currency,
		buyerRef: `buyer_${id}`,
		customerId: `cust_${id}`,
		paymentMethod: "card",
		createdAt: "2026-03-04T10:15:00.000Z",
		totalCents,
		reconciliationFlag: null,
	};
}

/**
 * Five rows spanning the five statuses this screen has to draw differently —
 * one exception and four ordinary ones.
 *
 * THE AMOUNTS ARE CHOSEN SO THE FORMATTER IS THE ONLY THING THAT CAN PRODUCE
 * THEM. `$19.99` reads identically whether it came from the formatter or from a
 * call site assembling a symbol and a division by a hundred, so a fixture made
 * only of small round amounts cannot tell those apart. One total crosses a
 * thousands separator and one is in a currency with no minor units at all;
 * neither survives a hand-built string, and none of the five is the `$0.00` a
 * hard-coded zero would show.
 */
const ROWS = [
	order("ord_paid", "paid", 1_299_000),
	order("ord_failed", "failed", 1999),
	order("ord_delivered", "delivered", 12_000),
	order("ord_cancelled", "cancelled", 125_000, "JPY"),
	order("ord_refunded", "refunded", 87_500),
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

const CUSTOMER = 1;
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
	// change breaks: four ordinary statuses in the same column, all bare. A
	// mark on every row marks nothing. `refunded` is here on purpose — the state
	// most tempting to pill by "symmetry" with `failed`, and the one a broadened
	// match would catch first.
	for (const id of ["ord_paid", "ord_delivered", "ord_cancelled", "ord_refunded"]) {
		const bare = cell(container, id, STATUS);
		expect(bare.querySelector("[data-tone]")).toBeNull();
		expect(bare.textContent).toBe(orderStateCell(id.slice(4)));
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

test("the money column shows what the formatter makes of the record, on every row", async () => {
	const container = await mountList();

	// ALIGNMENT IS THE HALF THAT DOES NOT MATTER IF THE NUMBER IS WRONG. A cell
	// asserted only for its edge accepts a hand-assembled amount and accepts a
	// hard-coded `$0.00` — and "absent is not zero" is this console's own
	// signature defect, so the rendered VALUE is what has to be read.
	for (const record of ROWS) {
		const total = cell(container, record.id, TOTAL);
		expect(total.textContent, `row ${record.id}`).toBe(
			formatAmount(record.totalCents, record.currency),
		);
	}
});

test("the way in is underlined and its hit area exceeds its glyphs", async () => {
	const container = await mountList();

	const link = cell(container, "ord_failed", IDENTITY).querySelector("a");
	expect(link).not.toBeNull();
	expect(link?.style.fontWeight).toBe("600");
	expect(link?.style.textDecorationLine).toBe("underline");
	// THE CLASS IS THE OTHER HALF, and it is the half nothing else here holds
	// down: every remaining assertion in this test reads an inline declaration
	// that survives losing it, so a change that dropped the class would take the
	// solid hover and focus states off this list and still leave the file green.
	expect(link?.classList.contains("otta-link")).toBe(true);
	// Colour stays inherited — the sheet bans fixed foregrounds for theme
	// reasons, so weight and a rule under the word are the whole affordance.
	expect(link?.style.color).toBe("inherit");
	// Padding paid back by an equal negative margin: a bigger target, an
	// unchanged row height.
	expect(link?.style.padding).not.toBe("");
	expect(link?.style.margin).not.toBe("");
});

/** The sheet's selectors, one per line, with the braces and the commas of a
 *  selector list taken off. A cascade cannot be resolved outside a browser, so
 *  the rule a class reaches is checked as text — the same reason the shared
 *  chrome's own suite reads the sheet as a string. */
function selectors(): readonly string[] {
	return CONSOLE_STYLES.split(/[\n,{]/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0 && part.startsWith("."));
}

/** The declarations inside one rule's block — trimmed, semicolons dropped,
 *  order not preserved as anything meaningful. A caller checks membership
 *  (`toContain`) rather than comparing the array itself, so a declaration
 *  moving within its own block, a formatting change with no effect on the
 *  cascade, cannot fail an assertion built on this. */
function declarationsOf(selector: string): readonly string[] {
	const css = CONSOLE_STYLES.replace(/\s+/g, " ");
	const opener = `${selector} {`;
	const start = css.indexOf(opener);
	if (start === -1) throw new Error(`no rule for ${selector}`);
	const bodyEnd = css.indexOf("}", start + opener.length);
	return css
		.slice(start + opener.length, bodyEnd)
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

test("this list takes the shared underline, and stops at three states", async () => {
	const container = await mountList();
	const link = cell(container, "ord_failed", IDENTITY).querySelector("a");

	// The rule the class above reaches has to exist at all, with all three of
	// the declarations this change relocated off the call site: the line, the
	// muted colour (its `color-mix` and the 45% figure both), and the
	// underline's offset. Read as a set, not a string, so reordering the
	// declarations — a formatting change with no effect on the cascade —
	// cannot fail this test.
	//
	// WHAT THIS DOES AND DOES NOT PROVE. This confirms the declarations are
	// present in the sheet's text. It cannot see the cascade: a
	// higher-specificity rule elsewhere could still override every one of
	// these while this assertion stays green. Rendered behaviour is
	// established at the browser tier, not here.
	const rest = declarationsOf(".otta-link");
	expect(rest).toContain("text-decoration-line: none");
	expect(rest).toContain(
		"text-decoration-color: color-mix(in srgb, currentColor 45%, transparent)",
	);
	expect(rest).toContain("text-underline-offset: 2px");

	const active = declarationsOf(".otta-link:hover, .otta-link:focus-visible");
	expect(active).toContain("text-decoration-line: underline");
	expect(active).toContain("text-decoration-color: currentColor");

	// AND ROW HOVER IS NOT ONE OF THIS LIST'S STATES. F18 gives row-hover
	// underlining to Pricing alone, so the sheet's row-hover trigger has to name
	// the modifier that only Pricing's title carries — and this prefix must not
	// carry it. Three states here and no fourth: muted at rest (above), solid on
	// the link's own hover, solid on `:focus-visible`.
	expect(
		selectors().filter((one) => one.startsWith(".otta-row:hover") && one.includes("link")),
	).toEqual([".otta-row:hover .otta-link-row"]);
	expect(link?.classList.contains("otta-link-row")).toBe(false);
});

/** The visibility a browser would actually apply, inheritance included.
 *
 *  `style.visibility` is the element's OWN declaration and is blind to an
 *  ancestor that hid the subtree — so a control wrapped in a hidden parent
 *  passes an inline check while being unreachable on the page. `visibility`
 *  inherits, so the computed value is the one that answers the question the
 *  reveal exists to answer. happy-dom leaves an undeclared value empty, which is
 *  the initial `visible`. */
function effectiveVisibility(node: Element): string {
	const declared = window.getComputedStyle(node).visibility;
	return declared === "" ? "visible" : declared;
}

/** The first ancestor between `node` and `stop` (inclusive) that is not
 *  rendered at all. `display` does not inherit, so this one has to be walked. */
function undisplayedAncestor(node: Element, stop: Element): Element | null {
	let current: Element | null = node;
	while (current !== null) {
		if (window.getComputedStyle(current).display === "none") return current;
		if (current === stop) return null;
		current = current.parentElement;
	}
	return null;
}

test("the copy control fades rather than leaving the tab order, on every row", async () => {
	const container = await mountList();

	// ONE ROW IS NOT FOUR. A control rendered only for the row that happens to be
	// inspected — say, only where the status is `failed` — is missing from three
	// rows out of four, and a test that reads a single row calls that fine.
	for (const record of ROWS) {
		const scope = row(container, record.id);
		const copy = cell(container, record.id, IDENTITY).querySelector("button");
		expect(copy, `row ${record.id} has no copy control`).not.toBeNull();
		if (copy === null) continue;

		// THE LOAD-BEARING DETAIL. `visibility` or `display` would take the control
		// out of the tab order, so a keyboard operator could never reach a button
		// revealed only by a pointer. The class is opacity-driven, and no inline
		// declaration may outrank its reveal triggers.
		expect(copy.classList.contains("otta-copy-reveal"), record.id).toBe(true);
		expect(copy.style.visibility, record.id).toBe("");
		expect(copy.style.display, record.id).toBe("");
		expect(copy.style.opacity, record.id).toBe("");
		// And the effective values, which is what the operator meets: an ancestor
		// carrying `visibility: hidden` or `display: none` removes the control just
		// as thoroughly as declaring it on the button, and leaves every inline
		// check above untouched.
		expect(effectiveVisibility(copy), record.id).toBe("visible");
		expect(undisplayedAncestor(copy, scope), record.id).toBeNull();

		// Still a real, named tab stop while faded.
		expect(copy.hasAttribute("disabled"), record.id).toBe(false);
		expect(copy.getAttribute("aria-label"), record.id).toBe(`Copy full order id ${record.id}`);
	}
});

/**
 * THE DEFECT: a CLAIMED order — the one where the most is known about the
 * buyer — used to render its Customer cell as `order.customerId`, an opaque
 * uuid, because the cell read `order.customerId ?? order.buyerRef` and every
 * fixture row here carries both. An UNCLAIMED/guest row (`customerId: null`)
 * happened to read fine by the same bug, for the wrong reason.
 *
 * Every `ROWS` fixture sets `customerId` to a DIFFERENT string than
 * `buyerRef` (`cust_<id>` vs `buyer_<id>`), so this assertion cannot pass by
 * the two values coinciding — only by the cell actually preferring the
 * readable reference.
 */
test("the Customer cell renders the readable buyer reference, not the opaque customer id, for a claimed order", async () => {
	const container = await mountList();

	for (const record of ROWS) {
		const customer = cell(container, record.id, CUSTOMER);
		expect(customer.textContent, record.id).toBe(record.buyerRef);
		expect(customer.textContent, record.id).not.toBe(record.customerId);
	}
});

/**
 * THE UUID IS NOT DELETED, IT IS MOVED — off the rendered text and onto a
 * data attribute in the row, the same shape the products list carries its own
 * id in (`data-product-id` beside a human-readable title). There is no
 * customer-detail screen in this console to link to, so this is an attribute
 * rather than an `href`; the requirement it satisfies is the same one that
 * href satisfies there — the id stays reachable from the row without being
 * printed on the page.
 */
test("the customer id stays reachable from the row, as a data attribute beside the readable text", async () => {
	const container = await mountList();

	for (const record of ROWS) {
		const customer = cell(container, record.id, CUSTOMER);
		expect(customer.getAttribute("data-customer-id"), record.id).toBe(record.customerId);
	}
});

/**
 * ABSENT IS AN EM DASH, NEVER THE UUID, NEVER "null", NEVER BLANK. A row
 * whose `buyerRef` came back empty is exactly the case §1.3's fallback would
 * paper over by falling back to the id — the one rendering this change
 * exists to remove.
 */
/** One synthetic order, wrapped in the response shape `mountList` needs —
 *  factored out because the three tests below each need their own single
 *  row and differ only in `buyerRef`/`customerId`. */
function respondWithOneOrder(identity: {
	readonly id: string;
	readonly buyerRef: string;
	readonly customerId: string | null;
}): void {
	apiFetch.mockResolvedValue(
		new Response(
			JSON.stringify({
				data: {
					ok: true,
					orders: [
						{
							state: "paid",
							currency: "USD",
							paymentMethod: "card",
							createdAt: "2026-03-04T10:15:00.000Z",
							totalCents: 4200,
							reconciliationFlag: null,
							...identity,
						},
					],
					nextCursor: null,
					vocabulary: {
						statuses: ["paid"],
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
}

test("an empty buyer reference renders the shared em dash, never the customer id and never blank", async () => {
	respondWithOneOrder({ id: "ord_no_ref", buyerRef: "", customerId: "cust_no_ref" });

	const container = await mountList();
	const customer = cell(container, "ord_no_ref", CUSTOMER);
	expect(customer.textContent).toBe(ABSENT);
	expect(customer.textContent).not.toBe("");
	expect(customer.textContent).not.toBe("null");
	expect(customer.textContent).not.toBe("cust_no_ref");
	// The id is still on the row even though the cell has nothing readable to
	// show — an operator can still act on the order from the id alone.
	expect(customer.getAttribute("data-customer-id")).toBe("cust_no_ref");
});

/** Reviewer B: `buyerRef.length > 0` alone is true for `" "` — a cell that
 *  rendered a bare space would be the "never an empty cell" rule broken by a
 *  value that LOOKS empty rather than one that measures empty. */
test("a whitespace-only buyer reference renders the shared em dash, not a blank-looking space", async () => {
	respondWithOneOrder({ id: "ord_ws_ref", buyerRef: "   ", customerId: "cust_ws_ref" });

	const container = await mountList();
	const customer = cell(container, "ord_ws_ref", CUSTOMER);
	expect(customer.textContent).toBe(ABSENT);
	expect(customer.getAttribute("data-customer-id")).toBe("cust_ws_ref");
});

/**
 * THE GUEST/UNCLAIMED CASE, WHICH NO `ROWS` FIXTURE EXERCISES. Every row
 * above carries a non-null `customerId`, so neither of this cell's two claims
 * — the readable text, and the reachable-but-unprinted id — has ever been
 * checked against the row where `customerId` is `null`. That is the row where
 * `getAttribute("data-customer-id")` returning `null` has to mean "no
 * attribute", not "the record happened not to carry one down two different
 * paths" (the earlier assertions never fail on a vacuously absent attribute,
 * because every fixture row supplies a customerId to compare against).
 */
test("an unclaimed order still renders the buyer reference, and carries no data-customer-id attribute at all", async () => {
	respondWithOneOrder({ id: "ord_guest", buyerRef: "guest_checkout_991", customerId: null });

	const container = await mountList();
	const customer = cell(container, "ord_guest", CUSTOMER);
	expect(customer.textContent).toBe("guest_checkout_991");
	expect(customer.hasAttribute("data-customer-id")).toBe(false);
	expect(customer.getAttribute("data-customer-id")).toBeNull();
});
