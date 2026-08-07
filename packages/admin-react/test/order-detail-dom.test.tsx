/**
 * @vitest-environment happy-dom
 *
 * The order detail screen, through a real mount of the real component.
 *
 * WHY A DOCUMENT. Everything below is decided inside the mounted screen and
 * nowhere else: the status cell is drawn from the loaded record, the money
 * surfaces sit behind a tab that only a click reaches, and the provider warning
 * is withdrawn by the panel's own mode rather than by anything a caller passes.
 * A static render of the isolated panel can state what the panel does with the
 * props it is handed; it cannot state that the SCREEN hands it those props, and
 * an inverted decision in the screen leaves such a suite entirely green.
 *
 * WHY THE ASSERTIONS ARE SCOPED TO THE FIELD OR THE TABLE THAT OWNS THE
 * DECISION. The detail mounts several `dl` strips, four tables and two dialogs,
 * and shares ids between them. A substring search over the markup answers
 * "somewhere on this screen" for a claim that is about one cell, which is how a
 * per-field decision gets a test that cannot tell fields apart.
 *
 * WHY THE FIXTURE'S FIGURES ALL CROSS A THOUSANDS SEPARATOR. An amount like
 * `1999` renders the same whether the formatter produced it or a call site
 * assembled `$` and a division by a hundred, so a fixture made of small amounts
 * cannot tell a formatted total from a hand-built one. Every amount here groups.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrderDetail, REFUND_RECIPIENT_MAX_LEN } = await import("../src/orders/order-detail.js");
const {
	ABSENT,
	UNNAMED_REFUND_RECIPIENT,
	fit,
	formatAmount,
	orderStateCell,
	refundCapabilityText,
	refundConfirmText,
} = await import("@otta-sh/admin-presentation");
type DetailPayload = import("../src/console-api.js").DetailPayload;
type RefundsSummary = import("../src/console-api.js").RefundsSummary;
type Vocabulary = import("../src/console-api.js").Vocabulary;

// ── the record under the screen ──────────────────────────────────────────────

const CUR = "USD";
const ORDER_ID = "7e4ce728";

const UNIT_PRICE_CENTS = 649_500;
const QUANTITY = 2;
const SUBTOTAL_CENTS = UNIT_PRICE_CENTS * QUANTITY;
const DISCOUNT_CENTS = 50_000;
const SHIPPING_CENTS = 125_000;
const TAX_CENTS = 98_750;
const TOTAL_CENTS = SUBTOTAL_CENTS - DISCOUNT_CENTS + SHIPPING_CENTS + TAX_CENTS;
const REFUNDED_CENTS = 500_000;

const VOCABULARY: Vocabulary = {
	statuses: ["paid", "failed", "delivered", "cancelled"],
	statusAny: "any",
	periods: [{ key: "any", label: "Any time" }],
	cancellationReasons: [],
	oneClickCancellationReasons: [],
	reconciliationOutcomes: [],
	pageLimit: 25,
};

function refundRow(amountCents: number): RefundsSummary["refunds"][number] {
	return {
		amountCents,
		currency: CUR,
		providerRef: "rf_synthetic_0001",
		refundedBy: "ops@example.test",
		createdAt: "2026-03-04T11:00:00.000Z",
	};
}

/** Captured in full, part of it refunded — the ordinary state of an order with
 *  money on it. The capture equals the frozen total because that is the only
 *  amount a settlement records. */
const CAPTURED: RefundsSummary = {
	refunds: [refundRow(REFUNDED_CENTS)],
	currency: CUR,
	capturedTotalCents: TOTAL_CENTS,
	refundedTotalCents: REFUNDED_CENTS,
	ceilingCents: TOTAL_CENTS,
	remainingCents: TOTAL_CENTS - REFUNDED_CENTS,
	paymentMethod: "card",
	refundable: true,
};

/** Captured, then refunded down to nothing. Its remainder is the same zero the
 *  never-captured order carries, and only one of the two has nothing to say —
 *  which is why the remainder can never be what withdraws the warning. */
const FULLY_REFUNDED: RefundsSummary = {
	...CAPTURED,
	refunds: [refundRow(TOTAL_CENTS)],
	refundedTotalCents: TOTAL_CENTS,
	remainingCents: 0,
};

