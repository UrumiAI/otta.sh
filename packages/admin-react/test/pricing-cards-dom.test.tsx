/**
 * @vitest-environment happy-dom
 *
 * The product editor's Pricing & stock cards, mounted (ADR-0014, amendment
 * 2026-10-01). The decisions are proven in `pricing-model.test.ts`; this proves
 * the wiring: what is read, what is sent, and what the merchant sees after.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { PricingStockEditor, PricingStockField, productIdFromPath } =
	await import("../src/products/pricing-cards.js");
const admin = await import("../src/admin.js");
type ProductRecord = import("../src/console-api.js").ProductRecord;

const BASE: ProductRecord = {
	productId: "p_tee",
	sku: "OTTA-TEE",
	title: "Otta Tee",
	priceCents: 3200,
	currency: "USD",
	taxClass: null,
	compareAtCents: 4000,
	compareAtCurrency: "USD",
	unitCostCents: 1250,
	unitCostCurrency: "USD",
	inventoryPolicy: "deny",
	weightGrams: 200,
	lengthMm: null,
	widthMm: null,
	heightMm: null,
	productKind: "physical",
	active: true,
	deletedAt: null,
	onHand: 24,
	createdAt: "2026-09-01T09:00:00.000Z",
	updatedAt: "2026-09-30T10:00:00.000Z",
};

function json(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function detail(over: Partial<ProductRecord> = {}): Response {
	return json({
		ok: true,
		product: { ...BASE, ...over },
		taxClasses: [{ id: "standard", name: "Standard" }],
		threshold: 5,
		vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 },
	});
}

/** Every request the panel sent, parsed. */
function sent(): Array<Record<string, unknown>> {
	return apiFetch.mock.calls.map(
		([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>,
	);
}

function writes(): Array<Record<string, unknown>> {
	return sent().filter((body) => body["type"] === "otta_console_act");
}

let mounted: Mounted | null = null;

async function flush(): Promise<void> {
	// Reads arrive through promise chains a single `act` does not outlive.
	for (let i = 0; i < 4; i++) {
		await mounted?.rerender(panel());
	}
}

function panel(): React.ReactElement {
	return <PricingStockEditor productId="p_tee" />;
}

async function mountPanel(): Promise<HTMLElement> {
	mounted = await mount(panel());
	await flush();
	return mounted.container;
}

async function type(field: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
	const proto = field instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
	await React.act(async () => {
		Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(field, value);
		field.dispatchEvent(
			new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
		);
	});
}

function input(container: HTMLElement, label: string): HTMLInputElement {
	for (const el of container.querySelectorAll("label")) {
		if (el.textContent?.startsWith(label) === true) {
			const target = container.querySelector(`#${CSS.escape(el.htmlFor)}`);
			if (target !== null) return target as HTMLInputElement;
		}
	}
	throw new Error(`no field labelled ${label}`);
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
	for (const el of container.querySelectorAll("button")) {
		if (el.textContent?.trim() === name) return el;
	}
	throw new Error(`no button ${name}`);
}

beforeEach(() => {
	apiFetch.mockReset();
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
	window.history.replaceState(null, "", "/");
});

test("is the products collection's `pricing` field editor, found by its widget name", () => {
	expect((admin as unknown as { fields: Record<string, unknown> }).fields["pricing"]).toBe(
		PricingStockField,
	);
	expect(
		(admin as unknown as { contentEditorPanels?: unknown }).contentEditorPanels,
	).toBeUndefined();
});

test("finds the product from the editor's own address, and knows a new one has none", () => {
	expect(productIdFromPath("/_emdash/admin/content/products/01M3VQ9NGSF8Z48RY9FAR1B6R4")).toBe(
		"01M3VQ9NGSF8Z48RY9FAR1B6R4",
	);
	expect(productIdFromPath("/_emdash/admin/content/products/new")).toBeNull();
	expect(productIdFromPath("/_emdash/admin/content/pages/abc")).toBeNull();
	expect(productIdFromPath("/_emdash/admin/content/products")).toBeNull();
});

test("on a new product it asks for a save first and reads nothing", async () => {
	window.history.replaceState(null, "", "/_emdash/admin/content/products/new");
	mounted = await mount(<PricingStockField value={null} />);
	expect(mounted.container.textContent).toContain(
		"Save this product first, then set its price and stock here.",
	);
	expect(apiFetch).not.toHaveBeenCalled();
});

test("on a saved product it mounts the editor for that product", async () => {
	window.history.replaceState(null, "", "/_emdash/admin/content/products/p_tee");
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	const node = <PricingStockField value={null} />;
	mounted = await mount(node);
	for (let i = 0; i < 3; i++) await mounted.rerender(node);
	expect(sent()[0]).toMatchObject({ resource: "products.detail", productId: "p_tee" });
	expect(input(mounted.container, "Price").value).toBe("32.00");
});

test("a store admin's 403 is not an alarm: a non-admin sees a quiet note, once", async () => {
	apiFetch.mockImplementation(() =>
		Promise.resolve(
			new Response(
				JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "Forbidden" } }),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			),
		),
	);
	const c = await mountPanel();
	expect(c.textContent).toContain("Only store admins can change price and stock.");
	expect(c.querySelector('[role="alert"]')).toBeNull();
	expect(c.textContent).not.toContain("Try again");
});

test("Enter in a card saves the cards, never the CMS form around them; in the stock quantity it adds", async () => {
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Promise.resolve(
			body["type"] === "otta_console_act"
				? json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } })
				: detail(),
		);
	});
	const submitted = vi.fn((event: React.FormEvent) => {
		event.preventDefault();
	});
	const node = (
		<form onSubmit={submitted}>
			<PricingStockEditor productId="p_tee" />
		</form>
	);
	mounted = await mount(node);
	for (let i = 0; i < 3; i++) await mounted.rerender(node);
	const c = mounted.container;
	const press = async (field: HTMLInputElement): Promise<void> => {
		await React.act(async () => {
			field.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
			);
		});
		for (let i = 0; i < 4; i++) await mounted?.rerender(node);
	};
	await type(input(c, "Price"), "29");
	await press(input(c, "Price"));
	expect(submitted).not.toHaveBeenCalled();
	expect(writes().map((w) => w["action_id"])).toEqual(["products:save"]);

	await type(input(c, "Add or remove stock"), "2");
	await press(input(c, "Add or remove stock"));
	expect(writes().map((w) => w["action_id"])).toEqual(["products:save", "products:restock"]);
	expect(submitted).not.toHaveBeenCalled();
});

