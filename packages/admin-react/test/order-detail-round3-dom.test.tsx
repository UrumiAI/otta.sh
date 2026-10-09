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

const { OrderDetail } = await import("../src/orders/order-detail.js");
const { formatAmount } = await import("@otta-sh/admin-presentation");
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

function detailFor(state: string, refunds: RefundsSummary | null = CAPTURED): DetailPayload {
	return {
		ok: true,
		order: {
			id: ORDER_ID,
			orderNumber: `#${ORDER_ID.slice(0, 5).toUpperCase()}`,
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

function table(view: Mounted, testId: string): HTMLTableElement {
	return one<HTMLTableElement>(view, `table[data-testid="${testId}"]`);
}

function bodyRows(node: HTMLTableElement): HTMLTableRowElement[] {
	return [...node.querySelectorAll<HTMLTableRowElement>("tbody > tr")];
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

test("History says a cancellation's restock is pending until the items are back", async () => {
	const view = await show(
		withTimeline(detailFor("cancelled"), [
			{
				kind: "cancellation",
				at: "2026-03-04T10:30:00.000Z",
				reason: "customer_request",
				detail: null,
				cancelledBy: "ops@example.test",
				refund: null,
				restocked: false,
				restockPending: true,
			},
		]),
	);
	await fire(tab(view, "history"), "click");
	const rows = bodyRows(table(view, "detail-timeline")).map((row) =>
		[...row.cells].map((c) => c.textContent ?? ""),
	);
	const cancelText = rows.find((r) => r.includes("Cancelled"))?.join(" ") ?? "";
	expect(cancelText).toContain("restock pending");
	expect(cancelText).not.toMatch(/returned to stock/);
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

// ── review round 2: resolving a refund whose outcome is unknown ──────────────

const UNKNOWN: RefundsSummary = {
	refunds: [
		{
			amountCents: 400_000,
			currency: CUR,
			refundRef: null,
			idempotencyKey: "admin-refund:7e4ce728:400000:0",
			refundedBy: "ops@example.test",
			createdAt: "2026-03-04T11:00:00.000Z",
			status: "unverified",
		},
	],
	currency: CUR,
	capturedTotalCents: TOTAL_CENTS,
	refundedTotalCents: 400_000,
	finalizedTotalCents: 0,
	ceilingCents: TOTAL_CENTS,
	remainingCents: TOTAL_CENTS - 400_000,
	paymentMethod: "card",
	refundable: true,
};

async function confirmAndSend(
	view: Mounted,
	testId: string,
): Promise<Record<string, unknown> | undefined> {
	await fire(one<HTMLButtonElement>(view, `[data-testid="${testId}"]`), "click");
	const text = one(view, '[data-testid="otta-confirm-text"]').textContent ?? "";
	apiFetch.mockClear();
	apiFetch.mockResolvedValue(
		new Response(JSON.stringify({ data: { ok: true, notice: null } }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
	await fire(one<HTMLButtonElement>(view, '[data-testid="otta-confirm-yes"]'), "click");
	const body = apiFetch.mock.calls
		.map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as Record<string, unknown>)
		.find(
			(b) =>
				typeof b["action_id"] === "string" &&
				String(b["action_id"]).startsWith("orders:resolve-refund"),
		);
	return { ...body, confirmText: text };
}

test("an unverified refund offers 'Confirmed at the provider', behind a confirm, with the provider id it was given", async () => {
	const view = await show(detailFor("paid", UNKNOWN));
	await fire(tab(view, "money"), "click");
	const ref = one<HTMLInputElement>(view, '[data-testid="resolve-refund-ref"]');
	await React.act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
			ref,
			"re_dash_9",
		);
		ref.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const sent = await confirmAndSend(view, "resolve-refund-confirmed");
	expect(String(sent?.["confirmText"])).toMatch(/payment provider shows/i);
	// #364: confirming finishes what the refund was for, once.
	expect(String(sent?.["confirmText"])).toMatch(/a cancellation completes/);
	expect(sent?.["action_id"]).toBe("orders:resolve-refund-confirmed");
	expect(sent?.["value"]).toEqual({
		orderId: ORDER_ID,
		refundKey: "admin-refund:7e4ce728:400000:0",
		refundRef: "re_dash_9",
	});
});

test("an unverified refund offers 'It didn't happen', behind a confirm", async () => {
	const view = await show(detailFor("paid", UNKNOWN));
	await fire(tab(view, "money"), "click");
	const sent = await confirmAndSend(view, "resolve-refund-voided");
	expect(String(sent?.["confirmText"])).toMatch(/can be refunded again/i);
	expect(String(sent?.["confirmText"])).toContain("click Cancel order again");
	// A wrong "didn't happen" cannot pay twice: the next refund asks the provider first.
	expect(String(sent?.["confirmText"])).toContain(
		"If it was in fact refunded, a new refund will be stopped by the provider check and nothing more is paid.",
	);
	expect(sent?.["action_id"]).toBe("orders:resolve-refund-voided");
	expect(sent?.["value"]).toEqual({
		orderId: ORDER_ID,
		refundKey: "admin-refund:7e4ce728:400000:0",
	});
});

test("a recorded refund offers no resolve controls", async () => {
	const view = await show(detailFor("paid"));
	await fire(tab(view, "money"), "click");
	expect(view.container.querySelector('[data-testid="resolve-refund-confirmed"]')).toBeNull();
});