/** Payment never succeeded: nothing was captured, so the ceiling is zero and
 *  there is no refund to describe. `refundable` stays TRUE so a gate that read
 *  the gateway's capability instead of the ceiling cannot pass by accident. */
const NEVER_CAPTURED: RefundsSummary = {
	refunds: [],
	currency: CUR,
	capturedTotalCents: 0,
	refundedTotalCents: 0,
	ceilingCents: 0,
	remainingCents: 0,
	paymentMethod: "card",
	refundable: true,
};

function detailFor(state: string, refunds: RefundsSummary = CAPTURED): DetailPayload {
	return {
		ok: true,
		order: {
			id: ORDER_ID,
			state,
			currency: CUR,
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
				currency: CUR,
				subtotalCents: SUBTOTAL_CENTS,
				discountCents: DISCOUNT_CENTS,
				shippingCents: SHIPPING_CENTS,
				taxCents: TAX_CENTS,
				totalCents: TOTAL_CENTS,
				appliedCouponCode: null,
			},
			lines: [
				{
					sku: "APR-LIN-NAT",
					title: "Linen apron",
					unitPriceCents: UNIT_PRICE_CENTS,
					currency: CUR,
					quantity: QUANTITY,
					fulfillmentKind: "physical",
				},
			],
		},
		transitions: [],
		customer: null,
		timeline: { entries: [] },
		refunds,
		notes: [],
		vocabulary: VOCABULARY,
	};
}

/** `detailFor` with the buyer identity overridden — everything else about the
 *  fixture (money, lines, refunds) is irrelevant to the heading/confirm bug,
 *  so this reuses `detailFor`'s record rather than repeating it. */
function withIdentity(
	payload: DetailPayload,
	buyerRef: string,
	customerId: string | null,
): DetailPayload {
	return { ...payload, order: { ...payload.order, buyerRef, customerId } };
}

/** `detailFor` with a `CustomerContext` attached whose email is PROVEN —
 *  `linkage: "claimed"` AND a real `emailVerifiedAt`. This is the ONLY
 *  identity shape `resolveRefundRecipient` may skip its clamp for (review
 *  finding N2); {@link withUnverifiedEmail} covers every shape that must
 *  NOT qualify. */
function withVerifiedEmail(payload: DetailPayload, email: string): DetailPayload {
	return {
		...payload,
		customer: {
			identity: {
				email,
				buyerRef: payload.order.buyerRef,
				linkage: "claimed",
				emailVerifiedAt: "2026-01-01T00:00:00.000Z",
			},
			orderCount: 1,
		},
	};
}

/**
 * `detailFor` with a `CustomerContext` whose email is PRESENT but NOT
 * proven — no `emailVerifiedAt`, or a `linkage` short of `"claimed"`. This is
 * the exact shape review finding N2 named as the vulnerability: on
 * `linkage: "unclaimed"` the account is resolved by looking up the
 * caller-supplied `buyerRef` itself (`domain/src/orders/customer-context.ts`),
 * so an email reached that way is the SAME untrusted value laundered through
 * a lookup, not a second, independent source — and `identity.email` being
 * merely present proves nothing on its own even when `linkage` says
 * `"claimed"`, if the account was never actually verified.
 */
function withUnverifiedEmail(
	payload: DetailPayload,
	email: string,
	linkage: "claimed" | "unclaimed" = "unclaimed",
): DetailPayload {
	return {
		...payload,
		customer: {
			identity: {
				email,
				buyerRef: payload.order.buyerRef,
				linkage,
				emailVerifiedAt: null,
			},
			orderCount: 1,
		},
	};
}

// ── mounting ─────────────────────────────────────────────────────────────────

let mounted: Mounted | null = null;