test("reads the product by its CMS entry id and shows price, sale, margin and stock", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	const c = await mountPanel();
	expect(sent()[0]).toMatchObject({ resource: "products.detail", productId: "p_tee" });
	expect(input(c, "Price").value).toBe("32.00");
	expect(c.textContent).toContain("Shown as a sale: $40.00 $32.00");
	expect(c.textContent).toContain("Profit $19.50");
	expect(c.textContent).toContain("Margin 61%");
	expect(c.querySelector('[data-testid="otta-on-hand"]')?.textContent).toBe("24");
	expect(c.querySelector('[data-testid="otta-stock-badge"]')?.textContent).toBe("In stock");
	// Nothing changed yet, so there is nothing to save.
	expect(button(c, "Save pricing & stock").disabled).toBe(true);
});

test("one Save sends every field with the loaded watermark, then re-reads", async () => {
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Promise.resolve(
			body["type"] === "otta_console_act"
				? json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } })
				: detail(),
		);
	});
	const c = await mountPanel();
	await type(input(c, "Price"), "29");
	expect(c.textContent).toContain("Price and stock changes are saved separately");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();

	expect(writes()).toEqual([
		{
			type: "otta_console_act",
			action_id: "products:save",
			value: expect.objectContaining({
				productId: "p_tee",
				expectedUpdatedAt: BASE.updatedAt,
				price: "29.00",
				currency: "USD",
				compareAt: "40.00",
				sku: "OTTA-TEE",
			}) as unknown,
		},
	]);
	expect(c.textContent).toContain("Saved");
	// Read on mount, read again just before the write, read after it.
	expect(sent().filter((b) => b["resource"] === "products.detail")).toHaveLength(3);
});

test("when someone else saved first, the panel shows the latest values, as the refusal says", async () => {
	let reads = 0;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			return Promise.resolve(
				json({
					ok: true,
					notice: {
						variant: "error",
						title: "This product changed since you opened it",
						description: "Your edit was NOT applied — the latest values are shown below.",
					},
					recordMoved: true,
				}),
			);
		}
		reads += 1;
		return Promise.resolve(
			// Mount, then the save's own read; only AFTER the refused write has the
			// row moved to 35.
			detail(reads > 2 ? { priceCents: 3500, updatedAt: "2026-09-30T12:00:00.000Z" } : {}),
		);
	});
	const c = await mountPanel();
	await type(input(c, "Price"), "29");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(input(c, "Price").value).toBe("35.00");
	expect(c.textContent).toContain("This product changed since you opened it");
});

test("a cleared SKU is refused beside the SKU, and focus goes there", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	const c = await mountPanel();
	await type(input(c, "SKU"), "");
	await fire(button(c, "Save pricing & stock"), "click");
	await React.act(async () => {
		await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
	});
	const sku = input(c, "SKU");
	expect(sku.getAttribute("aria-invalid")).toBe("true");
	expect(c.textContent).toContain("A SKU can be changed but not removed");
	expect(document.activeElement).toBe(sku);
	expect(writes()).toEqual([]);
});

test("a problem inside the folded Shipping & tax section opens it", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	const c = await mountPanel();
	const details = c.querySelector("details");
	expect(details?.open).toBe(false);
	await type(input(c, "Weight"), "");
	await fire(button(c, "Save pricing & stock"), "click");
	expect(details?.open).toBe(true);
	expect(c.textContent).toContain("Can be changed but not removed");
});

test("an in-app link asks before leaving unsaved price changes, and stays put when told to", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	// happy-dom has no `window.confirm`; the page's real one is a blocking dialog.
	const confirm = vi.fn<(message?: string) => boolean>();
	const original = window.confirm;
	window.confirm = confirm;
	try {
		const node = (
			<>
				<a href="/_emdash/admin/content/products" data-testid="back">
					Back to Products
				</a>
				<PricingStockEditor productId="p_tee" />
			</>
		);
		mounted = await mount(node);
		for (let i = 0; i < 3; i++) await mounted.rerender(node);
		const link = mounted.container.querySelector('[data-testid="back"]') as HTMLAnchorElement;
		const click = (): MouseEvent => {
			const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
			link.dispatchEvent(event);
			return event;
		};
		// Nothing typed: no question.
		expect(click().defaultPrevented).toBe(false);
		expect(confirm).not.toHaveBeenCalled();

		await type(input(mounted.container, "Price"), "29");
		confirm.mockReturnValueOnce(false);
		expect(click().defaultPrevented).toBe(true);
		confirm.mockReturnValueOnce(true);
		expect(click().defaultPrevented).toBe(false);
	} finally {
		window.confirm = original;
	}
});

test("a wrong amount is said in plain words and nothing is sent", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	const c = await mountPanel();
	await type(input(c, "Price"), "29,99");
	expect(c.textContent).toContain("Enter a price like 24.99");
	await fire(button(c, "Save pricing & stock"), "click");
	expect(writes()).toEqual([]);
	expect(c.textContent).toContain("Fix the highlighted fields to save");
});

test("a SKU the store refuses keeps what was typed, with the reason beside the SKU", async () => {
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Promise.resolve(
			body["type"] === "otta_console_act"
				? json({
						ok: true,
						notice: {
							variant: "error",
							title: "That SKU is taken",
							description: 'Another product uses "MUG".',
						},
						field: "sku",
					})
				: detail(),
		);
	});
	const c = await mountPanel();
	await type(input(c, "SKU"), "MUG");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(input(c, "SKU").value).toBe("MUG");
	expect(c.textContent).toContain('Another product uses "MUG".');
});

test("an unpriced product asks for a price and saves it in the currency the merchant picked", async () => {
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Promise.resolve(
			body["type"] === "otta_console_act"
				? json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } })
				: detail({ priceCents: null, currency: null, compareAtCents: null, unitCostCents: null }),
		);
	});
	const c = await mountPanel();
	expect(c.textContent).toContain("Add a price so customers can buy this product.");
	const currency = input(c, "Currency") as unknown as HTMLSelectElement;
	expect(currency.value).toBe("USD");
	await type(currency, "EUR");
	await type(input(c, "Price"), "18");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(writes()[0]?.["value"]).toMatchObject({ price: "18.00", currency: "EUR" });
});

