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
function actPayload(notice: Record<string, string>, about?: string): Response {
	return new Response(
		JSON.stringify({
			data: { ok: true, notice, ...(about === undefined ? {} : { field: about }) },
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

/** Type into a controlled field the way an operator does — through the event
 *  React's own value tracker listens for, not by assigning `value`. */
async function type(target: HTMLInputElement, text: string): Promise<void> {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	if (setter === undefined) throw new Error("no value setter on HTMLInputElement");
	await React.act(async () => {
		setter.call(target, text);
		target.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

const NODE = <ProductDetail productId="p_base" onBack={() => undefined} />;

/** Mount the detail and answer every write from `answers`, in order (the last
 *  one repeats). The read and the write share one endpoint, so they are told
 *  apart by the request body — the same discriminator the plugin's route reads. */
async function mountForWrites(...answers: Array<() => Response>): Promise<HTMLElement> {
	let written = 0;
	apiFetch.mockImplementation((_input, init) => {
		const sent = JSON.parse(String(init?.body ?? "{}")) as { type?: string };
		if (sent.type !== "otta_console_act") return Promise.resolve(payload({}));
		const answer = answers[Math.min(written, answers.length - 1)];
		written += 1;
		if (answer === undefined) throw new Error("no answer for this write");
		return Promise.resolve(answer());
	});
	mounted = await mount(NODE);
	await mounted.rerender(NODE);
	return mounted.container;
}

/** Click Save on the identity form and settle: the write answers, the screen
 *  re-reads, and — for an APPLIED write — the form remounts on the fresh
 *  record. Everything asserted below has to survive all three. */
async function clickSaveIdentity(): Promise<void> {
	const save = mounted?.container.querySelector('[data-testid="save-identity"]');
	if (save === undefined || save === null) throw new Error("no identity save control");
	await fire(save, "click");
	await mounted?.rerender(NODE);
	await mounted?.rerender(NODE);
}

async function saveIdentity(answer: () => Response): Promise<HTMLElement> {
	const container = await mountForWrites(answer);
	await clickSaveIdentity();
	return container;
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
	// on arrival, so a refusal that did not hold the disclosure open would read as
	// a save that did nothing at all.
	expect(identity?.open).toBe(true);
	// The input points at it, so it is announced with the field and not just
	// drawn near it — and the id is per instance, not a module constant.
	expect(input?.getAttribute("aria-invalid")).toBe("true");
	const describedBy = input?.getAttribute("aria-describedby");
	expect(describedBy).toBe(region?.getAttribute("id"));
	expect(describedBy).not.toBe("");
	expect(describedBy).not.toBeNull();

	// ANNOUNCED AT ALL. The click landed on Save, the sentence no longer stands at
	// the top of the page, and a live region inserted together with its text is
	// not reliably read — so focus moves into the region, which states it once.
	expect(document.activeElement).toBe(region);

	// ONE PLACE. The same sentence at the top as well would have the operator
	// reading it twice and wondering whether it happened twice.
	expect(container.querySelector('[data-testid="detail-notice"]')).toBeNull();
});

test("a refusal that lands after the operator has moved on does NOT take the caret off them", async () => {
	// A write answers whenever the service gets round to it, and an operator does
	// not stand still meanwhile. Announcing the refusal is worth moving focus FROM
	// the button that raised it; it is not worth pulling someone out of a field
	// they are mid-way through typing into. So the move happens only from this
	// form's own controls, or from nowhere at all.
	let release: (() => void) | null = null;
	const inFlight = new Promise<void>((resolve) => {
		release = resolve;
	});
	apiFetch.mockImplementation((_input, init) => {
		const sent = JSON.parse(String(init?.body ?? "{}")) as { type?: string };
		if (sent.type !== "otta_console_act") return Promise.resolve(payload({}));
		return inFlight.then(() => actPayload(RENAME_REFUSAL, "sku"));
	});
	mounted = await mount(NODE);
	await mounted.rerender(NODE);
	const container = mounted.container;

	const save = container.querySelector('[data-testid="save-identity"]');
	if (save === null) throw new Error("no identity save control");
	await fire(save, "click");

	// ...and while it is in flight, the operator goes to work on the price.
	const price = container.querySelector<HTMLInputElement>('input[data-testid="edit-price"]');
	if (price === null) throw new Error("no price input");
	price.focus();
	expect(document.activeElement).toBe(price);

	await React.act(async () => {
		release?.();
	});
	await mounted.rerender(NODE);
	await mounted.rerender(NODE);

	// The refusal is on screen — and the caret never left the field they moved to.
	expect(container.querySelector('[data-testid="edit-sku-refusal"]')).not.toBeNull();
	expect(document.activeElement).toBe(price);
});

test("a REFUSED rename keeps the SKU the operator typed — it does not restore the stored one", async () => {
	// THE SENTENCE SAYS "rename to a SKU that has never held stock". A form that
	// re-seeded itself from the record would answer that advice by silently
	// putting the OLD sku back in the box, so the operator would have to retype
	// what they typed before they could read what they typed. A refusal applied
	// nothing, so there is nothing for the form to re-seed FROM.
	const container = await mountForWrites(() => actPayload(RENAME_REFUSAL, "sku"));
	const input = container.querySelector<HTMLInputElement>('[data-testid="edit-sku"]');
	if (input === null) throw new Error("no sku input");
	await type(input, "APR-LIN-RET");
	await clickSaveIdentity();

	const after = container.querySelector<HTMLInputElement>('[data-testid="edit-sku"]');
	expect(after?.value).toBe("APR-LIN-RET");
	expect(after?.value).not.toBe(BASE.sku);
	// ...and the screen says so out loud: the group still reports unsaved work,
	// which is the truth about a draft that was refused.
	const summary = container.querySelector('details[data-testid="edit-identity"] summary');
	expect(summary?.textContent).toContain("unsaved");
});

test("an APPLIED save still re-seeds the form from the record it just wrote", async () => {
	// The other half of the rule above, and the reason it is a rule about
	// REFUSALS rather than about saves: a save that landed must leave the form
	// showing the record, not a draft that is now identical to it by luck.
	const saved = { variant: "default", title: "Saved", description: "Updated." };
	const container = await mountForWrites(() => actPayload(saved));
	const input = container.querySelector<HTMLInputElement>('[data-testid="edit-sku"]');
	if (input === null) throw new Error("no sku input");
	await type(input, "APR-LIN-TYPED");
	await clickSaveIdentity();

	// The mocked re-read serves the unchanged record, so a re-seeded form shows
	// its sku — and a form that kept the draft would still show the typed value.
	expect(container.querySelector<HTMLInputElement>('[data-testid="edit-sku"]')?.value).toBe(
		BASE.sku,
	);
});

/** The identity disclosure AS IT IS NOW. Re-queried at every use on purpose: a
 *  remount replaces the element, and a handle taken before one reports `open`
 *  off a node that has left the document — which is true whatever the screen
 *  does to the live one. */
function disclosure(container: HTMLElement): HTMLDetailsElement | null {
	return container.querySelector<HTMLDetailsElement>('details[data-testid="edit-identity"]');
}

test("a later outcome that clears the refusal does NOT slam the disclosure shut", async () => {
	// `Group` renders a native `<details open={…}>`, and React reconciles that
	// prop: a `false` arriving after a `true` closes the element. So a refusal
	// followed by any other write would have closed a group the operator is
	// working in — the one thing `Group`'s own doc promises the screen can never
	// do to them.
	//
	// THE CLEARING WRITE GOES THROUGH THE PRICE FORM, which is the whole test.
	// A second identity save would remount identity and draw a fresh `<details>`
	// that never sees the `true → false` transition at all; a price save leaves
	// the identity element in place and merely re-renders it with no refusal —
	// which is exactly the path an operator takes, and the only one where the
	// force-close is observable.
	const saved = { variant: "default", title: "Saved", description: "Updated." };
	const container = await mountForWrites(
		() => actPayload(RENAME_REFUSAL, "sku"),
		() => actPayload(saved),
	);
	await clickSaveIdentity();
	const opened = disclosure(container);
	expect(opened?.open).toBe(true);

	// SCOPED TO THE INPUT: the price DISCLOSURE carries the same testid, and the
	// bare selector matches it first.
	const price = container.querySelector<HTMLInputElement>('input[data-testid="edit-price"]');
	if (price === null) throw new Error("no price input");
	await type(price, "44.00");
	const savePrice = container.querySelector('[data-testid="save-price"]');
	if (savePrice === null) throw new Error("no price save control");
	await fire(savePrice, "click");
	await mounted?.rerender(NODE);
	await mounted?.rerender(NODE);

	// The refusal is gone, the identity element is the SAME one, and it is still
	// open — the assertion is on the live node, not on the handle taken above.
	expect(container.querySelector('[data-testid="edit-sku-refusal"]')).toBeNull();
	expect(disclosure(container)).toBe(opened);
	expect(disclosure(container)?.open).toBe(true);
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

test("a STALE refusal re-seeds the form, because there the record really did move", async () => {
	// THE ONE REFUSAL THAT IS NOT ABOUT A VALUE. `stale` means someone else's write
	// landed, so the record underneath changed and the notice promises the operator
	// two things about this form: that the latest values are shown, and that they
	// should re-apply their change on top of them. Keeping the draft would make
	// both false — and would leave one more Save between the operator and silently
	// overwriting a writer whose values they never saw. Draft retention is for the
	// refusals that name a FIELD, where nothing moved at all.
	const stale = {
		variant: "error",
		title: "This product changed since you opened it",
		description: "Your edit was NOT applied — the latest values are shown below.",
	};
	const container = await mountForWrites(() => actPayload(stale));
	const input = container.querySelector<HTMLInputElement>('[data-testid="edit-sku"]');
	if (input === null) throw new Error("no sku input");
	await type(input, "APR-LIN-LOSER");
	await clickSaveIdentity();

	expect(container.querySelector<HTMLInputElement>('[data-testid="edit-sku"]')?.value).toBe(
		BASE.sku,
	);
	// ...and with the draft gone, the group is clean again — no ` · unsaved` over
	// work the screen has just discarded on the operator's behalf.
	expect(
		container.querySelector('details[data-testid="edit-identity"] summary')?.textContent,
	).not.toContain("unsaved");
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
