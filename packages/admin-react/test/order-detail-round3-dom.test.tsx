/**
 * @vitest-environment happy-dom
 *
 * QA round 2 on the order detail, through a real mount of the real screen:
 *  - History states refunds, a cancellation's refund and restock in words, the
 *    cancel reason as the operator chose it (never `customer_request`), and WHO
 *    made each status move;
 *  - the Discount row names the coupon the order was priced with;
 *  - a recorded fulfilment shows its tracking link;
 *  - a refund of a different amount asks for no name (the server records the
 *    signed-in operator), and an amount with too many decimals says so.
 *
 * The harness is `order-detail-dom.test.tsx`'s, copied rather than shared — that
 * suite keeps its helpers module-private.
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

function detailFor(state: string, refunds: RefundsSummary | null = CAPTURED): DetailPayload {
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

// ── History ──────────────────────────────────────────────────────────────────

const REASONS = [
	{ value: "customer_request", label: "Customer requested it" },
	{ value: "pricing_error", label: "Pricing error" },
];

function withTimeline(payload: DetailPayload, entries: unknown[]): DetailPayload {
	return {
		...payload,
		timeline: { entries } as DetailPayload["timeline"],
		vocabulary: { ...payload.vocabulary, cancellationReasons: REASONS },
	};
}

test("History names who made each status move, and states refunds and a cancellation's money in words", async () => {
	const view = await show(
		withTimeline(detailFor("cancelled"), [
			{ kind: "created", at: "2026-03-04T10:15:00.000Z" },
			{
				kind: "state_change",
				at: "2026-03-04T10:20:00.000Z",
				fromState: "paid",
				toState: "processing",
				actor: "ops@example.test",
			},
			{
				kind: "refund",
				at: "2026-03-04T10:25:00.000Z",
				amount: 400_000,
				currency: CUR,
				status: "recorded",
				purpose: "refund",
				refundedBy: "ops@example.test",
				reason: "damaged box",
			},
			{
				kind: "cancellation",
				at: "2026-03-04T10:30:00.000Z",
				reason: "customer_request",
				detail: null,
				cancelledBy: "ops@example.test",
				refund: { amount: 1_000_000, currency: CUR },
				restocked: true,
			},
		]),
	);
	await fire(tab(view, "history"), "click");
	const history = table(view, "detail-timeline");
	const rows = bodyRows(history).map((row) => [...row.cells].map((c) => c.textContent ?? ""));

	const move = rows.find((r) => r.some((c) => c.includes("processing")));
	expect(move).toBeDefined();
	expect(move).toContain("ops@example.test");

	const refund = rows.find((r) => r.some((c) => c.startsWith("Refund")));
	expect(refund?.join(" ")).toContain(formatAmount(400_000, CUR));
	expect(refund).toContain("ops@example.test");
	expect(refund?.join(" ")).toContain("damaged box");

	const cancel = rows.find((r) => r.includes("Cancelled"));
	const cancelText = cancel?.join(" ") ?? "";
	expect(cancelText).toContain("Customer requested it");
	expect(cancelText).not.toContain("customer_request");
	expect(cancelText).toContain(formatAmount(1_000_000, CUR));
	expect(cancelText).toMatch(/returned to stock/);
});

// ── the coupon, the tracking link ────────────────────────────────────────────

test("the Discount row names the coupon the order was priced with", async () => {
	const payload = detailFor("paid");
	const view = await show({
		...payload,
		order: {
			...payload.order,
			totals: { ...payload.order.totals, appliedCouponCode: "qa2admin2" },
		},
	});
	expect(view.container.textContent).toContain("Discount · qa2admin2");
});

test("a recorded fulfilment shows its tracking link", async () => {
	const payload = detailFor("shipped");
	const view = await show({
		...payload,
		order: {
			...payload.order,
			fulfillment: {
				carrier: "UPS",
				trackingNumber: "1Z999",
				trackingUrl: "https://track.example/1Z999",
				shippedAt: "2026-03-04T12:00:00.000Z",
				recordedBy: "ops@example.test",
			},
		},
	});
	await fire(tab(view, "fulfilment"), "click");
	const link = one<HTMLAnchorElement>(view, '[data-testid="detail-fulfilment"] a');
	expect(link.getAttribute("href")).toBe("https://track.example/1Z999");
	expect(link.textContent).toBe("https://track.example/1Z999");
});

test("a tracking URL that is not http(s) is shown as text, never a link", async () => {
	const payload = detailFor("shipped");
	const view = await show({
		...payload,
		order: {
			...payload.order,
			fulfillment: {
				carrier: "UPS",
				trackingNumber: "1Z999",
				trackingUrl: "javascript:alert(1)",
				shippedAt: null,
				recordedBy: "ops@example.test",
			},
		},
	});
	await fire(tab(view, "fulfilment"), "click");
	expect(view.container.querySelector('[data-testid="detail-fulfilment"] a')).toBeNull();
});