test("an unpriced product's currency starts on the store currency the detail read carried, and saves in it", async () => {
	const unpriced = { priceCents: null, currency: null, compareAtCents: null, unitCostCents: null };
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			return Promise.resolve(
				json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } }),
			);
		}
		return Promise.resolve(
			json({
				ok: true,
				product: { ...BASE, ...unpriced },
				taxClasses: [{ id: "standard", name: "Standard" }],
				threshold: 5,
				storeCurrency: "JPY",
				vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 },
			}),
		);
	});
	const c = await mountPanel();
	const currency = input(c, "Currency") as unknown as HTMLSelectElement;
	expect(currency.value).toBe("JPY");
	await type(input(c, "Price"), "1500");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(writes()[0]?.["value"]).toMatchObject({ price: "1500", currency: "JPY" });
});

test("when the store currency could not be read, nothing is preselected: the merchant must choose before a price saves", async () => {
	const unpriced = { priceCents: null, currency: null, compareAtCents: null, unitCostCents: null };
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			return Promise.resolve(
				json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } }),
			);
		}
		return Promise.resolve(
			json({
				ok: true,
				product: { ...BASE, ...unpriced },
				taxClasses: [{ id: "standard", name: "Standard" }],
				threshold: 5,
				storeCurrency: null,
				vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 },
			}),
		);
	});
	const c = await mountPanel();
	const currency = input(c, "Currency") as unknown as HTMLSelectElement;
	expect(currency.value).toBe("");
	expect(c.querySelector('[data-testid="store-currency-unknown"]')?.textContent).toBe(
		"Couldn't load your store currency — choose one.",
	);
	await type(input(c, "Price"), "18");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	// Refused in the panel: nothing written, and the reason beside the picker.
	expect(writes()).toHaveLength(0);
	expect(c.textContent).toContain("Choose a supported currency");
	await type(currency, "EUR");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(writes()[0]?.["value"]).toMatchObject({ price: "18.00", currency: "EUR" });
});

/** A detail answer for an UNPRICED product, carrying `storeCurrency` as given. */
function unpricedDetail(storeCurrency: string | null, over: Partial<ProductRecord> = {}): Response {
	return json({
		ok: true,
		product: {
			...BASE,
			priceCents: null,
			currency: null,
			compareAtCents: null,
			unitCostCents: null,
			...over,
		},
		taxClasses: [{ id: "standard", name: "Standard" }],
		threshold: 5,
		storeCurrency,
		vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 },
	});
}

test("a later re-read whose settings read failed keeps the store currency already loaded — no prompt", async () => {
	let moved = false;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			moved = true;
			return Promise.resolve(json({ ok: true, notice: null }));
		}
		// First read: EUR. Every read after the stock move: the settings read failed.
		return Promise.resolve(moved ? unpricedDetail(null, { onHand: 29 }) : unpricedDetail("EUR"));
	});
	const c = await mountPanel();
	expect((input(c, "Currency") as unknown as HTMLSelectElement).value).toBe("EUR");
	await type(input(c, "Add or remove stock"), "5");
	await fire(button(c, "Add"), "click");
	await flush();
	expect(c.textContent).toContain("now 29 in stock");
	expect((input(c, "Currency") as unknown as HTMLSelectElement).value).toBe("EUR");
	expect(c.querySelector('[data-testid="store-currency-unknown"]')).toBeNull();
});

test("a currency picked before typing a price survives a re-read, and the price saves in it", async () => {
	let moved = false;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			if ((body["action_id"] as string) === "products:restock") moved = true;
			return Promise.resolve(
				json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } }),
			);
		}
		return Promise.resolve(unpricedDetail("EUR", moved ? { onHand: 29 } : {}));
	});
	const c = await mountPanel();
	await type(input(c, "Currency") as unknown as HTMLSelectElement, "JPY");
	// A stock movement re-reads the product (store currency still EUR).
	await type(input(c, "Add or remove stock"), "5");
	await fire(button(c, "Add"), "click");
	await flush();
	expect(c.textContent).toContain("now 29 in stock");
	expect((input(c, "Currency") as unknown as HTMLSelectElement).value).toBe("JPY");
	await type(input(c, "Price"), "1500");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	const save = writes().find((w) => w["action_id"] === "products:save");
	expect(save?.["value"]).toMatchObject({ price: "1500", currency: "JPY" });
});

test("a later read that knows the store currency hides the prompt and adopts it while nothing is picked", async () => {
	let moved = false;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			moved = true;
			return Promise.resolve(json({ ok: true, notice: null }));
		}
		return Promise.resolve(moved ? unpricedDetail("EUR", { onHand: 29 }) : unpricedDetail(null));
	});
	const c = await mountPanel();
	expect(c.querySelector('[data-testid="store-currency-unknown"]')).not.toBeNull();
	await type(input(c, "Add or remove stock"), "5");
	await fire(button(c, "Add"), "click");
	await flush();
	expect(c.querySelector('[data-testid="store-currency-unknown"]')).toBeNull();
	expect((input(c, "Currency") as unknown as HTMLSelectElement).value).toBe("EUR");
});

const STORE_MOVED_USD_EUR =
	"Your store currency is now EUR — this product will be priced in USD unless you choose EUR. Pick the currency to confirm, then save.";

test("a price typed under the shown default: a re-read with a switched store currency blocks the save until a currency is picked", async () => {
	let moved = false;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			if ((body["action_id"] as string) === "products:restock") moved = true;
			return Promise.resolve(
				json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } }),
			);
		}
		// The operator switched the store currency to EUR between the two reads.
		return Promise.resolve(moved ? unpricedDetail("EUR", { onHand: 29 }) : unpricedDetail("USD"));
	});
	const c = await mountPanel();
	await type(input(c, "Price"), "24.99");
	await type(input(c, "Add or remove stock"), "5");
	await fire(button(c, "Add"), "click");
	await flush();
	expect(c.textContent).toContain("now 29 in stock");
	// Frozen to USD, and the merchant is TOLD; the amount is kept.
	expect((input(c, "Currency") as unknown as HTMLSelectElement).value).toBe("USD");
	expect((input(c, "Price") as HTMLInputElement).value).toBe("24.99");
	expect(c.textContent).toContain(STORE_MOVED_USD_EUR);
	// A keystroke clears the banner, but the rule is re-evaluated at SAVE: blocked.
	await type(input(c, "Price"), "24.98");
	expect(c.textContent).not.toContain(STORE_MOVED_USD_EUR);
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(writes().some((w) => w["action_id"] === "products:save")).toBe(false);
	expect(c.textContent).toContain(STORE_MOVED_USD_EUR);
	// Picking the currency confirms it; the save goes through in it.
	await type(input(c, "Currency") as unknown as HTMLSelectElement, "EUR");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	const save = writes().find((w) => w["action_id"] === "products:save");
	expect(save?.["value"]).toMatchObject({ price: "24.98", currency: "EUR" });
});

