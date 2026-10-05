/**
 * @vitest-environment happy-dom
 *
 * Issue #377: the Orders console masks a buyer's email by default, and the
 * operator reveals it per row (list) or per order (detail).
 *
 * THE DECISION BEING PINNED. Only an EmDash ADMIN reaches this console at all
 * (the plugin's admin route requires `plugins:manage`), so there is no lower
 * role to gate. What masking buys is protection against a shoulder-surfer and
 * against a screenshot of an ordinary working screen — and nothing is lost,
 * because one click shows the address. So: masked by default, the resume
 * flow's own `j•••@g•••.com` (not a second masking rule), a real toggle button,
 * client-side only, and the full address NOT IN THE DOCUMENT until revealed —
 * a DOM snapshot or a devtools screenshot of a masked screen carries nothing.
 *
 * WHAT THIS DOES NOT CLAIM. The address still arrives in the admin API
 * response; masking is a presentation decision for the person in front of the
 * screen, not an access control. A test here that asserted otherwise would be
 * asserting something the screen cannot deliver.
 *
 * WHY EVERY ASSERTION READS ONE CELL OR ONE ELEMENT, never the whole markup,
 * except the "absent from the DOM" checks — which are about the whole document
 * on purpose, because "nowhere on the page" is exactly their claim.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrdersList } = await import("../src/orders/orders-list.js");
const { OrderDetail } = await import("../src/orders/order-detail.js");
const { buyerRefHint, formatAmount, refundConfirmText } =
	await import("@otta-sh/admin-presentation");
type DetailPayload = import("../src/console-api.js").DetailPayload;
type RefundsSummary = import("../src/console-api.js").RefundsSummary;

const EMAIL = "priya.kapoor@example.test";
const MASKED = "p•••@e•••.test";
const NON_EMAIL = "guest_checkout_551";

let mounted: Mounted | null = null;

beforeEach(() => {
	apiFetch.mockReset();
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

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

function one<T extends Element>(root: ParentNode, selector: string): T {
	const found = root.querySelector<T>(selector);
	if (found === null) throw new Error(`nothing matched ${selector}`);
	return found;
}

/** Everything the document holds that a snapshot or a devtools screenshot
 *  could carry: text AND attributes, which `textContent` alone would miss. */
function documentMarkup(): string {
	return document.body.outerHTML;
}

// ── the list ─────────────────────────────────────────────────────────────────

function listRow(id: string, buyerRef: string) {
	return {
		id,
		state: "paid",
		currency: "USD",
		buyerRef,
		customerId: `cust_${id}`,
		paymentMethod: "card",
		createdAt: "2026-03-04T10:15:00.000Z",
		totalCents: 4200,
		reconciliationFlag: null,
	};
}

const LIST_ROWS = [
	listRow("ord_email", EMAIL),
	listRow("ord_other_email", "avery.stone@example.com"),
	listRow("ord_guest", NON_EMAIL),
];

async function mountList(): Promise<HTMLElement> {
	respond({
		ok: true,
		orders: LIST_ROWS,
		nextCursor: null,
		vocabulary: {
			statuses: ["paid"],
			statusAny: "any",
			periods: [{ key: "any", label: "Any time" }],
			cancellationReasons: [],
			oneClickCancellationReasons: [],
		},
	});
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	await mounted.rerender(node);
	return mounted.container;
}

const CUSTOMER = 1;

function customerCell(container: HTMLElement, id: string): HTMLTableCellElement {
	const row = one<HTMLTableRowElement>(container, `tr[data-row-id="${id}"]`);
	const found = row.cells.item(CUSTOMER);
	if (found === null) throw new Error(`row ${id} has no Customer cell`);
	return found;
}

function shownRef(cell: HTMLElement): string {
	return one<HTMLElement>(cell, '[data-testid="buyer-ref"]').textContent ?? "";
}

function rowToggle(cell: HTMLElement): HTMLButtonElement {
	return one<HTMLButtonElement>(cell, '[data-testid="buyer-email-toggle"]');
}

test("the list masks every email-shaped buyer reference by default, with the resume flow's hint", async () => {
	const container = await mountList();

	expect(shownRef(customerCell(container, "ord_email"))).toBe(MASKED);
	expect(shownRef(customerCell(container, "ord_other_email"))).toBe(
		buyerRefHint("avery.stone@example.com"),
	);
});

