/**
 * @vitest-environment happy-dom
 *
 * A chrome invariant that only the rendered console can state, asserted
 * against the two screens that actually render it.
 *
 * THE POINTER INVARIANT. `cursor` left the old shared button style for `.otta-btn` in the
 * sheet, so the row-activation reset wins on cascade order instead of on
 * `!important`. The price of that is a rule no type can carry: a control that
 * spreads the shared style and forgets the class is a control with no pointer at
 * all, and every other test in this package stays green while it happens. The
 * assertion is therefore made over what the screens RENDER rather than over what
 * the source says — it holds for the buttons that do not exist yet, which is the
 * whole point of making it.
 *
 * THE NO-DROPDOWN INVARIANT. EmDash's own screens show their sections as a
 * heading over a card and their filters as an inline row; nothing is folded
 * behind a disclosure. Asserted over the rendered screens for the same reason.
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
const { OrderDetail } = await import("../src/orders/order-detail.js");
type DetailPayload = import("../src/console-api.js").DetailPayload;
type ListPayload = import("../src/console-api.js").ListPayload;
type Vocabulary = import("../src/console-api.js").Vocabulary;

// ── synthetic records ────────────────────────────────────────────────────────

const ORDERS_VOCABULARY: Vocabulary = {
	statuses: ["paid"],
	statusAny: "any",
	periods: [{ key: "last30", label: "Last 30 days" }],
	cancellationReasons: [{ value: "fraud", label: "Fraud" }],
	oneClickCancellationReasons: [{ value: "fraud", label: "Fraud" }],
	reconciliationOutcomes: [{ value: "resolved", label: "Resolved" }],
	pageLimit: 25,
};

/** A second page is waiting, so the list renders its `Load more` — one of the
 *  raw buttons this sweep exists to reach. */
const ORDERS_LIST: ListPayload = {
	ok: true,
	orders: [
		{
			id: "7e4ce728",
			orderNumber: "#7E4CE",
			state: "paid",
			currency: "USD",
			buyerRef: "buyer@example.test",
			customerId: null,
			paymentMethod: "card",
			createdAt: "2026-01-01T00:00:00.000Z",
			totalCents: 900,
			reconciliationFlag: null,
		},
	],
	nextCursor: "cursor-2",
	total: 2,
	vocabulary: ORDERS_VOCABULARY,
};

const ORDER_DETAIL: DetailPayload = {
	ok: true,
	order: {
		id: "7e4ce728",
		orderNumber: "#7E4CE",
		state: "paid",
		currency: "USD",
		paymentMethod: "card",
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
			subtotalCents: 900,
			discountCents: 0,
			shippingCents: 0,
			taxCents: 0,
			totalCents: 900,
			appliedCouponCode: null,
		},
		lines: [
			{
				sku: "APR-LIN-NAT",
				title: "Linen apron",
				unitPriceCents: 900,
				currency: "USD",
				quantity: 1,
				fulfillmentKind: "physical",
			},
		],
	},
	transitions: [],
	customer: null,
	timeline: { entries: [] },
	refunds: {
		refunds: [],
		currency: "USD",
		capturedTotalCents: 900,
		refundedTotalCents: 0,
		ceilingCents: 900,
		remainingCents: 900,
		paymentMethod: "card",
		refundable: true,
	},
	notes: [],
	vocabulary: ORDERS_VOCABULARY,
};

function envelope(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

let mounted: Mounted | null = null;

beforeEach(() => {
	sessionStorage.clear();
	apiFetch.mockReset();
	apiFetch.mockImplementation((_input, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { resource?: string };
		switch (body.resource) {
			case "orders.list":
				return Promise.resolve(envelope(ORDERS_LIST));
			case "orders.detail":
				return Promise.resolve(envelope(ORDER_DETAIL));
			default:
				return Promise.resolve(envelope({ ok: true, notice: null }));
		}
	});
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

const noop = (): undefined => undefined;

/** Mount, then let the load effect's promise chain land before asserting. */
async function show(node: React.ReactElement): Promise<Mounted> {
	const view = await mount(node);
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

/** The two screens, each in a state that renders its own raw button: the list
 *  with a second page behind it, the detail with its tab strip. */
const SCREENS: readonly (readonly [string, React.ReactElement, string])[] = [
	["orders list", <OrdersList key="ol" onOpen={noop} />, '[data-testid="orders-load-more"]'],
	[
		"order detail",
		<OrderDetail key="od" orderId="7e4ce728" onBack={noop} />,
		'[data-testid="tab-order"]',
	],
];

test("every button the console renders takes its pointer from the shared class", async () => {
	let seen = 0;
	for (const [name, screen, rawButton] of SCREENS) {
		const view = await show(screen);
		// The raw call site this screen owns is really on the page, so a screen
		// that silently rendered nothing cannot pass by having no buttons.
		one(view, rawButton);

		const buttons = [...view.container.querySelectorAll("button")];
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) {
			const label = button.getAttribute("data-testid") ?? button.textContent ?? "?";
			expect(
				button.classList.contains("otta-btn"),
				`${name}: <button> ${label} is missing otta-btn, so it renders with no pointer`,
			).toBe(true);
		}
		seen += buttons.length;

		await view.unmount();
		mounted = null;
	}
	expect(seen).toBeGreaterThan(SCREENS.length);
});

test("no screen folds anything behind a dropdown disclosure", async () => {
	for (const [name, screen, rawButton] of SCREENS) {
		const view = await show(screen);
		one(view, rawButton);
		expect(view.container.querySelectorAll("details").length, `${name}: <details>`).toBe(0);
		expect(view.container.querySelectorAll("summary").length, `${name}: <summary>`).toBe(0);
		await view.unmount();
		mounted = null;
	}
});

test("the buttons carry no inline cursor, so the row reset can still win", async () => {
	for (const [name, screen] of SCREENS) {
		const view = await show(screen);
		for (const button of view.container.querySelectorAll("button")) {
			// An inline declaration outranks every rule the sheet can write, which is
			// how `!important` crept in and flattened `not-allowed` inside a row.
			expect(button.style.cursor, `${name}: inline cursor`).toBe("");
		}
		await view.unmount();
		mounted = null;
	}
});