test("a store-default-moved banner offers Keep USD, and the next save goes through in USD", async () => {
	let reads = 0;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			return Promise.resolve(
				json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } }),
			);
		}
		reads += 1;
		return Promise.resolve(unpricedDetail(reads === 1 ? "USD" : "EUR"));
	});
	const c = await mountPanel();
	await type(input(c, "Price"), "24.99");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(c.textContent).toContain(STORE_MOVED_USD_EUR);
	await fire(button(c, "Keep USD"), "click");
	expect(c.textContent).not.toContain(STORE_MOVED_USD_EUR);
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	const save = writes().find((w) => w["action_id"] === "products:save");
	expect(save?.["value"]).toMatchObject({ price: "24.99", currency: "USD" });
});

test("priced elsewhere in KWD at save: the USD amounts typed are cleared, and the next save sends no cost", async () => {
	let reads = 0;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			return Promise.resolve(
				json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } }),
			);
		}
		reads += 1;
		// Mount: unpriced (USD store). Every later read: priced by someone else in
		// KWD at 12.500, with no unit cost.
		return Promise.resolve(
			reads === 1
				? unpricedDetail("USD")
				: unpricedDetail("USD", {
						priceCents: 12_500,
						currency: "KWD",
						updatedAt: "2026-07-02T00:00:00.000Z",
					}),
		);
	});
	const c = await mountPanel();
	await type(input(c, "Price"), "24.99");
	await type(input(c, "Cost per item"), "9.50");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(writes().some((w) => w["action_id"] === "products:save")).toBe(false);
	expect(c.textContent).toContain(
		"This product was priced in KWD by someone else — the amounts you entered in USD were replaced with its saved ones — check every amount in KWD before saving.",
	);
	expect((input(c, "Cost per item") as HTMLInputElement).value).toBe("");
	// Saving again (now against the priced record) sends no cost — never 9.50 as KWD.
	await type(input(c, "Price"), "13.000");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	const save = writes().find((w) => w["action_id"] === "products:save");
	expect(save).toBeDefined();
	const value = save?.["value"] as Record<string, unknown>;
	expect(value["unitCost"] ?? "").toBe("");
	expect(value["price"]).toBe("13.000");
});

test("the read-before-save uses the FRESH store currency: a switch since the form loaded blocks the save", async () => {
	let reads = 0;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			return Promise.resolve(
				json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } }),
			);
		}
		reads += 1;
		// The first read (mount) says USD; the read-before-save says EUR.
		return Promise.resolve(unpricedDetail(reads === 1 ? "USD" : "EUR"));
	});
	const c = await mountPanel();
	await type(input(c, "Price"), "24.99");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(writes().some((w) => w["action_id"] === "products:save")).toBe(false);
	expect(c.textContent).toContain(STORE_MOVED_USD_EUR);
	expect((input(c, "Currency") as unknown as HTMLSelectElement).value).toBe("USD");
});

test("after an initial failed read, picking a currency clears the prompt", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(unpricedDetail(null)));
	const c = await mountPanel();
	expect(c.querySelector('[data-testid="store-currency-unknown"]')).not.toBeNull();
	await type(input(c, "Currency") as unknown as HTMLSelectElement, "GBP");
	expect(c.querySelector('[data-testid="store-currency-unknown"]')).toBeNull();
});

test("Save reads the product first: it writes against the NEW watermark and keeps only the merchant's edits", async () => {
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Promise.resolve(
			body["type"] === "otta_console_act"
				? json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } })
				: detail(),
		);
	});
	const c = await mountPanel();
	await type(input(c, "Price"), "30");
	// Meanwhile the row moved — a CMS save (new watermark) and another admin's
	// new weight the merchant never touched. Nothing tells the section; its
	// save's own read finds out.
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Promise.resolve(
			body["type"] === "otta_console_act"
				? json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } })
				: detail({ weightGrams: 450, updatedAt: "2026-09-30T11:00:00.000Z" }),
		);
	});
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(writes()[0]?.["value"]).toMatchObject({
		expectedUpdatedAt: "2026-09-30T11:00:00.000Z",
		price: "30.00",
		// NOT the 200 the panel first loaded: the other admin's change stands.
		weightGrams: "450",
	});
});

test("a refusal that declines a value keeps what the merchant typed", async () => {
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Promise.resolve(
			body["type"] === "otta_console_act"
				? json({
						ok: true,
						notice: {
							variant: "error",
							title: "Invalid value",
							description: "Price must be greater than zero.",
						},
					})
				: detail(),
		);
	});
	const c = await mountPanel();
	await type(input(c, "Price"), "31");
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(input(c, "Price").value).toBe("31");
	expect(c.textContent).toContain("Invalid value. Price must be greater than zero.");
});

test("Add stock is one click; it sends the count the merchant saw and reports the count the store now holds", async () => {
	let added = false;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			added = true;
			return Promise.resolve(json({ ok: true, notice: null }));
		}
		return Promise.resolve(detail(added ? { onHand: 29 } : {}));
	});
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "5");
	await fire(button(c, "Add"), "click");
	await flush();
	expect(writes()).toEqual([
		{
			type: "otta_console_act",
			action_id: "products:restock",
			// The nonce is the move's idempotency key, minted for this click
			// (`mintMovementNonce`: 128 random bits as hex).
			value: {
				productId: "p_tee",
				onHand: "24",
				qty: "5",
				nonce: expect.stringMatching(HEX_NONCE),
			},
		},
	]);
	expect(c.textContent).toContain("Added 5 — now 29 in stock");
});

