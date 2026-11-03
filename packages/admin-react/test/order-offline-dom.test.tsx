/**
 * @vitest-environment happy-dom
 *
 * Cash on delivery in the React console (ADR-0044), through real mounts of the
 * real screens: the two states' badges, the Mark paid buttons and their
 * confirm (review finding 5), Record shipment on an unpaid order, the cancel
 * group on both unpaid states, the list's payment badge and its "awaiting
 * payment (COD)" filter (review finding 6). Every branch is on `settlement`.
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
const { OrdersList } = await import("../src/orders/orders-list.js");
const { formatAmount, refundCapabilityText } = await import("@urumi.ai/otta-admin-presentation");
type DetailPayload = import("../src/console-api.js").DetailPayload;
type RefundsSummary = import("../src/console-api.js").RefundsSummary;
type Vocabulary = import("../src/console-api.js").Vocabulary;

const CUR = "USD";
const ORDER_ID = "c0d0c0d0";
const TOTAL_CENTS = 1_234_500;

const VOCABULARY: Vocabulary = {
	statuses: ["pending", "paid", "awaiting_payment", "shipped_awaiting_payment"],
	statusAny: "any",
	periods: [{ key: "any", label: "Any time" }],
	cancellationReasons: [{ value: "customer_request", label: "Customer requested it" }],
	oneClickCancellationReasons: [{ value: "customer_request", label: "Customer requested it" }],
	reconciliationOutcomes: [],
	pageLimit: 25,
};

const NOTHING_CAPTURED: RefundsSummary = {
	refunds: [],
	currency: CUR,
	capturedTotalCents: 0,
	refundedTotalCents: 0,
	ceilingCents: 0,
	remainingCents: 0,
	paymentMethod: "cod",
	settlement: "offline",
	refundable: false,
};

function detailFor(
	state: string,
	transitions: string[],
	settlement: "gateway" | "offline" | null = "offline",
): DetailPayload {
	return {
		ok: true,
		order: {
			id: ORDER_ID,
			orderNumber: "#C0D0C",
			state,
			currency: CUR,
			paymentMethod: settlement === "offline" ? "cod" : "stripe",
			settlement,
			buyerRef: "buyer@example.test",
			customerId: null,
			createdAt: "2026-11-03T10:15:00.000Z",
			reconciliationFlag: null,
			reconciliationResolution: null,
			fulfillment: null,
			cancellation: null,
			shippingAddress: null,
			totals: {
				currency: CUR,
				subtotalCents: TOTAL_CENTS,
				discountCents: 0,
				shippingCents: 0,
				taxCents: 0,
				totalCents: TOTAL_CENTS,
				appliedCouponCode: null,
			},
			lines: [
				{
					sku: "MUG-1",
					title: "Mug",
					unitPriceCents: TOTAL_CENTS,
					currency: CUR,
					quantity: 1,
					fulfillmentKind: "physical",
				},
			],
		},
		transitions,
		customer: null,
		timeline: { entries: [] },
		refunds: NOTHING_CAPTURED,
		notes: [],
		vocabulary: VOCABULARY,
	};
}

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

/** Answer the detail load with `payload`, and any action with a plain success —
 *  the screen reloads the record after an action. */
