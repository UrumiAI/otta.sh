/**
 * @vitest-environment happy-dom
 *
 * The product editor's Pricing & stock panel, mounted (ADR-0014, amendment
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

const { PricingStockPanel, PRICING_PANEL } = await import("../src/products/pricing-panel.js");
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
let entryUpdatedAt = "2026-09-30T09:59:00.000Z";

async function flush(): Promise<void> {
	// Reads arrive through promise chains a single `act` does not outlive.
	for (let i = 0; i < 4; i++) {
		await mounted?.rerender(panel());
	}
}

function panel(): React.ReactElement {
	return (
		<PricingStockPanel collection="products" entry={{ id: "p_tee", updatedAt: entryUpdatedAt }} />
	);
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
	entryUpdatedAt = "2026-09-30T09:59:00.000Z";
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

test("declares itself for the products collection, to admins only", () => {
	expect(PRICING_PANEL).toMatchObject({
		id: "pricing-stock",
		title: "Pricing & stock",
		collections: ["products"],
		minRole: 50,
	});
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
	expect(button(c, "Save").disabled).toBe(true);
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
	expect(c.textContent).toContain("Not saved yet");
	await fire(button(c, "Save"), "click");
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
	expect(sent().filter((b) => b["resource"] === "products.detail")).toHaveLength(2);
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
			detail(reads > 1 ? { priceCents: 3500, updatedAt: "2026-09-30T12:00:00.000Z" } : {}),
		);
	});
	const c = await mountPanel();
	await type(input(c, "Price"), "29");
	await fire(button(c, "Save"), "click");
	await flush();
	expect(input(c, "Price").value).toBe("35.00");
	expect(c.textContent).toContain("This product changed since you opened it");
});

test("a wrong amount is said in plain words and nothing is sent", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	const c = await mountPanel();
	await type(input(c, "Price"), "29,99");
	expect(c.textContent).toContain("Enter a price like 24.99");
	await fire(button(c, "Save"), "click");
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
	await fire(button(c, "Save"), "click");
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
	await fire(button(c, "Save"), "click");
	await flush();
	expect(writes()[0]?.["value"]).toMatchObject({ price: "18.00", currency: "EUR" });
});

test("after a CMS save, the panel's next save carries the NEW watermark and keeps only the merchant's edits", async () => {
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
	// The CMS save landed a newer row: a new watermark, and another admin's new
	// weight the merchant never touched.
	apiFetch.mockImplementation((_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Promise.resolve(
			body["type"] === "otta_console_act"
				? json({ ok: true, notice: { variant: "default", title: "Saved", description: "" } })
				: detail({ weightGrams: 450, updatedAt: "2026-09-30T11:00:00.000Z" }),
		);
	});
	entryUpdatedAt = "2026-09-30T11:00:00.000Z";
	await flush();
	await fire(button(c, "Save"), "click");
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
	await fire(button(c, "Save"), "click");
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

test("a CMS save re-reads the record but keeps what the merchant typed", async () => {
	apiFetch.mockImplementation(() => Promise.resolve(detail()));
	const c = await mountPanel();
	await type(input(c, "Price"), "30");
	apiFetch.mockImplementation(() =>
		Promise.resolve(detail({ updatedAt: "2026-09-30T11:00:00.000Z" })),
	);
	entryUpdatedAt = "2026-09-30T11:00:00.000Z";
	await flush();
	expect(sent().filter((b) => b["resource"] === "products.detail")).toHaveLength(2);
	expect(input(c, "Price").value).toBe("30");
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