test("Remove asks first, and never offers to take more than there is", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail({ onHand: 3 })));
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "5");
	await fire(button(c, "Remove"), "click");
	expect(c.textContent).toContain("You only have 3 in stock");
	expect(writes()).toEqual([]);

	await type(input(c, "Add or remove stock"), "2");
	await fire(button(c, "Remove"), "click");
	const dialog = c.querySelector('[data-testid="otta-confirm"]');
	expect(dialog?.textContent).toContain("Remove 2 from stock?");
	expect(dialog?.textContent).toContain("You'll have 1 left.");
	expect(writes()).toEqual([]);
});

// QA round 2: Add 100,000,000 applied with no confirm, while Remove always asks.
test("a very large Add asks first, says what the count becomes, and adds only on Yes", async () => {
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act")
			return Promise.resolve(json({ ok: true, notice: null }));
		return Promise.resolve(detail({ onHand: 24 }));
	});
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "100000000");
	await fire(button(c, "Add"), "click");
	const dialog = c.querySelector('[data-testid="otta-confirm"]');
	expect(dialog?.textContent).toContain("Add 100,000,000 to stock?");
	expect(dialog?.textContent).toContain("You'll have 100,000,024");
	expect(writes()).toEqual([]);

	await fire(c.querySelector('[data-testid="otta-confirm-yes"]')!, "click");
	await flush();
	expect(writes()).toEqual([
		expect.objectContaining({
			action_id: "products:restock",
			value: expect.objectContaining({ qty: "100000000", onHand: "24" }),
		}),
	]);
});

test("an ordinary Add (up to 10,000) is still one click", async () => {
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act")
			return Promise.resolve(json({ ok: true, notice: null }));
		return Promise.resolve(detail({}));
	});
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "10000");
	await fire(button(c, "Add"), "click");
	await flush();
	expect(writes()).toHaveLength(1);
});

test("a field changed elsewhere since the merchant started stops the save, and says so", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	const c = await mountPanel();
	await type(input(c, "Price"), "30");
	await type(input(c, "SKU"), "TEE-2");
	apiFetch.mockImplementation(() =>
		Promise.resolve(detail({ priceCents: 3500, updatedAt: "2026-09-30T11:00:00.000Z" })),
	);
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
	expect(writes()).toEqual([]);
	expect(c.textContent).toContain("Someone else changed this product while you were editing.");
	// The store's price for the clashing field; the merchant's SKU edit survives.
	expect(input(c, "Price").value).toBe("35.00");
	expect(input(c, "SKU").value).toBe("TEE-2");
});

test("a product in the trash is read-only", async () => {
	apiFetch.mockImplementation(() =>
		Promise.resolve(detail({ deletedAt: "2026-09-30T12:00:00.000Z" })),
	);
	const c = await mountPanel();
	expect(c.textContent).toContain("This product is in the trash");
	expect(c.querySelector("input")).toBeNull();
});

test("a read that fails says why and offers to try again", async () => {
	apiFetch.mockImplementation(() =>
		Promise.resolve(
			json({ ok: false, title: "Product not found", description: "It may have been removed." }),
		),
	);
	const c = await mountPanel();
	expect(c.textContent).toContain("Product not found");
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	await fire(button(c, "Try again"), "click");
	await flush();
	expect(input(c, "Price").value).toBe("32.00");
});

// -- stock moves: one click, one nonce; Retry is the only re-send -------------
//
// QA T1-2: Add 2, Remove 2, Add 2 had its third move refused, because a move was
// keyed on what it looked like (`productId:direction:onHand:qty`). The cards now
// send a nonce minted per click, and re-send one only through an explicit
// "Retry this change" after an answer was lost (ADR-0015, amended 2026-10-02).

const HEX_NONCE = /^[0-9a-f]{32}$/;

type Step = "ok" | "lose-after" | "lose-before" | "refuse" | "pending";

/**
 * A store behind the cards that behaves like the plugin's ledger: a move applies
 * once per nonce, and a nonce it has seen is answered as a replay. Each write
 * takes the next scripted step: `lose-after` applies the move and then loses the
 * answer, `lose-before` loses the request before anything ran, `refuse` is the
 * plugin's own definitive `{ok:false}`.
 */
function stockServer(
	start: number,
	steps: Step[] = [],
): { onHand: () => number; release: () => Promise<void> } {
	let onHand = start;
	let release: (() => void) | null = null;
	const seen = new Set<string>();
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] !== "otta_console_act") return Promise.resolve(detail({ onHand }));
		const step = steps.shift() ?? "ok";
		if (step === "lose-before") return Promise.reject(new TypeError("Failed to fetch"));
		if (step === "refuse") {
			return Promise.resolve(
				json({ ok: false, title: "Nothing was changed", description: "Refused." }),
			);
		}
		const value = body["value"] as Record<string, string>;
		if (step === "pending") {
			// Applied when released, like a slow request that lands.
			return new Promise<Response>((resolve) => {
				release = () => {
					onHand += Number(value["qty"]) * (body["action_id"] === "products:restock" ? 1 : -1);
					resolve(
						json({
							ok: true,
							notice: { variant: "default", title: "Stock added", description: "" },
						}),
					);
				};
			});
		}
		const nonce = value["nonce"] ?? "";
		const replayed = seen.has(nonce);
		if (!replayed) {
			seen.add(nonce);
			const qty = Number(value["qty"]);
			onHand += body["action_id"] === "products:restock" ? qty : -qty;
		}
		if (step === "lose-after") return Promise.reject(new TypeError("Failed to fetch"));
		return Promise.resolve(
			json(
				replayed
					? {
							ok: true,
							notice: {
								variant: "default",
								title: "Already applied",
								description: `This change was already applied — stock is now ${String(onHand)}.`,
							},
							replayed: true,
						}
					: { ok: true, notice: { variant: "default", title: "Stock added", description: "" } },
			),
		);
	});
	return {
		onHand: () => onHand,
		release: async () => {
			await React.act(async () => {
				release?.();
			});
			await flush();
		},
	};
}

function nonces(): unknown[] {
	return writes().map((w) => (w["value"] as Record<string, unknown>)["nonce"]);
}

async function add(c: HTMLElement, qty: string): Promise<void> {
	await type(input(c, "Add or remove stock"), qty);
	await fire(button(c, "Add"), "click");
	await flush();
}

async function remove(c: HTMLElement, qty: string): Promise<void> {
	await type(input(c, "Add or remove stock"), qty);
	await fire(button(c, "Remove"), "click");
	const yes = c.querySelector('[data-testid="otta-confirm-yes"]');
	if (yes === null) throw new Error("no remove confirm");
	await fire(yes, "click");
	await flush();
}

