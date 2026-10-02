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
	await fire(button(c, "+ Add"), "click");
	await flush();
	expect(writes()).toEqual([
		{
			type: "otta_console_act",
			action_id: "products:restock",
			value: { productId: "p_tee", onHand: "24", qty: "5" },
		},
	]);
	expect(c.textContent).toContain("Added 5 — now 29 in stock");
});

test("Remove asks first, and never offers to take more than there is", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail({ onHand: 3 })));
	const c = await mountPanel();
	await type(input(c, "Add or remove stock"), "5");
	await fire(button(c, "− Remove"), "click");
	expect(c.textContent).toContain("You only have 3 in stock");
	expect(writes()).toEqual([]);

	await type(input(c, "Add or remove stock"), "2");
	await fire(button(c, "− Remove"), "click");
	const dialog = c.querySelector('[data-testid="otta-confirm"]');
	expect(dialog?.textContent).toContain("Remove 2 from stock?");
	expect(dialog?.textContent).toContain("You'll have 1 left.");
	expect(writes()).toEqual([]);
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