test("while masked, the full address is nowhere in the document — not in text, not in an attribute", async () => {
	await mountList();

	const markup = documentMarkup();
	expect(markup).not.toContain(EMAIL);
	expect(markup).not.toContain("avery.stone@example.com");
	expect(markup).not.toContain("priya.kapoor");
});

test("Show reveals that one row's full address, and Hide masks it again", async () => {
	const container = await mountList();
	const cell = customerCell(container, "ord_email");
	const toggle = rowToggle(cell);

	expect(toggle.textContent).toBe("Show");
	expect(toggle.getAttribute("aria-expanded")).toBe("false");

	await fire(toggle, "click");
	expect(shownRef(cell)).toBe(EMAIL);
	expect(rowToggle(cell).textContent).toBe("Hide");
	expect(rowToggle(cell).getAttribute("aria-expanded")).toBe("true");
	// PER ROW: the neighbour stays masked.
	expect(shownRef(customerCell(container, "ord_other_email"))).toBe(
		buyerRefHint("avery.stone@example.com"),
	);

	await fire(rowToggle(cell), "click");
	expect(shownRef(cell)).toBe(MASKED);
	expect(rowToggle(cell).getAttribute("aria-expanded")).toBe("false");
	expect(documentMarkup()).not.toContain(EMAIL);
});

test("revealing a row does not open the order — the toggle is an interactive descendant of an activatable row", async () => {
	const onOpen = vi.fn();
	respond({
		ok: true,
		orders: LIST_ROWS,
		nextCursor: null,
		vocabulary: {
			statuses: ["paid"],
			statusAny: "any",
			periods: [{ key: "any", label: "Any time" }],
			cancellationReasons: [],
			oneClickCancellationReasons: [],
		},
	});
	const node = <OrdersList onOpen={onOpen} />;
	mounted = await mount(node);
	await mounted.rerender(node);
	const toggle = rowToggle(customerCell(mounted.container, "ord_email"));

	await fire(toggle, "mousedown", { clientX: 5, clientY: 5 });
	await fire(toggle, "click", { clientX: 5, clientY: 5 });
	expect(onOpen).not.toHaveBeenCalled();
	expect(shownRef(customerCell(mounted.container, "ord_email"))).toBe(EMAIL);
});