const retryButton = (c: HTMLElement): HTMLButtonElement | null =>
	c.querySelector('[data-testid="otta-stock-retry"]');

async function retry(c: HTMLElement): Promise<void> {
	const b = retryButton(c);
	if (b === null) throw new Error("no Retry offered");
	await fire(b, "click");
	await flush();
}

const heldText = (c: HTMLElement): string =>
	c.querySelector('[data-testid="otta-stock-held"] [role="alert"]')?.textContent ?? "";

/** Enter in the quantity: the cards' keyboard Add, reachable while a confirm is
 *  open in a DOM without modal inertness. */
async function pressEnterInQty(c: HTMLElement): Promise<void> {
	const field = input(c, "Add or remove stock");
	await React.act(async () => {
		field.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
		);
	});
	await flush();
}

const onHandShown = (c: HTMLElement): string | null | undefined =>
	c.querySelector('[data-testid="otta-on-hand"]')?.textContent;

test("Add 2, Remove 2, Add 2: every click is its own move with its own nonce, and all three land", async () => {
	const server = stockServer(7);
	const c = await mountPanel();
	await add(c, "2");
	expect(c.textContent).toContain("Added 2 — now 9 in stock");
	await remove(c, "2");
	expect(c.textContent).toContain("Removed 2 — now 7 in stock");
	await add(c, "2");
	expect(c.textContent).toContain("Added 2 — now 9 in stock");
	expect(onHandShown(c)).toBe("9");
	expect(server.onHand()).toBe(9);
	const sentNonces = nonces();
	expect(sentNonces).toHaveLength(3);
	for (const n of sentNonces) expect(n).toMatch(HEX_NONCE);
	expect(new Set(sentNonces).size).toBe(3);
});

test("the same Add twice in a row is two moves: a nonce is never reused after a success", async () => {
	const server = stockServer(24);
	const c = await mountPanel();
	await add(c, "5");
	await add(c, "5");
	expect(server.onHand()).toBe(34);
	expect(c.textContent).toContain("Added 5 — now 34 in stock");
	expect(new Set(nonces()).size).toBe(2);
});

test("a re-render does not mint a nonce: only a click does", async () => {
	stockServer(24);
	const c = await mountPanel();
	await flush();
	expect(writes()).toEqual([]);
	await add(c, "1");
	expect(writes()).toHaveLength(1);
});

test("a double click on Add sends ONE move", async () => {
	const server = stockServer(24);
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "5");
	const addButton = button(c, "Add");
	// Two clicks inside one task, before React can re-render the button disabled.
	await React.act(async () => {
		addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await flush();
	expect(writes()).toHaveLength(1);
	expect(server.onHand()).toBe(29);
});

test("a LOST answer says the change may have landed and offers Retry, which re-sends the SAME nonce once", async () => {
	const server = stockServer(24, ["lose-after"]);
	const c = await mountPanel();
	await add(c, "5");
	expect(heldText(c)).toContain(
		"Add 5 — the change may have been applied; check the count before trying again.",
	);
	expect(c.textContent).not.toContain("Added 5");
	expect(retryButton(c)?.textContent?.trim()).toBe("Retry: add 5");

	await retry(c);
	const moves = writes();
	expect(moves).toHaveLength(2);
	expect(moves[1]).toEqual(moves[0]); // the same move, the same nonce
	expect(server.onHand()).toBe(29); // applied once
	// The ledger answered: it is reported as already applied, never a fresh add.
	expect(c.textContent).toContain("Already applied — now 29 in stock");
	expect(c.textContent).not.toContain("Added 5");
	expect(retryButton(c)).toBeNull(); // spent
});

test("a Retry of a move that never ran applies it, once", async () => {
	const server = stockServer(24, ["lose-before"]);
	const c = await mountPanel();
	await add(c, "5");
	await retry(c);
	expect(server.onHand()).toBe(29);
	expect(c.textContent).toContain("Added 5 — now 29 in stock");
	expect(nonces()[1]).toBe(nonces()[0]);
});

test("a NEW click after a lost answer is a new move with a fresh nonce, and the Retry goes", async () => {
	const server = stockServer(24, ["lose-after"]);
	const c = await mountPanel();
	await add(c, "5");
	expect(retryButton(c)).not.toBeNull();
	await add(c, "5");
	const keys = nonces();
	expect(keys).toHaveLength(2);
	expect(keys[1]).not.toBe(keys[0]);
	expect(server.onHand()).toBe(34);
	expect(retryButton(c)).toBeNull();
});

test("Cancel on the remove confirm keeps the Retry; confirming a removal replaces it", async () => {
	stockServer(24, ["lose-after"]);
	const c = await mountPanel();
	await add(c, "5");
	await type(input(c, "Add or remove stock"), "2");
	await fire(button(c, "Remove"), "click");
	const deny = c.querySelector('[data-testid="otta-confirm-deny"]');
	if (deny === null) throw new Error("no remove confirm");
	await fire(deny, "click");
	expect(retryButton(c)).not.toBeNull(); // looking is not deciding
	await remove(c, "2");
	expect(retryButton(c)).toBeNull();
	expect(new Set(nonces()).size).toBe(2);
});

test("a definitive refusal offers no Retry — nothing ran", async () => {
	stockServer(24, ["refuse"]);
	const c = await mountPanel();
	await add(c, "5");
	expect(c.textContent).toContain("Nothing was changed");
	expect(retryButton(c)).toBeNull();
});

test("a held Retry expires ten minutes after the ORIGINAL loss, even when a Retry is lost again", async () => {
	stockServer(24, ["lose-after", "lose-after"]);
	const base = Date.now();
	let offset = 0;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => base + offset);
	try {
		const c = await mountPanel();
		await add(c, "5"); // lost at +0
		offset = 6 * 60_000;
		await retry(c); // lost again at +6 min: still held, from +0
		expect(retryButton(c)).not.toBeNull();
		offset = 11 * 60_000;
		await retry(c); // +11 min since the original loss: too old
		expect(writes()).toHaveLength(2);
		expect(c.textContent).toContain(
			"This change is too old to retry safely — check the count before trying again.",
		);
		expect(retryButton(c)).toBeNull();
	} finally {
		clock.mockRestore();
	}
});

