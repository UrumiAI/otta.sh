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
import { fire, mount, type Mounted } from "./dom.js";

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

/** A write's answer, exactly as the plugin returns one: the served notice, and
 *  — for a refusal about a single input — the field it belongs beside. */
function actPayload(notice: Record<string, string>, field?: string): Response {
	return new Response(
		JSON.stringify({ data: { ok: true, notice, ...(field === undefined ? {} : { field }) } }),
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

// -- a refused rename, where the operator is looking ------------------------
// The service refuses a rename it cannot carry honestly, the plugin composes the
// one sentence for it, and this screen's whole job is to put that sentence where
// the operator can act on it. Nothing below asserts on copy this package
// authors, because this package authors none of it: each assertion compares what
// is rendered against what was served, character for character.

const RENAME_REFUSAL = {
	variant: "error",
	title: "That SKU already has stock of its own",
	description:
		'Nothing was changed. "APR-LIN-RET" already has its own inventory record, and stock is ' +
		'never merged between SKUs, so "APR-LIN-NAT" was not renamed onto it.',
};

/** Mount the detail, then answer the first write with `answer`. The read and the
 *  write share one endpoint, so they are told apart by the request body — the
 *  same discriminator the plugin's own route reads. */
async function saveIdentity(answer: () => Response): Promise<HTMLElement> {
	apiFetch.mockImplementation((_input, init) => {
		const sent = JSON.parse(String(init?.body ?? "{}")) as { type?: string };
		return Promise.resolve(sent.type === "otta_console_act" ? answer() : payload({}));
	});
	const node = <ProductDetail productId="p_base" onBack={() => undefined} />;
	mounted = await mount(node);
	await mounted.rerender(node);

	const save = mounted.container.querySelector('[data-testid="save-identity"]');
	if (save === null) throw new Error("no identity save control");
	await fire(save, "click");
	// The write answers, the screen re-reads, and the identity form remounts on
	// the fresh record — the refusal has to survive all three.
	await mounted.rerender(node);
	await mounted.rerender(node);
	return mounted.container;
}

test("a refused rename renders the SERVED sentence beside the SKU field, and only there", async () => {
	const container = await saveIdentity(() => actPayload(RENAME_REFUSAL, "sku"));

	const refusal = container.querySelector('[data-testid="edit-sku-refusal"]');
	expect(refusal).not.toBeNull();
	// VERBATIM. A screen that re-words a refusal becomes a second author of it,
	// and the two copies are then free to disagree about what happened.
	expect(refusal?.querySelector("h3")?.textContent).toBe(RENAME_REFUSAL.title);
	expect(refusal?.querySelector("p")?.textContent).toBe(RENAME_REFUSAL.description);

	// BESIDE THE FIELD, not merely somewhere on the page: the refusal's own
	// container is the element immediately after the labelled SKU input.
	const identity = container.querySelector<HTMLDetailsElement>(
		'details[data-testid="edit-identity"]',
	);
	const input = container.querySelector('[data-testid="edit-sku"]');
	expect(input).not.toBeNull();
	const region = refusal?.parentElement;
	expect(region?.previousElementSibling?.contains(input as Node)).toBe(true);
	// ...and the operator can actually see it. Identity is the group that is SHUT
	// on arrival, and the save remounts this form, so a refusal that did not force
	// the disclosure open would read as a save that did nothing at all.
	expect(identity?.open).toBe(true);
	// The input points at it, so it is announced with the field and not just
	// drawn near it.
	expect(input?.getAttribute("aria-invalid")).toBe("true");
	expect(input?.getAttribute("aria-describedby")).toBe(region?.getAttribute("id"));

	// ONE PLACE. The same sentence at the top as well would have the operator
	// reading it twice and wondering whether it happened twice.
	expect(container.querySelector('[data-testid="detail-notice"]')).toBeNull();
});

test("an outcome that names no field still reports at the top, and never beside the SKU", async () => {
	// The plain path is unchanged by the routing above: everything that is about
	// the record — a save, a stale watermark, a transport failure — reports where
	// it always has.
	const stale = {
		variant: "error",
		title: "This product changed since you opened it",
		description: "Your edit was NOT applied — the latest values are shown below.",
	};
	const container = await saveIdentity(() => actPayload(stale));

	const top = container.querySelector('[data-testid="detail-notice"]');
	expect(top?.querySelector("h3")?.textContent).toBe(stale.title);
	expect(top?.querySelector("p")?.textContent).toBe(stale.description);
	expect(container.querySelector('[data-testid="edit-sku-refusal"]')).toBeNull();
	expect(container.querySelector('[data-testid="edit-sku"]')?.getAttribute("aria-invalid")).toBe(
		null,
	);
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
