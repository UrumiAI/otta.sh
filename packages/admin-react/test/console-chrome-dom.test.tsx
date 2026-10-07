/**
 * @vitest-environment happy-dom
 *
 * Two chrome invariants that only the rendered console can state, asserted
 * against the four screens that actually render it.
 *
 * THE POINTER INVARIANT. `cursor` left `buttonStyle` for `.otta-btn` in the
 * sheet, so the row-activation reset wins on cascade order instead of on
 * `!important`. The price of that is a rule no type can carry: a control that
 * spreads the shared style and forgets the class is a control with no pointer at
 * all, and every other test in this package stays green while it happens. The
 * assertion is therefore made over what the screens RENDER rather than over what
 * the source says — it holds for the buttons that do not exist yet, which is the
 * whole point of making it. The same rule, and the same reasoning, for the
 * `<summary>` a disclosure is opened by.
 *
 * THE CONFIRM TONE. The dialog takes a per-call tone, and every screen that
 * passes one decides which of its confirms is destructive. Driving those from a
 * synthetic confirm object proves only that the component honours a prop; what
 * the operator meets is the SCREEN's choice, so the two stock movements are
 * driven here through the real form, the real parse and the real pending state.
 *
 * A `data-testid` IS NOT A SCOPE ON THIS SCREEN. Product detail mounts two
 * confirm dialogs — the leave confirm and the stock one — both carrying the same
 * shared `otta-confirm-*` ids, and the leave confirm is destructive and stays
 * mounted, shut, behind the other. An assertion that reads a testid alone reads
 * whichever dialog the query happens to reach first and can report destructive
 * weight for a dialog nobody is looking at. Everything below is scoped to the
 * dialog that is OPEN, and the shut sibling is asserted to still be there.
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
const { ProductsList } = await import("../src/products/products-list.js");
const { ProductDetail } = await import("../src/products/product-detail.js");
const { FAIL_ACCENT, HAIRLINE, buttonStyle } = await import("../src/ui.js");
const { addStockConfirm, removeStockConfirm } = await import("@otta-sh/admin-presentation");
type DetailPayload = import("../src/console-api.js").DetailPayload;
type ListPayload = import("../src/console-api.js").ListPayload;
type ProductDetailPayload = import("../src/console-api.js").ProductDetailPayload;
type ProductsListPayload = import("../src/console-api.js").ProductsListPayload;
type Vocabulary = import("../src/console-api.js").Vocabulary;
type ProductsVocabulary = import("../src/console-api.js").ProductsVocabulary;

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

const PRODUCTS_VOCABULARY: ProductsVocabulary = {
	statuses: [{ value: "true", label: "Active" }],
	kinds: [{ value: "physical", label: "Physical" }],
	any: "any",
	pageLimit: 25,
};

/** A second page is waiting, so the two lists render their `Load more` — one of
 *  the raw buttons this sweep exists to reach. */