test("the held Retry names the move it re-sends, and sends THAT move, whatever is typed now", async () => {
	const server = stockServer(24, ["lose-after"]);
	const c = await mountPanel();
	await add(c, "5");
	const first = writes()[0];
	await type(input(c, "Add or remove stock"), "3");
	expect(heldText(c)).toContain("Add 5 —");
	expect(retryButton(c)?.textContent?.trim()).toBe("Retry: add 5");
	// The Retry button sits outside the announced text.
	expect(c.querySelector('[role="alert"] [data-testid="otta-stock-retry"]')).toBeNull();
	await retry(c);
	const moves = writes();
	expect(moves).toHaveLength(2);
	const retried = moves[1]?.["value"] as Record<string, string>;
	expect(retried["qty"]).toBe("5");
	expect(moves[1]).toEqual(first);
	expect(server.onHand()).toBe(29);
});

test("a held removal is named as one", async () => {
	stockServer(24, ["lose-after"]);
	const c = await mountPanel();
	await remove(c, "2");
	expect(heldText(c)).toContain("Remove 2 — the change may have been applied");
	expect(retryButton(c)?.textContent?.trim()).toBe("Retry: remove 2");
});

test("a LOST answer re-reads the count, so the next move is judged against the server's", async () => {
	const server = stockServer(24, ["lose-after"]);
	const c = await mountPanel();
	await add(c, "5"); // landed; only the answer was lost
	expect(onHandShown(c)).toBe("29");
	expect(retryButton(c)).not.toBeNull(); // the re-read keeps the Retry
	expect(c.textContent).not.toContain("Added 5"); // and is not a receipt
	await remove(c, "2");
	// The removal's watermark is the re-read count, not the stale 24.
	const removal = writes()[1]?.["value"] as Record<string, string>;
	expect(removal["onHand"]).toBe("29");
	expect(server.onHand()).toBe(27);
});

const confirmOpen = (c: HTMLElement): boolean =>
	c.querySelector<HTMLDialogElement>('[data-testid="otta-confirm"]')?.open === true;

test("a re-read that moves the count while the remove confirm is open closes it and says so — nothing is removed", async () => {
	stockServer(24);
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "2");
	await fire(button(c, "Remove"), "click");
	expect(confirmOpen(c)).toBe(true);
	expect(c.querySelector('[data-testid="otta-confirm-text"]')?.textContent).toContain(
		"You'll have 22 left.",
	);
	// A move lands while the dialog is open, and the cards re-read 26: the
	// dialog's "22 left" is no longer true, so it is not left standing.
	await pressEnterInQty(c);
	expect(onHandShown(c)).toBe("26");
	expect(confirmOpen(c)).toBe(false);
	expect(c.textContent).toContain(
		"Stock changed to 26 while you were deciding — nothing was removed; check and try again.",
	);
	expect(writes().map((w) => w["action_id"])).toEqual(["products:restock"]);
});

test("a confirm left open by a lost answer that moved nothing still sends the count it showed", async () => {
	stockServer(24, ["lose-before"]);
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "2");
	await fire(button(c, "Remove"), "click");
	await pressEnterInQty(c); // lost before it ran; the re-read still says 24
	expect(confirmOpen(c)).toBe(true);
	const yes = c.querySelector('[data-testid="otta-confirm-yes"]');
	if (yes === null) throw new Error("no remove confirm");
	await fire(yes, "click");
	await flush();
	const removal = writes()[1]?.["value"] as Record<string, string>;
	expect(removal["qty"]).toBe("2");
	expect(removal["onHand"]).toBe("24");
});

test("the remove confirm cannot be pressed while another move is in flight, says why politely, and closes when that move changes the count", async () => {
	const server = stockServer(24, ["pending"]);
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "2");
	await fire(button(c, "Remove"), "click");
	await pressEnterInQty(c); // an Add, still in flight
	const yes = c.querySelector<HTMLButtonElement>('[data-testid="otta-confirm-yes"]');
	if (yes === null) throw new Error("no remove confirm");
	expect(yes.disabled).toBe(true);
	const status = c.querySelector('[data-testid="otta-confirm-status"]');
	expect(status?.getAttribute("aria-live")).toBe("polite");
	expect(status?.textContent).toContain("Another stock change is still running");
	await server.release();
	expect(server.onHand()).toBe(26);
	expect(confirmOpen(c)).toBe(false);
	expect(c.textContent).toContain("Added 2 — now 26 in stock");
	expect(c.textContent).toContain("Stock changed to 26 while you were deciding");
	expect(writes().map((w) => w["action_id"])).toEqual(["products:restock"]);
});

test("a STALE re-read that resolves after a Retry succeeded cannot print the receipt or release the buttons — only the Retry's own re-read does", async () => {
	// R1 is the re-read after the lost answer; R2 the one after the Retry. R1
	// resolves (with the pre-Retry count) after the Retry's answer is in but
	// before R2 runs.
	let onHand = 24;
	let writesSeen = 0;
	let releaseWrite: (() => void) | null = null;
	let releaseRead: (() => void) | null = null;
	let holdNextRead = false;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] !== "otta_console_act") {
			if (holdNextRead) {
				holdNextRead = false;
				const snapshot = onHand;
				return new Promise<Response>((resolve) => {
					releaseRead = () => {
						resolve(detail({ onHand: snapshot }));
					};
				});
			}
			return Promise.resolve(detail({ onHand }));
		}
		writesSeen += 1;
		if (writesSeen === 1) return Promise.reject(new TypeError("Failed to fetch"));
		return new Promise<Response>((resolve) => {
			releaseWrite = () => {
				onHand += 5;
				resolve(
					json({ ok: true, notice: { variant: "default", title: "Stock added", description: "" } }),
				);
			};
		});
	});
	const c = await mountPanel();
	holdNextRead = true;
	await add(c, "5"); // lost before it ran; R1 is now pending with 24
	expect(releaseRead).not.toBeNull();
	await retry(c); // the Retry's write is pending
	await React.act(async () => {
		releaseWrite?.();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		releaseRead?.();
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});
	await flush();
	expect(c.textContent).not.toContain("now 24 in stock");
	expect(c.textContent).toContain("Added 5 — now 29 in stock");
	expect(onHandShown(c)).toBe("29");
});