beforeEach(() => {
	apiFetch.mockReset();
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

/** Mount the screen over one loaded record, then let the load effect's promise
 *  chain land before asserting. */
async function show(payload: DetailPayload): Promise<Mounted> {
	await mounted?.unmount();
	mounted = null;
	apiFetch.mockImplementation(() =>
		Promise.resolve(
			new Response(JSON.stringify({ data: payload }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		),
	);
	const view = await mount(<OrderDetail orderId={ORDER_ID} onBack={() => undefined} />);
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	mounted = view;
	return view;
}

function one<T extends Element>(view: Mounted, selector: string): T {
	const found = view.container.querySelector<T>(selector);
	if (found === null) throw new Error(`nothing matched ${selector}`);
	return found;
}

function tab(view: Mounted, name: string): HTMLButtonElement {
	return one<HTMLButtonElement>(view, `[data-testid="tab-${name}"]`);
}

/** The value under ONE label of ONE field strip. The screen renders several
 *  strips; reading a label without naming its strip reads whichever came
 *  first. */
function fieldValue(view: Mounted, testId: string, label: string): HTMLElement {
	const strip = one(view, `[data-testid="${testId}"]`);
	for (const entry of Array.from(strip.children)) {
		if (entry.querySelector("dt")?.textContent === label) {
			const value = entry.querySelector<HTMLElement>("dd");
			if (value === null) throw new Error(`${testId}/${label} has no value`);
			return value;
		}
	}
	throw new Error(`no ${label} in ${testId}`);
}

function table(view: Mounted, testId: string): HTMLTableElement {
	return one<HTMLTableElement>(view, `table[data-testid="${testId}"]`);
}

function bodyRows(node: HTMLTableElement): HTMLTableRowElement[] {
	return [...node.querySelectorAll<HTMLTableRowElement>("tbody > tr")];
}

function cellIn(
	node: HTMLTableElement,
	rowIndex: number,
	columnIndex: number,
): HTMLTableCellElement {
	const found = bodyRows(node).at(rowIndex)?.cells.item(columnIndex) ?? null;
	if (found === null) throw new Error(`no cell ${String(rowIndex)}/${String(columnIndex)}`);
	return found;
}

/**
 * A column's alignment, read from the header's own word and from every cell
 * under it.
 *
 * The header is measured through the span INSIDE it rather than through the
 * `th`: a column end-aligned by its cells alone leaves the word standing over
 * the wrong edge of the figures it names, which is the half of this that is
 * easiest to lose and impossible to see in a cells-only assertion.
 */
function columnAlignment(node: HTMLTableElement, index: number): readonly string[] {
	const header = node.querySelectorAll<HTMLTableCellElement>("th.otta-th").item(index);
	if (header === null) throw new Error(`no header ${String(index)}`);
	const word = header.querySelector("span");
	return [
		word === null ? "" : word.style.textAlign,
		...bodyRows(node).map((row) => row.cells.item(index)?.style.textAlign ?? ""),
	];
}

// ── D1: one status wears a ring, every other one is a word ───────────────────

test("the one order state that needs attention is the only one wearing a ring", async () => {
	const view = await show(detailFor("failed"));
	const marked = fieldValue(view, "detail-identity", "Status");
	const pill = marked.querySelector("[data-tone]");
	expect(pill).not.toBeNull();
	expect(pill?.getAttribute("data-tone")).toBe("fail");
	// The pill wraps the shared phrase; it does not make one.
	expect(pill?.textContent).toBe(orderStateCell("failed"));
});

test("every other order state on the detail is drawn as the bare phrase", async () => {
	// Three states the service ships today and one it does not: the decision is
	// an equality against a single literal, so a status invented upstream later
	// arrives here bare rather than pilled by a match that broadened to fit.
	for (const state of ["paid", "delivered", "cancelled", "refunded", "quarantined"]) {
		const view = await show(detailFor(state));
		const bare = fieldValue(view, "detail-identity", "Status");
		expect(bare.querySelector("[data-tone]"), `${state} is wearing a ring`).toBeNull();
		expect(bare.textContent).toBe(orderStateCell(state));
	}
});

// ── the tab strip, which is how three of the four panels are reached ──────────

test("the tab strip moves the panel and says which tab owns it", async () => {
	const view = await show(detailFor("paid"));
	const orderTab = tab(view, "order");
	const moneyTab = tab(view, "money");

	expect(orderTab.getAttribute("aria-selected")).toBe("true");
	expect(moneyTab.getAttribute("aria-selected")).toBe("false");
	expect(view.container.querySelector('[data-testid="detail-lines"]')).not.toBeNull();
	expect(view.container.querySelector('[data-testid="detail-money"]')).toBeNull();

	await fire(moneyTab, "click");

	expect(orderTab.getAttribute("aria-selected")).toBe("false");
	expect(moneyTab.getAttribute("aria-selected")).toBe("true");
	expect(view.container.querySelector('[data-testid="detail-money"]')).not.toBeNull();
	expect(view.container.querySelector('[data-testid="detail-lines"]')).toBeNull();
	// The panel points back at the tab that selected it, which is the whole of
	// what makes the strip operable by anything other than a pointer.
	const panel = one(view, '[role="tabpanel"]');
	expect(panel.getAttribute("aria-labelledby")).toBe(moneyTab.id);
	expect(panel.id).toBe(moneyTab.getAttribute("aria-controls"));
});

// ── the provider warning, wired through the mounted screen ───────────────────

test("an order that was never captured is told nothing about how a refund moves money", async () => {
	const view = await show(detailFor("failed", NEVER_CAPTURED));
	await fire(tab(view, "money"), "click");

	const group = one(view, '[data-testid="detail-refunds"]');
	expect(group.querySelector('[data-testid="refund-capability"]')).toBeNull();
	// A warning about a real refund through the provider, beside a heading
	// saying nothing was ever captured, is the defect this replaces.
	expect(group.textContent).not.toContain("Stripe");
	// And it is the CEILING that withdrew it, not the gateway's capability: this
	// record reports a refundable gateway and still says nothing.
	expect(NEVER_CAPTURED.refundable).toBe(true);
});

test("an order with a real capture still states how a refund would move money", async () => {
	const view = await show(detailFor("paid", CAPTURED));
	await fire(tab(view, "money"), "click");

	const line = one(view, '[data-testid="refund-capability"]');
	expect(line.textContent).toBe(refundCapabilityText(true, "card"));
});

test("a capture refunded down to nothing keeps the line its remainder cannot justify", async () => {
	const view = await show(detailFor("refunded", FULLY_REFUNDED));
	await fire(tab(view, "money"), "click");

	expect(one(view, '[data-testid="refund-capability"]').textContent).toBe(
		refundCapabilityText(true, "card"),
	);
	// Same remainder as the never-captured order above, opposite outcome. A gate
	// re-derived from the remaining amount reads these two as one case.
	expect(FULLY_REFUNDED.remainingCents).toBe(NEVER_CAPTURED.remainingCents);
});

// ── F17: figures end-aligned, header and column together ─────────────────────

test("every figure column on the detail is end-aligned, header and cells together", async () => {
	const view = await show(detailFor("paid", CAPTURED));

	const lines = table(view, "detail-lines");
	// SKU and Title are words and stay where words go.
	expect(columnAlignment(lines, 0)).toEqual(["", ""]);
	expect(columnAlignment(lines, 1)).toEqual(["", ""]);
	// Qty, unit price and line total are figures.
	expect(columnAlignment(lines, 2)).toEqual(["end", "end"]);
	expect(columnAlignment(lines, 3)).toEqual(["end", "end"]);
	expect(columnAlignment(lines, 4)).toEqual(["end", "end"]);

	const totals = table(view, "detail-totals");
	expect(columnAlignment(totals, 0)).toEqual(["", "", "", "", "", ""]);
	expect(columnAlignment(totals, 1)).toEqual(["end", "end", "end", "end", "end", "end"]);

	await fire(tab(view, "money"), "click");
	const ledger = table(view, "detail-refund-ledger");
	expect(columnAlignment(ledger, 0)).toEqual(["end", "end"]);
});

// ── the amounts themselves, not merely the edge they sit on ──────────────────

test("every amount on the detail is the one the formatter makes of the record", async () => {
	const view = await show(detailFor("paid", CAPTURED));

	// A cell that alignment tests alone would let a hand-assembled string, or a
	// hard-coded zero, sit in unnoticed.
	expect(fieldValue(view, "detail-identity", "Total").textContent).toBe(
		formatAmount(TOTAL_CENTS, CUR),
	);

	const lines = table(view, "detail-lines");
	expect(cellIn(lines, 0, 2).textContent).toBe(String(QUANTITY));
	expect(cellIn(lines, 0, 3).textContent).toBe(formatAmount(UNIT_PRICE_CENTS, CUR));
	expect(cellIn(lines, 0, 4).textContent).toBe(formatAmount(UNIT_PRICE_CENTS * QUANTITY, CUR));

	const totals = table(view, "detail-totals");
	expect(bodyRows(totals).map((row) => row.cells.item(1)?.textContent)).toEqual(
		[SUBTOTAL_CENTS, DISCOUNT_CENTS, SHIPPING_CENTS, TAX_CENTS, TOTAL_CENTS].map((amount) =>
			formatAmount(amount, CUR),
		),
	);

	await fire(tab(view, "money"), "click");

	expect(fieldValue(view, "detail-money", "Captured").textContent).toBe(
		formatAmount(TOTAL_CENTS, CUR),
	);
	expect(fieldValue(view, "detail-money", "Refunded").textContent).toBe(
		formatAmount(REFUNDED_CENTS, CUR),
	);
	expect(fieldValue(view, "detail-money", "Remaining refundable").textContent).toBe(
		formatAmount(TOTAL_CENTS - REFUNDED_CENTS, CUR),
	);
	// A count, not an amount — and one that must not learn to format itself.
	expect(fieldValue(view, "detail-money", "Refunds recorded").textContent).toBe("1");

	expect(cellIn(table(view, "detail-refund-ledger"), 0, 0).textContent).toBe(
		formatAmount(REFUNDED_CENTS, CUR),
	);

	// The full-refund button's own label, not merely a money cell beside it — a
	// hand-assembled `$${(cents / 100).toFixed(2)}` reads identically to the
	// formatter's output for round amounts, so this has to check the string the
	// formatter itself makes of the fixture's remainder.
	const refundFull = one<HTMLButtonElement>(view, '[data-testid="refund-full"]');
	expect(refundFull.textContent).toBe(
		`Refund ${formatAmount(CAPTURED.remainingCents, CUR)} (full remaining)`,
	);
});

// ── THE DEFECT: the heading and the refund confirm both named the opaque
// customer id on a CLAIMED order, the same bug as the list's Customer cell ──

const CLAIMED_BUYER_REF = "priya.kapoor@example.test";
const CLAIMED_CUSTOMER_ID = "4c2a8f91-7b3e-4d6a-9f1c-8a2b3c4d5e6f";

/** Open the refund confirm over a `CAPTURED`-refunds record and return its
 *  text node — every confirm-recipient test below needs exactly this. */
async function openRefundConfirm(payload: DetailPayload): Promise<HTMLElement> {
	const view = await show(payload);
	await fire(tab(view, "money"), "click");
	await fire(one<HTMLButtonElement>(view, '[data-testid="refund-full"]'), "click");
	return one<HTMLElement>(view, '[data-testid="otta-confirm-text"]');
}

const CAPTURED_REFUND_AMOUNT = formatAmount(CAPTURED.remainingCents, CUR);

test("the heading names the readable buyer reference, not the opaque customer id, for a claimed order", async () => {
	const view = await show(withIdentity(detailFor("paid"), CLAIMED_BUYER_REF, CLAIMED_CUSTOMER_ID));

	const heading = one<HTMLHeadingElement>(view, '[data-testid="detail-heading"]');
	expect(heading.textContent).toContain(CLAIMED_BUYER_REF);
	expect(heading.textContent).not.toContain(CLAIMED_CUSTOMER_ID);
});

test("the heading still names the buyer reference on an unclaimed/guest order, and carries no data-customer-id attribute", async () => {
	const view = await show(withIdentity(detailFor("paid"), "guest_checkout_551", null));

	const heading = one<HTMLHeadingElement>(view, '[data-testid="detail-heading"]');
	expect(heading.textContent).toContain("guest_checkout_551");
	expect(heading.hasAttribute("data-customer-id")).toBe(false);
	expect(heading.getAttribute("data-customer-id")).toBeNull();
});

test("the customer id stays reachable from the heading, as a non-focusable data attribute", async () => {
	const view = await show(withIdentity(detailFor("paid"), CLAIMED_BUYER_REF, CLAIMED_CUSTOMER_ID));

	const heading = one<HTMLHeadingElement>(view, '[data-testid="detail-heading"]');
	expect(heading.getAttribute("data-customer-id")).toBe(CLAIMED_CUSTOMER_ID);
	// Still an h1 — no tabindex, no role that would make it a second focusable
	// stop on a screen whose only tab-order additions are its own controls.
	expect(heading.hasAttribute("tabindex")).toBe(false);
});

test("an empty buyer reference renders the shared em dash in the heading, never the customer id and never blank", async () => {
	const view = await show(withIdentity(detailFor("paid"), "", CLAIMED_CUSTOMER_ID));

	const heading = one<HTMLHeadingElement>(view, '[data-testid="detail-heading"]');
	expect(heading.textContent).toContain(ABSENT);
	expect(heading.textContent).not.toContain(CLAIMED_CUSTOMER_ID);
	expect(heading.textContent).not.toContain("null");
	// The id is still on the row even though the heading has nothing readable —
	// an operator can still act on the order from the id alone.
	expect(heading.getAttribute("data-customer-id")).toBe(CLAIMED_CUSTOMER_ID);
});

/** Reviewer B: `.length > 0` alone is true for `" "` — the heading would
 *  render a bare, blank-LOOKING space rather than the required em dash. */
test("a whitespace-only buyer reference renders the shared em dash in the heading, not a blank-looking space", async () => {
	const view = await show(withIdentity(detailFor("paid"), "   ", CLAIMED_CUSTOMER_ID));

	const heading = one<HTMLHeadingElement>(view, '[data-testid="detail-heading"]');
	expect(heading.textContent).toContain(ABSENT);
});

/**
 * REVIEW ROUND 3, FINDING 3 (both reviewers, independently). The heading's
 * CSS containment (`overflowWrap: "anywhere"`, review round 3 N1/B-3) shipped
 * with no test — a future style refactor could drop it silently, and only a
 * screenshot review would have caught it. `happy-dom` can read the computed
 * inline style without a real layout engine, so this pins the DECLARATION;
 * the actual wrapping behaviour is what round 3's screenshots demonstrate.
 */
test("the heading declares overflow-wrap: anywhere, so a long unbroken token wraps instead of overflowing", async () => {
	const view = await show(withIdentity(detailFor("paid"), CLAIMED_BUYER_REF, CLAIMED_CUSTOMER_ID));

	const heading = one<HTMLHeadingElement>(view, '[data-testid="detail-heading"]');
	expect(heading.style.overflowWrap).toBe("anywhere");
});

/**
 * THE COUNTERPART TO THE CONFIRM'S CLAMP TEST. `resolveRefundRecipient`
 * clamps `buyerRef` because it is PROSE — a sentence that cannot wrap its
 * way out of a reshaping attack. The heading is not prose; it is a label,
 * and the whole point of round 3's fix is that it contains a long value with
 * CSS instead of truncating it. A future "fix" that reached for `fit()` here
 * — the obvious move, having just added it to the confirm — would still pass
 * every OTHER test in this file, because none of them assert the heading
 * renders the FULL value. This one does.
 */
test("the heading renders a long buyer reference IN FULL, unclamped — containment, not truncation", async () => {
	// One character past the confirm's own clamp, so a regression that
	// accidentally routed this through `REFUND_RECIPIENT_MAX_LEN`/`fit()`
	// would be caught by length alone, before even checking for an ellipsis.
	const longBuyerRef = `wrap-not-clamp-${"y".repeat(REFUND_RECIPIENT_MAX_LEN + 1)}`;
	const view = await show(withIdentity(detailFor("paid"), longBuyerRef, CLAIMED_CUSTOMER_ID));

	const heading = one<HTMLHeadingElement>(view, '[data-testid="detail-heading"]');
	expect(heading.textContent).toContain(longBuyerRef);
	expect(heading.textContent).not.toContain("…");
});

// ── THE REFUND CONFIRM: a stricter, separate question from the heading's ────
//
// Review found several problems across two rounds, all in this one sentence:
// the em dash was fed into it as a NOUN ("refund $42 to —?"); the unverified
// `buyerRef` replaced a previously-proven account id with no clamp; a PRESENT
// email was treated as a PROVEN one, when `linkage: "unclaimed"` resolves that
// email by looking up the caller-supplied `buyerRef` itself — the untrusted
// value laundered through a lookup; and the untrusted token was undelimited.
//
// Every test below reads `otta-confirm-text` against the FULL string
// `refundConfirmText` itself would produce for the same arguments — not a
// substring — so a future change AT THIS CALL SITE that keeps the right
// recipient but drops the id, the amount or the consequence clause fails
// here. A change INSIDE `refundConfirmText` (e.g. its quoting or its own
// overflow fallback) would NOT be caught by these — that function has its
// own direct unit tests in `admin-presentation/test/presentation.test.ts`
// (review finding N6 / reviewer B), which is where a copy edit that dropped
// the amount would actually be caught.

test("the refund confirm prefers buyerRef over the customer id when there is no proven email, and states the exact sentence refundConfirmText would", async () => {
	const confirmText = await openRefundConfirm(
		withIdentity(detailFor("paid", CAPTURED), CLAIMED_BUYER_REF, CLAIMED_CUSTOMER_ID),
	);

	expect(confirmText.textContent).toBe(
		refundConfirmText(ORDER_ID, CAPTURED_REFUND_AMOUNT, CLAIMED_BUYER_REF, CAPTURED.refundable),
	);
	expect(confirmText.textContent).not.toContain(CLAIMED_CUSTOMER_ID);
});

test("a PROVEN account email — claimed AND verified — outranks buyerRef in the refund confirm", async () => {
	const VERIFIED_EMAIL = "verified.buyer@example.test";
	const payload = withVerifiedEmail(
		withIdentity(detailFor("paid", CAPTURED), CLAIMED_BUYER_REF, CLAIMED_CUSTOMER_ID),
		VERIFIED_EMAIL,
	);
	const confirmText = await openRefundConfirm(payload);

	expect(confirmText.textContent).toBe(
		refundConfirmText(ORDER_ID, CAPTURED_REFUND_AMOUNT, VERIFIED_EMAIL, CAPTURED.refundable),
	);
	expect(confirmText.textContent).not.toContain(CLAIMED_BUYER_REF);
	expect(confirmText.textContent).not.toContain(CLAIMED_CUSTOMER_ID);
});

/**
 * REVIEW FINDING N2, THE CORE OF IT. An unclaimed account's email is
 * resolved BY LOOKING UP the caller-supplied `buyerRef` — so treating that
 * email as "verified" is the untrusted value laundered through a lookup and
 * then exempted from the clamp meant to contain it. This must take the SAME
 * clamped path as `buyerRef` on its own, not the unclamped email path.
 */
test("an email reached through an UNCLAIMED lookup does not outrank buyerRef in the refund confirm", async () => {
	const LOOKED_UP_EMAIL = "resolved-by-lookup@example.test";
	const payload = withUnverifiedEmail(
		withIdentity(detailFor("paid", CAPTURED), CLAIMED_BUYER_REF, CLAIMED_CUSTOMER_ID),
		LOOKED_UP_EMAIL,
		"unclaimed",
	);
	const confirmText = await openRefundConfirm(payload);

	expect(confirmText.textContent).toBe(
		refundConfirmText(ORDER_ID, CAPTURED_REFUND_AMOUNT, CLAIMED_BUYER_REF, CAPTURED.refundable),
	);
	expect(confirmText.textContent).not.toContain(LOOKED_UP_EMAIL);
});

/** The other half of N2: `linkage: "claimed"` alone is not enough either —
 *  an email present with no `emailVerifiedAt` is exactly as unproven as one
 *  reached by an unclaimed lookup, and must take the same clamped path. */
test("a claimed account with no verified-at timestamp does not outrank buyerRef in the refund confirm", async () => {
	const UNVERIFIED_EMAIL = "claimed-not-verified@example.test";
	const payload = withUnverifiedEmail(
		withIdentity(detailFor("paid", CAPTURED), CLAIMED_BUYER_REF, CLAIMED_CUSTOMER_ID),
		UNVERIFIED_EMAIL,
		"claimed",
	);
	const confirmText = await openRefundConfirm(payload);

	expect(confirmText.textContent).toBe(
		refundConfirmText(ORDER_ID, CAPTURED_REFUND_AMOUNT, CLAIMED_BUYER_REF, CAPTURED.refundable),
	);
	expect(confirmText.textContent).not.toContain(UNVERIFIED_EMAIL);
});

test("a null customer context (context unavailable) falls through to buyerRef in the refund confirm, not an error state", async () => {
	// `detailFor` already leaves `customer: null` — the ordinary "could not be
	// loaded" state — so this is the fixture's default, named explicitly.
	const confirmText = await openRefundConfirm(
		withIdentity(detailFor("paid", CAPTURED), CLAIMED_BUYER_REF, CLAIMED_CUSTOMER_ID),
	);
	expect(confirmText.textContent).toBe(
		refundConfirmText(ORDER_ID, CAPTURED_REFUND_AMOUNT, CLAIMED_BUYER_REF, CAPTURED.refundable),
	);
});

test("with no proven email and no buyer reference, the refund confirm falls back to the shared phrase, never the em dash as a noun", async () => {
	const confirmText = await openRefundConfirm(withIdentity(detailFor("paid", CAPTURED), "", null));

	expect(confirmText.textContent).toBe(
		refundConfirmText(
			ORDER_ID,
			CAPTURED_REFUND_AMOUNT,
			UNNAMED_REFUND_RECIPIENT,
			CAPTURED.refundable,
		),
	);
	// THE EM DASH IS NEVER A NOUN (finding N1/2026-08 round 2): "to "—"?" is
	// exactly the defect this fallback replaces. The sentence template
	// legitimately uses the same glyph as PUNCTUATION ("Order #… — refund
	// …"), so the check is for the QUOTED dash in the RECIPIENT position
	// specifically, not for the character's absence from the string.
	expect(confirmText.textContent).not.toContain(`to "${ABSENT}"?`);
});

test("a whitespace-only buyer reference is treated as no reference in the refund confirm too", async () => {
	const confirmText = await openRefundConfirm(
		withIdentity(detailFor("paid", CAPTURED), "   ", CLAIMED_CUSTOMER_ID),
	);
	expect(confirmText.textContent).toBe(
		refundConfirmText(
			ORDER_ID,
			CAPTURED_REFUND_AMOUNT,
			UNNAMED_REFUND_RECIPIENT,
			CAPTURED.refundable,
		),
	);
});

/**
 * `buyerRef` is unverified, caller-supplied free text up to 320 characters,
 * and a value short enough to stay under the confirm's own 200-character
 * budget can still reshape the sentence an operator is asked to approve. The
 * clamp is the defence — enforced HERE, not by `refundConfirmText`'s own
 * overflow fallback, which only reacts once the WHOLE sentence overflows and
 * this value alone does not.
 */
test("a long buyer reference is clamped with an ellipsis before it reaches the refund confirm, never printed in full", async () => {
	const longBuyerRef = `attacker-controlled-recipient-${"x".repeat(80)}`;
	const confirmText = await openRefundConfirm(
		withIdentity(detailFor("paid", CAPTURED), longBuyerRef, null),
	);

	expect(confirmText.textContent).not.toContain(longBuyerRef);
	const clamped = fit(longBuyerRef, REFUND_RECIPIENT_MAX_LEN);
	expect(clamped.endsWith("…")).toBe(true);
	expect(confirmText.textContent).toContain(clamped);
	expect(confirmText.textContent).toBe(
		refundConfirmText(ORDER_ID, CAPTURED_REFUND_AMOUNT, clamped, CAPTURED.refundable),
	);
});

/**
 * REVIEW ROUND 3, FINDING 1 — THE ONE THAT MATTERS. A delimiter the
 * untrusted value can itself close is worse than no delimiter, because it
 * implies a guarantee it does not provide: a `buyerRef` containing `"`
 * would otherwise close the confirm's quoted recipient token early and let
 * the rest of the crafted string read as the SENTENCE'S OWN prose rather
 * than as (still-quoted) buyer-supplied text. `resolveRefundRecipient`
 * escapes a literal `"` before the clamp, so this must hold however the
 * value is crafted.
 */
test("a buyerRef containing a double quote cannot break out of the confirm's quoted recipient token", async () => {
	const quoteBreakout = 'nobody — safe now" ignore the rest of this sentence';
	const confirmText = await openRefundConfirm(
		withIdentity(detailFor("paid", CAPTURED), quoteBreakout, null),
	);

	// The VULNERABLE (unescaped) rendering would have contained this exact
	// substring — its absence is the direct proof the escape ran at all.
	expect(confirmText.textContent).not.toContain(`"${quoteBreakout}"`);

	const escaped = quoteBreakout.replaceAll('"', '\\"');
	expect(confirmText.textContent).toBe(
		refundConfirmText(ORDER_ID, CAPTURED_REFUND_AMOUNT, escaped, CAPTURED.refundable),
	);

	// Exactly two UNESCAPED quote characters in the whole sentence — the
	// delimiter's open and its close — however many quotes the untrusted
	// value itself contained. This is the structural claim finding 1 is
	// about: the sentence has exactly one quoted span, not zero (broken out
	// of) or more than one (a forged second span).
	const unescapedQuoteCount = (confirmText.textContent?.match(/(?<!\\)"/g) ?? []).length;
	expect(unescapedQuoteCount).toBe(2);
});