const ORDERS_LIST: ListPayload = {
	ok: true,
	orders: [
		{
			id: "7e4ce728",
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

const PRODUCTS_LIST: ProductsListPayload = {
	ok: true,
	products: [
		{
			productId: "prod-1",
			sku: "APR-LIN-NAT",
			title: "Linen apron",
			priceCents: 900,
			currency: "USD",
			productKind: "physical",
			active: true,
			onHand: 12,
			deletedAt: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	],
	nextCursor: "cursor-2",
	total: 2,
	stock: { threshold: 3, unreadable: false, filterUnavailable: false },
	vocabulary: PRODUCTS_VOCABULARY,
};

/** Priced, live, with a sku AND an inventory record — the state in which both
 *  stock forms render, which is the state the tone tests need. */
const PRODUCT_DETAIL: ProductDetailPayload = {
	ok: true,
	product: {
		productId: "prod-1",
		sku: "APR-LIN-NAT",
		title: "Linen apron",
		priceCents: 900,
		currency: "USD",
		taxClass: "standard",
		compareAtCents: null,
		compareAtCurrency: null,
		unitCostCents: null,
		unitCostCurrency: null,
		inventoryPolicy: "deny",
		weightGrams: 420,
		lengthMm: null,
		widthMm: null,
		heightMm: null,
		productKind: "physical",
		active: true,
		deletedAt: null,
		onHand: 12,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
	},
	taxClasses: [{ id: "standard", name: "Standard" }],
	threshold: 3,
	vocabulary: PRODUCTS_VOCABULARY,
};

const ON_HAND = 12;

function envelope(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

let mounted: Mounted | null = null;

beforeEach(() => {
	// Each case starts from empty tab storage, so the duplicated-tab case sees
	// only what its own original tab could have left there.
	sessionStorage.clear();
	apiFetch.mockReset();
	apiFetch.mockImplementation((_input, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { resource?: string };
		switch (body.resource) {
			case "orders.list":
				return Promise.resolve(envelope(ORDERS_LIST));
			case "orders.detail":
				return Promise.resolve(envelope(ORDER_DETAIL));
			case "products.list":
				return Promise.resolve(envelope(PRODUCTS_LIST));
			case "products.detail":
				return Promise.resolve(envelope(PRODUCT_DETAIL));
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

/** The four screens, each in a state that renders its own raw button: the lists
 *  with a second page behind them, the details with their tab strips. */
const SCREENS: readonly (readonly [string, React.ReactElement, string])[] = [
	["orders list", <OrdersList key="ol" onOpen={noop} />, '[data-testid="orders-load-more"]'],
	[
		"order detail",
		<OrderDetail key="od" orderId="7e4ce728" onBack={noop} />,
		'[data-testid="tab-order"]',
	],
	["products list", <ProductsList key="pl" onOpen={noop} />, '[data-testid="products-load-more"]'],
	[
		"product detail",
		<ProductDetail key="pd" productId="prod-1" onBack={noop} />,
		'[data-testid="tab-product"]',
	],
];

test("every button the console renders takes its pointer from the shared class", async () => {
	// The declaration that used to be inline on every one of these. If it comes
	// back, the row-activation reset needs `!important` again — and that is what
	// flattened `not-allowed` on disabled controls inside a row.
	expect(buttonStyle.cursor).toBeUndefined();

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

test("a disclosure takes its pointer from the sheet too, so a row can reset it", async () => {
	let seen = 0;
	for (const [name, screen] of SCREENS) {
		const view = await show(screen);
		for (const summary of view.container.querySelectorAll("summary")) {
			expect(summary.classList.contains("otta-summary"), `${name}: summary lost its class`).toBe(
				true,
			);
			// An inline declaration here outranks every rule the sheet can write,
			// which is exactly how the pointer survived the row reset before.
			expect(summary.style.cursor, `${name}: summary declares cursor inline`).toBe("");
			seen += 1;
		}
		await view.unmount();
		mounted = null;
	}
	expect(seen).toBeGreaterThan(0);
});

/** Type into a controlled field the way an operator does — through the event
 *  React's own value tracker listens for, not by assigning `value`. */
async function type(field: HTMLInputElement, text: string): Promise<void> {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	if (setter === undefined) throw new Error("no value setter on HTMLInputElement");
	await React.act(async () => {
		setter.call(field, text);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** The dialog the operator is actually looking at. Product detail mounts two,
 *  and only one of them is ever open. */
function openDialog(view: Mounted): HTMLDialogElement {
	const all = [...view.container.querySelectorAll("dialog")];
	const open = all.filter((dialog) => dialog.open);
	const [only] = open;
	if (only === undefined || open.length !== 1) {
		throw new Error(
			`expected exactly one open dialog, found ${String(open.length)} of ${String(all.length)}`,
		);
	}
	return only;
}

function inDialog(dialog: HTMLDialogElement, testId: string): HTMLElement {
	const found = dialog.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (found === null) throw new Error(`no [data-testid="${testId}"] in the open dialog`);
	return found;
}

/** Ask for a stock movement and stop at the confirm, which is where the tone is
 *  decided. `qty` goes through the field, so the parse and the pending state are
 *  the screen's own rather than the test's. */
async function askForMovement(
	view: Mounted,
	prefix: string,
	qty: string,
): Promise<HTMLDialogElement> {
	await type(one<HTMLInputElement>(view, `[data-testid="${prefix}-qty"]`), qty);
	await fire(one(view, `[data-testid="${prefix}-submit"]`), "click");
	return openDialog(view);
}

test("adding stock asks in neutral weight, with a destructive dialog shut behind it", async () => {
	const view = await show(<ProductDetail productId="prod-1" onBack={noop} />);
	await fire(one(view, '[data-testid="tab-stock"]'), "click");

	const dialog = await askForMovement(view, "restock", "100");

	// The screen's own sentence, so this is the add confirm and not the other one.
	expect(dialog.textContent).toContain(addStockConfirm(100, "APR-LIN-NAT", ON_HAND).title);
	const confirm = inDialog(dialog, "otta-confirm-yes");
	// Adding stock is undoable. Dressing it as destruction is what teaches an
	// operator to read past the weight on the confirms that are not.
	expect(confirm.style.borderColor).not.toBe(FAIL_ACCENT);
	expect(HAIRLINE).toContain(confirm.style.borderColor);
	expect(confirm.style.fontWeight).toBe("");

	// AND THIS IS WHY THE SCOPE IS THE OPEN DIALOG. The leave confirm is mounted,
	// shut, carrying the same ids and correctly wearing the destructive weight —
	// so an assertion that matched on the testid alone, or looked for the accent
	// anywhere in the markup, would pass with the tone on the wrong button.
	const sameId = view.container.querySelectorAll<HTMLElement>('[data-testid="otta-confirm-yes"]');
	expect(sameId.length).toBeGreaterThan(1);
	expect([...sameId].some((button) => button.style.borderColor === FAIL_ACCENT)).toBe(true);
});

test("removing stock keeps the destructive weight, on the confirm and not the way out", async () => {
	const view = await show(<ProductDetail productId="prod-1" onBack={noop} />);
	await fire(one(view, '[data-testid="tab-stock"]'), "click");

	const dialog = await askForMovement(view, "remove", "3");

	expect(dialog.textContent).toContain(removeStockConfirm(3).title);
	const confirm = inDialog(dialog, "otta-confirm-yes");
	expect(confirm.style.borderColor).toBe(FAIL_ACCENT);
	expect(confirm.style.fontWeight).toBe("600");
	// The weight belongs to the button that does the thing. On the way out it
	// would read as "Keep as is" being the dangerous answer.
	const deny = inDialog(dialog, "otta-confirm-deny");
	expect(deny.style.borderColor).not.toBe(FAIL_ACCENT);
	expect(deny.style.fontWeight).toBe("");
});

/** Every console write this test has sent, in order, as its posted `value`. */
function sentMoves(): Array<Record<string, string>> {
	return apiFetch.mock.calls
		.map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
		.filter((body) => body["type"] === "otta_console_act")
		.map((body) => body["value"] as Record<string, string>);
}

/** Ask for a movement, confirm it, and let the write and its re-read land. */
async function confirmMovement(view: Mounted, prefix: string, qty: string): Promise<void> {
	const dialog = await askForMovement(view, prefix, qty);
	await fire(inDialog(dialog, "otta-confirm-yes"), "click");
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

test("every DEFINITIVELY answered stock click gets its OWN nonce — the same move twice is two keys, not a replay", async () => {
	// The admin QA repro was Add 2, Remove 2, Add 2 with the third swallowed: a
	// key derived from (direction, count, qty) made it the first one again. The
	// console is the only party that knows two clicks are two decisions, so each
	// answered click mints a fresh nonce and the server keys on it.
	const view = await show(<ProductDetail productId="prod-1" onBack={noop} />);
	await fire(one(view, '[data-testid="tab-stock"]'), "click");

	for (const prefix of ["restock", "restock", "remove", "restock"]) {
		await confirmMovement(view, prefix, "2");
	}

	const sent = sentMoves();
	expect(sent).toHaveLength(4);
	const nonces = sent.map((value) => value["nonce"]);
	for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9-]{16,64}$/);
	expect(new Set(nonces).size).toBe(4);
	// The watermark still rides beside it: the store refuses a stale removal.
	expect(sent.every((value) => value["onHand"] === String(ON_HAND))).toBe(true);
});

/** What the plugin serves for a movement the store answered from its ledger. */
const ALREADY_APPLIED = {
	ok: true,
	notice: {
		variant: "default",
		title: "Already applied",
		description: "This change was already applied — stock is now 17.",
	},
};

/**
 * Script the console's writes: each `otta_console_act` takes the next step —
 * `lose` (the request never comes back), `ok` (applied), `replayed` (the plugin
 * reports the ledger's answer), or `refuse` (the plugin's own definitive
 * `{ok:false}`). Reads answer as usual.
 */
function scriptWrites(steps: Array<"lose" | "ok" | "replayed" | "refuse">): void {
	const answer = apiFetch.getMockImplementation();
	apiFetch.mockImplementation((input, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { type?: string };
		if (body.type === "otta_console_act") {
			const step = steps.shift() ?? "ok";
			if (step === "lose") return Promise.reject(new TypeError("Failed to fetch"));
			if (step === "replayed") return Promise.resolve(envelope(ALREADY_APPLIED));
			if (step === "refuse") {
				return Promise.resolve(
					envelope({ ok: false, title: "Nothing was changed", description: "Refused." }),
				);
			}
		}
		if (answer === undefined) throw new Error("no default apiFetch");
		return answer(input, init);
	});
}

async function openStock(): Promise<Mounted> {
	const view = await show(<ProductDetail productId="prod-1" onBack={noop} />);
	await fire(one(view, '[data-testid="tab-stock"]'), "click");
	return view;
}

const RETRY = '[data-testid="detail-notice-action"]';
const retryButton = (view: Mounted): HTMLElement | null => view.container.querySelector(RETRY);

async function retry(view: Mounted): Promise<void> {
	await fire(one(view, RETRY), "click");
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

test("a LOST stock response says the change MAY have been applied, and offers an explicit Retry", async () => {
	scriptWrites(["lose"]);
	const view = await openStock();
	await confirmMovement(view, "restock", "5");
	expect(one(view, '[data-testid="detail-notice"]').textContent).toContain(
		"The change may have been applied — check the count before trying again.",
	);
	expect(one(view, RETRY).textContent).toContain("Retry this change");
});

test("RETRY is the only re-send: it sends the held nonce ONCE, and the plugin's 'already applied' answer is shown", async () => {
	scriptWrites(["lose", "replayed"]);
	const view = await openStock();
	await confirmMovement(view, "restock", "5");
	await retry(view);

	const sent = sentMoves();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toEqual(sent[0]); // the same move, the same nonce, re-sent
	// The answer reports where every stock outcome does: in the Add group.
	expect(one(view, '[data-testid="stock-add-receipt"]').textContent).toContain(
		"This change was already applied — stock is now 17.",
	);
	// Spent: there is nothing left to re-send.
	expect(retryButton(view)).toBeNull();
});

test("a NEW click after a lost response is a NEW move with a fresh nonce — even the same Add — and supersedes the Retry", async () => {
	// The operator reloads or simply looks, sees the count, and later adds 5
	// again on purpose. Treating that as the lost one's retry would drop it.
	scriptWrites(["lose", "ok"]);
	const view = await openStock();
	await confirmMovement(view, "restock", "5");
	expect(retryButton(view)).not.toBeNull();
	await confirmMovement(view, "restock", "5");

	const nonces = sentMoves().map((value) => value["nonce"]);
	expect(nonces).toHaveLength(2);
	expect(nonces[1]).not.toBe(nonces[0]);
	expect(retryButton(view)).toBeNull();
});

test("after a lost response and a RELOAD, the same Add is a fresh move — nothing is carried across", async () => {
	scriptWrites(["lose", "ok"]);
	await confirmMovement(await openStock(), "restock", "5");
	await mounted?.unmount();
	mounted = null;
	const reloaded = await openStock();
	expect(retryButton(reloaded)).toBeNull();
	await confirmMovement(reloaded, "restock", "5");

	const nonces = sentMoves().map((value) => value["nonce"]);
	expect(nonces).toHaveLength(2);
	expect(nonces[1]).not.toBe(nonces[0]);
});

test("a DUPLICATED tab (same storage) re-sends nothing on its own, and its Add is its own move", async () => {
	// Duplicate Tab copies sessionStorage; no held state may live there.
	scriptWrites(["lose", "ok"]);
	const original = await openStock();
	await confirmMovement(original, "restock", "5");
	const duplicate = await mount(<ProductDetail productId="prod-1" onBack={noop} />);
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(sentMoves()).toHaveLength(1); // mounting the duplicate sent nothing
	await fire(one(duplicate, '[data-testid="tab-stock"]'), "click");
	await confirmMovement(duplicate, "restock", "5");
	await duplicate.unmount();

	const nonces = sentMoves().map((value) => value["nonce"]);
	expect(nonces).toHaveLength(2);
	expect(nonces[1]).not.toBe(nonces[0]);
});

test("DENY leaves nothing held: no request, no Retry", async () => {
	const view = await openStock();
	const dialog = await askForMovement(view, "restock", "5");
	await fire(inDialog(dialog, "otta-confirm-deny"), "click");
	expect(sentMoves()).toHaveLength(0);
	expect(retryButton(view)).toBeNull();
});

test("a DEFINITIVE refusal offers no Retry — nothing ran", async () => {
	scriptWrites(["refuse"]);
	const view = await openStock();
	await confirmMovement(view, "restock", "5");
	expect(retryButton(view)).toBeNull();
});

test("a held Retry EXPIRES: after ten minutes it re-sends nothing and says to check the count", async () => {
	scriptWrites(["lose"]);
	const view = await openStock();
	await confirmMovement(view, "restock", "5");
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
	try {
		await retry(view);
	} finally {
		clock.mockRestore();
	}
	expect(sentMoves()).toHaveLength(1);
	expect(one(view, '[data-testid="detail-notice"]').textContent).toContain(
		"too old to retry safely",
	);
	expect(retryButton(view)).toBeNull();
});

test("opening a confirm and pressing DENY keeps the held Retry — only DISPATCHING a new move supersedes it", async () => {
	scriptWrites(["lose", "ok"]);
	const view = await openStock();
	await confirmMovement(view, "restock", "5"); // lost: Retry offered
	const dialog = await askForMovement(view, "remove", "2");
	await fire(inDialog(dialog, "otta-confirm-deny"), "click");
	expect(retryButton(view)).not.toBeNull(); // looking is not deciding

	await confirmMovement(view, "remove", "2"); // a new move dispatched
	expect(retryButton(view)).toBeNull();
});

test("a Retry that is lost AGAIN keeps the ORIGINAL hold time — the ten minutes are not restarted", async () => {
	scriptWrites(["lose", "lose"]);
	const base = Date.now();
	let offset = 0;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => base + offset);
	try {
		const view = await openStock();
		await confirmMovement(view, "restock", "5"); // lost at +0
		offset = 6 * 60_000;
		await retry(view); // lost again at +6 min: still held, from +0
		expect(retryButton(view)).not.toBeNull();
		offset = 11 * 60_000;
		await retry(view); // +11 min since the ORIGINAL loss: expired
		expect(sentMoves()).toHaveLength(2);
		expect(one(view, '[data-testid="detail-notice"]').textContent).toContain(
			"too old to retry safely",
		);
	} finally {
		clock.mockRestore();
	}
});
