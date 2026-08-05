/**
 * @vitest-environment happy-dom
 *
 * The product detail's identity strip and which of its edit groups opens,
 * through a real render of the real screen.
 *
 * WHY A DOCUMENT. `<details open>` is a live element state rather than a
 * rendered string, and the strip only exists after the detail read resolves —
 * so a static render never draws either. Both claims below are also per-FIELD,
 * and a substring search of the page's markup cannot tell one field of the
 * strip from another, so every assertion starts from the row whose label it
 * names.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { ProductDetail } = await import("../src/products/product-detail.js");
const {
	ABSENT,
	PRODUCT_FIELD_LABELS,
	STATUS_FIELD_LABEL,
	formatOptionalAmount,
	onHandCell,
	statusLabel,
} = await import("@otta-sh/admin-presentation");
type ProductRecord = import("../src/console-api.js").ProductRecord;

const THRESHOLD = 5;

/** A priced, active, comfortably-stocked product: every cell of the strip on
 *  its happy path, so an exception in the tests below is the record's doing. */
const BASE: ProductRecord = {
	productId: "p_base",
	sku: "APR-LIN-NAT",
	title: "Apron, natural linen",
	// Crosses a thousands separator, so a hand-assembled amount cannot agree with
	// the formatter by coincidence.
	priceCents: 1_299_000,
	currency: "USD",
	taxClass: null,
	compareAtCents: null,
	compareAtCurrency: null,
	unitCostCents: null,
	unitCostCurrency: null,
	inventoryPolicy: "deny",
	weightGrams: null,
	lengthMm: null,
	widthMm: null,
	heightMm: null,
	productKind: "physical",
	active: true,
	deletedAt: null,
	onHand: 104,
	createdAt: "2026-03-01T09:00:00.000Z",
	updatedAt: "2026-03-04T10:15:00.000Z",
};

function payload(over: Partial<ProductRecord>): Response {
	return new Response(
		JSON.stringify({
			data: {
				ok: true,
				product: { ...BASE, ...over },
				taxClasses: [],
				threshold: THRESHOLD,
				vocabulary: {
					statuses: [{ value: "any", label: "Any status" }],
					kinds: [{ value: "physical", label: "Physical" }],
					any: "any",
					pageLimit: 25,
				},
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

let mounted: Mounted | null = null;

beforeEach(() => {
	apiFetch.mockReset();
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

async function mountDetail(over: Partial<ProductRecord> = {}): Promise<HTMLElement> {
	apiFetch.mockImplementation(() => Promise.resolve(payload(over)));
	const node = <ProductDetail productId="p_base" onBack={() => undefined} />;
	mounted = await mount(node);
	// The read arrives through a promise chain the mount's own `act` does not
	// outlive; a second flush is what puts the record on screen.
	await mounted.rerender(node);
	return mounted.container;
}

/** The strip's value cell for one label, and only that one. */
function field(container: HTMLElement, label: string): HTMLElement {
	const strip = container.querySelector('[data-testid="detail-identity"]');
	if (strip === null) throw new Error("no identity strip");
	for (const term of strip.querySelectorAll("dt")) {
		if (term.textContent === label) {
			const value = term.nextElementSibling;
			if (value === null) throw new Error(`no value beside ${label}`);
			return value as HTMLElement;
		}
	}
	throw new Error(`no field labelled ${label}`);
}

test("the strip rings the same two cells the list does, from the same record", async () => {
	const container = await mountDetail({ active: false });

	const status = field(container, STATUS_FIELD_LABEL);
	const pill = status.querySelector("[data-tone]");
	expect(pill).not.toBeNull();
	expect(pill?.getAttribute("data-tone")).toBe("warn");
	// The ring wraps the shared phrase; it does not make one.
	expect(pill?.textContent).toBe(statusLabel({ ...BASE, active: false }));

	// A comfortable count is not an exception and stays bare.
	const stock = field(container, PRODUCT_FIELD_LABELS.stockOnHand);
	expect(stock.querySelector("[data-tone]")).toBeNull();
	expect(stock.textContent).toBe(onHandCell(BASE.onHand, THRESHOLD));
});

test("a tombstone fails and a zero count fails, in the same strip", async () => {
	const container = await mountDetail({
		active: false,
		deletedAt: "2026-03-02T09:00:00.000Z",
		onHand: 0,
	});

	expect(
		field(container, STATUS_FIELD_LABEL).querySelector("[data-tone]")?.getAttribute("data-tone"),
	).toBe("fail");
	const stock = field(container, PRODUCT_FIELD_LABELS.stockOnHand);
	expect(stock.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("fail");
	expect(stock.textContent).toBe(onHandCell(0, THRESHOLD));
});

test("an unknown count is a bare em dash, never a ring and never a zero", async () => {
	const container = await mountDetail({ onHand: null });

	const stock = field(container, PRODUCT_FIELD_LABELS.stockOnHand);
	expect(stock.querySelector("[data-tone]")).toBeNull();
	expect(stock.textContent).toBe(ABSENT);
	expect(stock.textContent).not.toBe("0");
});

test("the price in the strip is the formatter's, and an unset one is not zero", async () => {
	const priced = await mountDetail();
	expect(field(priced, PRODUCT_FIELD_LABELS.price).textContent).toBe(
		formatOptionalAmount(BASE.priceCents, BASE.currency),
	);
	await mounted?.unmount();
	mounted = null;

	const unpriced = await mountDetail({ priceCents: null, currency: null });
	expect(field(unpriced, PRODUCT_FIELD_LABELS.price).textContent).toBe(ABSENT);
});

test("the group that opens on arrival is the one the screen is named for", async () => {
	const container = await mountDetail();

	// SCOPED TO THE DISCLOSURE, not to the testid: the price INPUT carries the
	// same testid, and a selector that matched either would read `open` off an
	// element that has no such state and answer `undefined` with confidence.
	const price = container.querySelector<HTMLDetailsElement>('details[data-testid="edit-price"]');
	const identity = container.querySelector<HTMLDetailsElement>(
		'details[data-testid="edit-identity"]',
	);
	const shipping = container.querySelector<HTMLDetailsElement>(
		'details[data-testid="edit-shipping"]',
	);
	expect(price).not.toBeNull();
	expect(identity).not.toBeNull();

	// EXACTLY ONE, and it is the namesake. Asserting only that Price is open
	// would pass a screen that opened all three, which is the other way to lose
	// the one-group-open rule.
	expect(price?.open).toBe(true);
	expect(identity?.open).toBe(false);
	expect(shipping?.open).toBe(false);
});