test("the toggle is a real, named, keyboard-reachable button that keeps focus across Show and Hide", async () => {
	const container = await mountList();
	const cell = customerCell(container, "ord_email");
	const toggle = rowToggle(cell);

	// A NATIVE BUTTON is what makes Enter and Space work: the browser turns
	// either key on a focused `<button>` into a click. happy-dom does not
	// synthesise that click from a keydown, so this pins the element that the
	// browser does it for — and then drives the click it would dispatch.
	expect(toggle.tagName).toBe("BUTTON");
	expect(toggle.type).toBe("button");
	expect(toggle.disabled).toBe(false);
	expect(toggle.hasAttribute("tabindex")).toBe(false);
	expect(toggle.className).toContain("otta-btn");
	expect(toggle.className).toContain("otta-focusable");

	// THE NAME SAYS WHAT IT REVEALS, AND WHOSE. A column of identical "Show"
	// buttons is "Show, Show, Show" to a screen reader; the order prefix tells
	// them apart. It contains the visible word, so a voice-control user can
	// say what they see.
	const label = toggle.getAttribute("aria-label") ?? "";
	expect(label).toMatch(/^Show buyer email for order #ord_/);
	expect(label).toContain(toggle.textContent ?? "");
	// It names the element it discloses.
	const controls = toggle.getAttribute("aria-controls") ?? "";
	expect(controls).not.toBe("");
	expect(document.getElementById(controls)?.textContent).toBe(MASKED);

	toggle.focus();
	expect(document.activeElement).toBe(toggle);
	await fire(toggle, "click");
	// THE SAME ELEMENT, STILL FOCUSED. Swapping one button for another on
	// toggle would drop a keyboard operator's focus to <body>.
	expect(rowToggle(cell)).toBe(toggle);
	expect(document.activeElement).toBe(toggle);
	expect(toggle.getAttribute("aria-label")).toMatch(/^Hide buyer email for order #ord_/);
	expect(document.getElementById(controls)?.textContent).toBe(EMAIL);
});

test("a buyer reference that is not an email is printed as it always was, with no toggle", async () => {
	const container = await mountList();
	const cell = customerCell(container, "ord_guest");

	expect(cell.textContent).toBe(NON_EMAIL);
	expect(cell.querySelector('[data-testid="buyer-email-toggle"]')).toBeNull();
});

test("an email search still reaches the server verbatim — masking is display, not data", async () => {
	const container = await mountList();
	const search = one<HTMLInputElement>(container, '[data-testid="filter-search"]');
	const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	await React.act(async () => {
		setValue?.call(search, EMAIL);
		search.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await React.act(async () => {
		search.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
		);
	});
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const sent = apiFetch.mock.calls
		.map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as { filter?: { search?: string } })
		.at(-1);
	expect(sent?.filter?.search).toBe(EMAIL);
});

// ── the detail ───────────────────────────────────────────────────────────────

const ORDER_ID = "7e4ce728";
const CUR = "USD";
const TOTAL_CENTS = 1_299_000;
const SHIP_EMAIL = "ship.to@parcel.example";
const ACCOUNT_EMAIL = "verified.buyer@account.example";

const CAPTURED: RefundsSummary = {
	refunds: [],
	currency: CUR,
	capturedTotalCents: TOTAL_CENTS,
	refundedTotalCents: 0,
	ceilingCents: TOTAL_CENTS,
	remainingCents: TOTAL_CENTS,
	paymentMethod: "card",
	refundable: true,
};

function detail(buyerRef: string, options: { verified?: boolean } = {}): DetailPayload {
	return {
		ok: true,
		order: {
			id: ORDER_ID,
			state: "paid",
			currency: CUR,
			paymentMethod: "card",
			buyerRef,
			customerId: "4c2a8f91-7b3e-4d6a-9f1c-8a2b3c4d5e6f",
			createdAt: "2026-03-04T10:15:00.000Z",
			reconciliationFlag: null,
			reconciliationResolution: null,
			fulfillment: null,
			cancellation: null,
			shippingAddress: {
				name: "Priya Kapoor",
				line1: "1 Example Street",
				line2: null,
				city: "Bengaluru",
				region: "KA",
				postalCode: "560001",
				country: "IN",
				email: SHIP_EMAIL,
			},
			totals: {
				currency: CUR,
				subtotalCents: TOTAL_CENTS,
				discountCents: 0,
				shippingCents: 0,
				taxCents: 0,
				totalCents: TOTAL_CENTS,
				appliedCouponCode: null,
			},
			lines: [],
		},
		transitions: [],
		customer:
			options.verified === true
				? {
						identity: {
							email: ACCOUNT_EMAIL,
							buyerRef,
							linkage: "claimed",
							emailVerifiedAt: "2026-01-01T00:00:00.000Z",
						},
						orderCount: 3,
					}
				: {
						identity: { email: null, buyerRef, linkage: "unclaimed" },
						orderCount: 1,
					},
		timeline: { entries: [] },
		refunds: CAPTURED,
		notes: [],
		vocabulary: {
			statuses: ["paid"],
			statusAny: "any",
			periods: [{ key: "any", label: "Any time" }],
			cancellationReasons: [],
			oneClickCancellationReasons: [],
			reconciliationOutcomes: [],
			pageLimit: 25,
		},
	};
}

async function showDetail(payload: DetailPayload): Promise<HTMLElement> {
	respond(payload);
	mounted = await mount(<OrderDetail orderId={ORDER_ID} onBack={() => undefined} />);
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return mounted.container;
}

function heading(container: HTMLElement): HTMLElement {
	return one<HTMLElement>(container, '[data-testid="detail-heading"]');
}

function detailToggle(container: HTMLElement): HTMLButtonElement {
	return one<HTMLButtonElement>(container, '[data-testid="detail-email-toggle"]');
}

function fieldValue(container: HTMLElement, groupTestId: string, label: string): string {
	const group = one<HTMLElement>(container, `[data-testid="${groupTestId}"]`);
	for (const entry of Array.from(group.querySelectorAll("dl > div"))) {
		if (entry.querySelector("dt")?.textContent === label) {
			return entry.querySelector("dd")?.textContent ?? "";
		}
	}
	throw new Error(`no ${label} in ${groupTestId}`);
}

function summary(container: HTMLElement, groupTestId: string): string {
	return one<HTMLElement>(container, `[data-testid="${groupTestId}"] > summary`).textContent ?? "";
}

async function openTab(container: HTMLElement, name: string): Promise<void> {
	await fire(one<HTMLButtonElement>(container, `[data-testid="tab-${name}"]`), "click");
}

test("the detail masks the heading and the customer group by default", async () => {
	const container = await showDetail(detail(EMAIL, { verified: true }));

	expect(heading(container).textContent).toContain(MASKED);
	expect(heading(container).textContent).not.toContain(EMAIL);
	expect(summary(container, "detail-customer")).toBe(`Customer — ${buyerRefHint(ACCOUNT_EMAIL)}`);
	expect(fieldValue(container, "detail-customer", "Contact email")).toBe(MASKED);
});

test("the detail masks the shipping address email too — the same toggle governs it", async () => {
	const container = await showDetail(detail(EMAIL));
	await openTab(container, "fulfilment");

	expect(fieldValue(container, "detail-shipping", "Email")).toBe(buyerRefHint(SHIP_EMAIL));
	await fire(detailToggle(container), "click");
	expect(fieldValue(container, "detail-shipping", "Email")).toBe(SHIP_EMAIL);
});

test("while masked, no buyer address on the order is anywhere in the document", async () => {
	const container = await showDetail(detail(EMAIL, { verified: true }));
	await openTab(container, "fulfilment");

	const markup = documentMarkup();
	for (const address of [EMAIL, SHIP_EMAIL, ACCOUNT_EMAIL]) {
		expect(markup, address).not.toContain(address);
	}
});

test("Show email reveals every buyer address on the order, and Hide email masks them all again", async () => {
	const container = await showDetail(detail(EMAIL, { verified: true }));
	const toggle = detailToggle(container);

	expect(toggle.textContent).toBe("Show email");
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	expect(toggle.getAttribute("aria-label")).toBe("Show email for this order's buyer");
	expect(toggle.getAttribute("aria-label")).toContain(toggle.textContent ?? "");

	await fire(toggle, "click");
	expect(heading(container).textContent).toContain(EMAIL);
	expect(summary(container, "detail-customer")).toBe(`Customer — ${ACCOUNT_EMAIL}`);
	expect(fieldValue(container, "detail-customer", "Contact email")).toBe(EMAIL);
	expect(detailToggle(container)).toBe(toggle);
	expect(toggle.textContent).toBe("Hide email");
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	expect(toggle.getAttribute("aria-label")).toBe("Hide email for this order's buyer");

	await fire(toggle, "click");
	expect(heading(container).textContent).toContain(MASKED);
	expect(documentMarkup()).not.toContain(EMAIL);
});

test("the detail toggle is a real button outside the heading, so the h1 names the order and not a control", async () => {
	const container = await showDetail(detail(EMAIL));
	const toggle = detailToggle(container);

	expect(toggle.tagName).toBe("BUTTON");
	expect(toggle.type).toBe("button");
	expect(toggle.className).toContain("otta-btn");
	expect(toggle.className).toContain("otta-focusable");
	expect(heading(container).contains(toggle)).toBe(false);
	const controls = (toggle.getAttribute("aria-controls") ?? "").split(" ")[0] ?? "";
	expect(heading(container).querySelector(`[id="${controls}"]`)?.textContent).toBe(MASKED);

	toggle.focus();
	await fire(toggle, "click");
	expect(document.activeElement).toBe(toggle);
});

test("an order whose buyer reference is not an email prints it as-is and offers no toggle when nothing else is maskable", async () => {
	const payload = detail(NON_EMAIL);
	const container = await showDetail({
		...payload,
		order: { ...payload.order, shippingAddress: null },
	});

	expect(heading(container).textContent).toContain(NON_EMAIL);
	expect(container.querySelector('[data-testid="detail-email-toggle"]')).toBeNull();
});

// ── the refund confirm: the one place an address reaches a dialog ────────────

async function openRefundConfirm(container: HTMLElement): Promise<HTMLElement> {
	await openTab(container, "money");
	await fire(one<HTMLButtonElement>(container, '[data-testid="refund-full"]'), "click");
	return one<HTMLElement>(container, '[data-testid="otta-confirm-text"]');
}

const AMOUNT = formatAmount(TOTAL_CENTS, CUR);

test("the refund confirm names the masked buyer while the order is masked", async () => {
	const container = await showDetail(detail(EMAIL));
	const text = await openRefundConfirm(container);

	expect(text.textContent).toBe(refundConfirmText(ORDER_ID, AMOUNT, MASKED, true));
	expect(documentMarkup()).not.toContain(EMAIL);
});

test("the refund confirm masks a PROVEN account email too, and names it in full once revealed", async () => {
	const container = await showDetail(detail(EMAIL, { verified: true }));
	await fire(detailToggle(container), "click");
	const text = await openRefundConfirm(container);

	expect(text.textContent).toBe(refundConfirmText(ORDER_ID, AMOUNT, ACCOUNT_EMAIL, true));
});

test("a masked proven email is still the confirm's recipient — masking does not change WHO is named", async () => {
	const container = await showDetail(detail(EMAIL, { verified: true }));
	const text = await openRefundConfirm(container);

	expect(text.textContent).toBe(
		refundConfirmText(ORDER_ID, AMOUNT, buyerRefHint(ACCOUNT_EMAIL), true),
	);
});

test("a non-email buyer reference reaches the refund confirm unmasked, exactly as before", async () => {
	const container = await showDetail(detail(NON_EMAIL));
	const text = await openRefundConfirm(container);

	expect(text.textContent).toBe(refundConfirmText(ORDER_ID, AMOUNT, NON_EMAIL, true));
});

test("revealing is not remembered: a fresh mount of the same order is masked again", async () => {
	const container = await showDetail(detail(EMAIL));
	await fire(detailToggle(container), "click");
	expect(heading(container).textContent).toContain(EMAIL);

	await mounted?.unmount();
	mounted = null;
	const again = await showDetail(detail(EMAIL));
	expect(heading(again).textContent).toContain(MASKED);
	expect(heading(again).textContent).not.toContain(EMAIL);
});

async function settle(): Promise<void> {
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

test("moving to another order and back WITHOUT a remount masks the first order again", async () => {
	const OTHER_ID = "9a1b2c3d";
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { orderId?: string };
		const base = detail(EMAIL);
		const payload =
			body.orderId === OTHER_ID ? { ...base, order: { ...base.order, id: OTHER_ID } } : base;
		return Promise.resolve(
			new Response(JSON.stringify({ data: payload }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
	mounted = await mount(<OrderDetail orderId={ORDER_ID} onBack={() => undefined} />);
	await settle();
	await fire(detailToggle(mounted.container), "click");
	expect(heading(mounted.container).textContent).toContain(EMAIL);

	await mounted.rerender(<OrderDetail orderId={OTHER_ID} onBack={() => undefined} />);
	await settle();
	expect(heading(mounted.container).textContent).toContain(MASKED);

	await mounted.rerender(<OrderDetail orderId={ORDER_ID} onBack={() => undefined} />);
	// Masked from the very first paint back on A, not only after its re-read.
	expect(heading(mounted.container).textContent).not.toContain(EMAIL);
	await settle();
	expect(heading(mounted.container).textContent).toContain(MASKED);
	expect(heading(mounted.container).textContent).not.toContain(EMAIL);
	expect(detailToggle(mounted.container).getAttribute("aria-expanded")).toBe("false");
});

test("the detail toggle names every mounted element it discloses in aria-controls", async () => {
	const container = await showDetail(detail(EMAIL, { verified: true }));
	const ids = (detailToggle(container).getAttribute("aria-controls") ?? "").split(/\s+/);
	const texts = ids.map((id) => document.getElementById(id)?.textContent);
	// Heading value, Customer group title value, Contact email value — the
	// Shipping email is on the Fulfilment tab and not mounted, so not named.
	expect(texts).toEqual([MASKED, buyerRefHint(ACCOUNT_EMAIL), MASKED]);

	await openTab(container, "fulfilment");
	const after = (detailToggle(container).getAttribute("aria-controls") ?? "").split(/\s+/);
	expect(after.map((id) => document.getElementById(id)?.textContent)).toEqual([
		MASKED,
		buyerRefHint(SHIP_EMAIL),
	]);
});
