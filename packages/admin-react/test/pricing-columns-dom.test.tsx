/**
 * @vitest-environment happy-dom
 *
 * The Products list's Price and Stock columns, mounted (ADR-0014, amendment
 * 2026-10-01): one read per page shared by every cell, and each cell's words.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { PriceCell, StockCell, PRICING_COLUMNS, forgetSummaries } =
	await import("../src/products/pricing-columns.js");

const ROWS = [
	{
		productId: "tee",
		sku: "TEE",
		priceCents: 3200,
		currency: "USD",
		compareAtCents: 4000,
		onHand: 24,
		deletedAt: null,
	},
	{
		productId: "mug",
		sku: "MUG",
		priceCents: 1800,
		currency: "USD",
		compareAtCents: null,
		onHand: 3,
		deletedAt: null,
	},
	{
		productId: "pack",
		sku: "PACK",
		priceCents: 600,
		currency: "USD",
		compareAtCents: null,
		onHand: 0,
		deletedAt: null,
	},
	{
		productId: "tote",
		sku: null,
		priceCents: null,
		currency: null,
		compareAtCents: null,
		onHand: null,
		deletedAt: null,
	},
];
const PAGE = ["tee", "mug", "pack", "tote", "draft"].map((id) => ({
	id,
	updatedAt: "2026-10-01T00:00:00Z",
}));

let mounted: Mounted | null = null;

beforeEach(() => {
	forgetSummaries();
	apiFetch.mockReset();
	apiFetch.mockImplementation(() =>
		Promise.resolve(
			new Response(JSON.stringify({ data: { ok: true, products: ROWS, threshold: 5 } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		),
	);
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

function Table(): React.ReactElement {
	return (
		<table>
			<tbody>
				{PAGE.map((item) => (
					<tr key={item.id} data-row={item.id}>
						<td data-col="price">
							<PriceCell collection="products" item={item} visibleItems={PAGE} />
						</td>
						<td data-col="stock">
							<StockCell collection="products" item={item} visibleItems={PAGE} />
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

async function render(): Promise<HTMLElement> {
	mounted = await mount(<Table />);
	for (let i = 0; i < 3; i++) await mounted.rerender(<Table />);
	return mounted.container;
}

function cell(c: HTMLElement, row: string, col: string): string {
	return c.querySelector(`[data-row="${row}"] [data-col="${col}"]`)?.textContent ?? "";
}

test("declares Price and Stock on the products collection, to admins only", () => {
	expect(PRICING_COLUMNS.map((col) => [col.id, col.label, col.collections, col.minRole])).toEqual([
		["price", "Price", ["products"], 50],
		["stock", "Stock", ["products"], 50],
	]);
});

test("ten cells on the page make ONE request, for the page's ids", async () => {
	await render();
	expect(apiFetch).toHaveBeenCalledTimes(1);
	expect(JSON.parse(String(apiFetch.mock.calls[0]?.[1]?.body))).toEqual({
		type: "otta_console_read",
		resource: "products.summaries",
		productIds: ["tee", "mug", "pack", "tote", "draft"],
	});
});

test("price shows the amount, and a sale's old price struck through", async () => {
	const c = await render();
	expect(cell(c, "tee", "price")).toBe("$32.00$40.00");
	expect(c.querySelector('[data-row="tee"] s')?.textContent).toBe("$40.00");
	expect(cell(c, "mug", "price")).toBe("$18.00");
	expect(cell(c, "tote", "price")).toBe("Not priced");
	// A CMS draft with no commerce row yet.
	expect(cell(c, "draft", "price")).toBe("Not priced");
});

test("stock reads as a shop owner would say it", async () => {
	const c = await render();
	expect(cell(c, "tee", "stock")).toBe("24 in stock");
	expect(cell(c, "mug", "stock")).toBe("3 in stock · low");
	expect(cell(c, "pack", "stock")).toBe("Out of stock");
	expect(cell(c, "tote", "stock")).toBe("No SKU yet");
});

test("a failed read shows a dash, not a wrong number, and is retried next time", async () => {
	apiFetch.mockImplementation(() =>
		Promise.resolve(
			new Response(
				JSON.stringify({ data: { ok: false, title: "Products are unavailable", description: "" } }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		),
	);
	const c = await render();
	expect(cell(c, "tee", "price")).toBe("—");
	expect(c.querySelector('[data-row="tee"] [title]')?.getAttribute("title")).toBe(
		"Products are unavailable",
	);
});