test("if the re-read after a lost answer fails, the held move and its Retry stay on the failure view", async () => {
	let onHand = 24;
	let failReads = false;
	let wrote = 0;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			wrote += 1;
			if (wrote === 1) {
				onHand += 5; // landed; the answer is lost
				failReads = true;
				return Promise.reject(new TypeError("Failed to fetch"));
			}
			return Promise.resolve(
				json({
					ok: true,
					notice: { variant: "default", title: "Already applied", description: "" },
					replayed: true,
				}),
			);
		}
		if (failReads) {
			return Promise.resolve(
				json({ ok: false, title: "Products are unavailable", description: "Try again." }),
			);
		}
		return Promise.resolve(detail({ onHand }));
	});
	const c = await mountPanel();
	await add(c, "5");
	expect(c.textContent).toContain("Products are unavailable");
	expect(heldText(c)).toContain(
		"Add 5 — the change may have been applied; check the count before trying again.",
	);
	expect(retryButton(c)?.textContent?.trim()).toBe("Retry: add 5");
	failReads = false;
	await retry(c);
	expect(writes()).toHaveLength(2);
	expect(writes()[1]).toEqual(writes()[0]);
	expect(c.textContent).toContain("Already applied — now 29 in stock");
});

// -- a newer re-read includes the move: the receipt never waits forever -----

/**
 * A server whose writes are released by hand, per action, and whose next read
 * can be held or failed. `products:save` answers "Saved"; a stock write applies
 * its quantity when released.
 */
function manualServer(start: number) {
	let onHand = start;
	const pendingWrites = new Map<string, () => void>();
	let heldRead: (() => void) | null = null;
	let holdNextRead = false;
	let failNextRead = false;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] !== "otta_console_act") {
			if (failNextRead) {
				failNextRead = false;
				return Promise.resolve(
					json({ ok: false, title: "Products are unavailable", description: "Try again." }),
				);
			}
			if (holdNextRead) {
				holdNextRead = false;
				const snapshot = onHand;
				return new Promise<Response>((resolve) => {
					heldRead = () => {
						resolve(detail({ onHand: snapshot }));
					};
				});
			}
			return Promise.resolve(detail({ onHand }));
		}
		const actionId = String(body["action_id"]);
		const value = body["value"] as Record<string, string>;
		return new Promise<Response>((resolve) => {
			pendingWrites.set(actionId, () => {
				if (actionId === "products:restock") onHand += Number(value["qty"]);
				resolve(
					json({
						ok: true,
						notice: {
							variant: "default",
							title: actionId === "products:save" ? "Saved" : "Stock added",
							description: "",
						},
					}),
				);
			});
		});
	});
	return {
		holdNextRead: () => {
			holdNextRead = true;
		},
		failNextRead: () => {
			failNextRead = true;
		},
		/** Resolve a pending write inside the current act, letting its answer run. */
		releaseWrite: async (actionId: string) => {
			pendingWrites.get(actionId)?.();
			pendingWrites.delete(actionId);
			for (let i = 0; i < 10; i++) await Promise.resolve();
		},
		releaseHeldRead: () => {
			heldRead?.();
			heldRead = null;
		},
	};
}

/** Edit the price, start an Add of 5 (in flight), then press Save (in flight). */
async function addThenSave(c: HTMLElement): Promise<void> {
	await type(input(c, "Price"), "30");
	await type(input(c, "Add or remove stock"), "5");
	await fire(button(c, "Add"), "click");
	await flush();
	await fire(button(c, "Save pricing & stock"), "click");
	await flush();
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

test("a Save's re-read that OVERTAKES the Add's own re-read still prints the Add's receipt, once, and releases the buttons", async () => {
	const server = manualServer(24);
	const c = await mountPanel();
	await addThenSave(c);
	server.holdNextRead(); // the Add's own re-read will hang
	await React.act(async () => {
		await server.releaseWrite("products:restock");
	});
	await flush();
	expect(button(c, "Add").disabled).toBe(true); // waiting for a re-read
	await React.act(async () => {
		await server.releaseWrite("products:save"); // a newer re-read, which includes the Add
	});
	await flush();
	expect(c.textContent).toContain("Added 5 — now 29 in stock");
	expect(button(c, "Add").disabled).toBe(false);
	expect(button(c, "Remove").disabled).toBe(false);
	// The overtaken read landing late changes nothing.
	await React.act(async () => {
		server.releaseHeldRead();
	});
	await flush();
	expect(occurrences(c.textContent ?? "", "Added 5 — now")).toBe(1);
	expect(c.textContent).toContain("Added 5 — now 29 in stock");
});

test("an Add's and a Save's re-reads asked for in ONE batch still print the receipt and release the buttons", async () => {
	const server = manualServer(24);
	const c = await mountPanel();
	await addThenSave(c);
	await React.act(async () => {
		await server.releaseWrite("products:restock");
		await server.releaseWrite("products:save");
	});
	await flush();
	expect(c.textContent).toContain("Added 5 — now 29 in stock");
	expect(button(c, "Add").disabled).toBe(false);
});

test("a NEWER re-read that fails releases the stock buttons, and Try again brings them back usable", async () => {
	const server = manualServer(24);
	const c = await mountPanel();
	await addThenSave(c);
	server.holdNextRead(); // the Add's own re-read hangs
	await React.act(async () => {
		await server.releaseWrite("products:restock");
	});
	await flush();
	server.failNextRead(); // the Save's newer re-read fails
	await React.act(async () => {
		await server.releaseWrite("products:save");
	});
	await flush();
	expect(c.textContent).toContain("Products are unavailable");
	await fire(button(c, "Try again"), "click");
	await flush();
	expect(onHandShown(c)).toBe("29");
	expect(button(c, "Add").disabled).toBe(false);
	expect(button(c, "Remove").disabled).toBe(false);
});

test("a remove confirm on a count that can no longer be read says so, never 'changed to 0'", async () => {
	let onHand: number | null = 24;
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			onHand = null; // the inventory record is gone by the re-read
			return Promise.resolve(json({ ok: true, notice: null }));
		}
		return Promise.resolve(detail({ onHand }));
	});
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "2");
	await fire(button(c, "Remove"), "click");
	await pressEnterInQty(c);
	expect(confirmOpen(c)).toBe(false);
	expect(c.textContent).toContain(
		"Stock could not be read — nothing was removed; check and try again.",
	);
	expect(c.textContent).not.toContain("changed to 0");
});