function serve(payload: DetailPayload): void {
	apiFetch.mockImplementation((_input, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		const isAction = String(body["action_id"] ?? "").startsWith("orders:transition-");
		return Promise.resolve(
			new Response(JSON.stringify({ data: isAction ? { ok: true, notice: null } : payload }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
}

let current: DetailPayload | null = null;

async function show(payload: DetailPayload): Promise<Mounted> {
	current = payload;
	serve(payload);
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

async function fulfilmentTab(view: Mounted): Promise<void> {
	await fire(one<HTMLButtonElement>(view, '[data-testid="tab-fulfilment"]'), "click");
}

/** The action the console posted after the confirm's Yes. */
async function confirmAndPost(view: Mounted): Promise<Record<string, unknown> | undefined> {
	apiFetch.mockClear();
	if (current !== null) serve(current);
	await fire(one<HTMLButtonElement>(view, '[data-testid="otta-confirm-yes"]'), "click");
	return apiFetch.mock.calls
		.map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as Record<string, unknown>)
		.find((body) => String(body["action_id"]).startsWith("orders:transition-"));
}

test("an awaiting-payment order: its badge, Mark paid and Mark shipped (unpaid)", async () => {
	const view = await show(detailFor("awaiting_payment", ["paid", "shipped_awaiting_payment"]));
	expect(one(view, '[data-testid="detail-state-pill"]').textContent).toBe("awaiting payment");
	await fulfilmentTab(view);
	expect(one(view, '[data-testid="transition-paid"]').textContent).toContain("Mark paid");
	expect(one(view, '[data-testid="transition-shipped_awaiting_payment"]').textContent).toContain(
		"Mark shipped (unpaid)",
	);
});

test("Mark paid on an offline order confirms the cash first, then posts → paid", async () => {
	const view = await show(detailFor("awaiting_payment", ["paid"]));
	await fulfilmentTab(view);
	await fire(one<HTMLButtonElement>(view, '[data-testid="transition-paid"]'), "click");
	expect(one(view, '[data-testid="otta-confirm-text"]').textContent).toBe(
		`Confirm you received ${formatAmount(TOTAL_CENTS, CUR)} in cash. This records the payment and emails the buyer.`,
	);
	const posted = await confirmAndPost(view);
	expect(posted?.["action_id"]).toBe("orders:transition-paid");
	expect(posted?.["value"]).toMatchObject({ orderId: ORDER_ID, toState: "paid" });
});

test("shipped awaiting payment: Mark paid (delivered), confirmed", async () => {
	const view = await show(detailFor("shipped_awaiting_payment", ["delivered"]));
	expect(one(view, '[data-testid="detail-state-pill"]').textContent).toBe(
		"shipped, awaiting payment",
	);
	await fulfilmentTab(view);
	const button = one<HTMLButtonElement>(view, '[data-testid="transition-delivered"]');
	expect(button.textContent).toContain("Mark paid (delivered)");
	await fire(button, "click");
	expect(one(view, '[data-testid="otta-confirm-text"]').textContent).toContain("in cash");
	expect((await confirmAndPost(view))?.["action_id"]).toBe("orders:transition-delivered");
});

test("a card order's Mark delivered is unchanged: no cash confirm", async () => {
	const view = await show(detailFor("shipped", ["delivered"], "gateway"));
	await fulfilmentTab(view);
	const button = one<HTMLButtonElement>(view, '[data-testid="transition-delivered"]');
	expect(button.textContent).toContain("Mark delivered");
	apiFetch.mockClear();
	if (current !== null) serve(current);
	await fire(button, "click");
	const posted = apiFetch.mock.calls
		.map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as Record<string, unknown>)
		.find((body) => body["action_id"] === "orders:transition-delivered");
	expect(posted).toBeDefined();
});

test("the shipping address shows the phone the courier calls", async () => {
	const payload = detailFor("awaiting_payment", []);
	const view = await show({
		...payload,
		order: {
			...payload.order,
			shippingAddress: {
				name: "Asha",
				line1: "1 Road",
				city: "Pune",
				postalCode: "411001",
				country: "IN",
				phone: "+91 98765 43210",
			},
		},
	});
	await fulfilmentTab(view);
	expect(one(view, '[data-testid="detail-shipping"]').textContent).toContain("+91 98765 43210");
});

test("an awaiting-payment order offers Record shipment (the Fulfilment form)", async () => {
	const view = await show(detailFor("awaiting_payment", ["paid"]));
	await fulfilmentTab(view);
	expect(view.container.querySelector('[data-testid="detail-record-fulfilment"]')).not.toBeNull();
});

test("awaiting_payment can be cancelled: nothing to refund, the held stock released", async () => {
	const view = await show(detailFor("awaiting_payment", []));
	await fulfilmentTab(view);
	const banner = one(view, '[data-testid="cancel-banner"]').textContent ?? "";
	expect(banner).not.toMatch(/refunds/);
	expect(view.container.querySelector('[data-testid="cancel-restock"]')).toBeNull();
	await fire(one<HTMLButtonElement>(view, '[data-testid="cancel-customer_request"]'), "click");
	expect(one(view, '[data-testid="otta-confirm-text"]').textContent).toContain(
		"the held stock is released",
	);
});

test("shipped_awaiting_payment's cancel says the items go back on sale at once (B-N5)", async () => {
	const view = await show(detailFor("shipped_awaiting_payment", []));
	await fulfilmentTab(view);
	const banner = one(view, '[data-testid="cancel-banner"]').textContent ?? "";
	expect(banner).toContain(
		"Cancelling returns the items to stock at once — do it when the parcel has come back.",
	);
	expect(banner).not.toMatch(/refunds|held stock/);
	expect(one(view, '[data-testid="detail-cancel"]').textContent).toContain(
		"returns the items to stock",
	);
	// Copy only: no restock choice.
	expect(view.container.querySelector('[data-testid="cancel-restock"]')).toBeNull();
	await fire(one<HTMLButtonElement>(view, '[data-testid="cancel-customer_request"]'), "click");
	const confirm = one(view, '[data-testid="otta-confirm-text"]').textContent ?? "";
	expect(confirm).toContain("the items go back on sale at once");
	expect(confirm).not.toContain("held stock");
});

test("an offline order stuck in pending: Mark paid confirms the cash too (B-N9)", async () => {
	const view = await show(detailFor("pending", ["paid"]));
	await fulfilmentTab(view);
	const button = one<HTMLButtonElement>(view, '[data-testid="transition-paid"]');
	expect(button.textContent).toContain("Mark paid");
	await fire(button, "click");
	expect(one(view, '[data-testid="otta-confirm-text"]').textContent).toContain("in cash");
	expect((await confirmAndPost(view))?.["action_id"]).toBe("orders:transition-paid");
});

test("the refund panel's capability line reads the settlement", async () => {
	expect(refundCapabilityText(false, "cod", "offline")).toMatch(/cash on delivery/i);
});

// ── the list ────────────────────────────────────────────────────────────────

function row(id: string, state: string, settlement: "gateway" | "offline" | null) {
	return {
		id,
		orderNumber: `#${id.slice(0, 5).toUpperCase()}`,
		state,
		currency: CUR,
		buyerRef: `buyer_${id}`,
		customerId: null,
		paymentMethod: settlement === "offline" ? "cod" : "stripe",
		settlement,
		createdAt: "2026-11-03T10:15:00.000Z",
		totalCents: 12_000,
		reconciliationFlag: null,
	};
}

async function mountList(): Promise<HTMLElement> {
	respond({
		ok: true,
		orders: [
			row("ord_cod", "awaiting_payment", "offline"),
			row("ord_card", "paid", "gateway"),
			row("ord_old", "paid", null),
		],
		nextCursor: null,
		vocabulary: VOCABULARY,
	});
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	await mounted.rerender(node);
	return mounted.container;
}

test("an offline order wears a Cash on delivery badge on the list; others none", async () => {
	const container = await mountList();
	const badge = (id: string) =>
		container.querySelector(`tr[data-row-id="${id}"] [data-testid="order-payment-pill"]`);
	expect(badge("ord_cod")?.textContent).toBe("Cash on delivery");
	expect(badge("ord_card")).toBeNull();
	expect(badge("ord_old")).toBeNull();
	expect(
		container.querySelector('tr[data-row-id="ord_cod"] [data-testid="order-state-pill"]')
			?.textContent,
	).toBe("awaiting payment");
});

test("the Status filter offers 'awaiting payment (COD)' on state awaiting_payment", async () => {
	const container = await mountList();
	const select = container.querySelector<HTMLSelectElement>('[data-testid="filter-status"]');
	const option = select?.querySelector<HTMLOptionElement>('option[value="awaiting_payment"]');
	expect(option?.textContent).toBe("awaiting payment (COD)");
	expect(select?.querySelector('option[value="paid"]')?.textContent).toBe("paid");
});
