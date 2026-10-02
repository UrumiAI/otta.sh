/**
 * Tempered's product page, RENDERED — the spec ledger's price on a sale.
 *
 * The page (`pages/products/[slug].astro`) decides `compareAtFormatted`; this
 * pins what the view draws with it, by rendering the view rather than by
 * matching its source: the was-price struck beside the price, named for a
 * screen reader, and dropped when the product is sold out (one struck figure,
 * never two).
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import type { ProductContentModel, ProductPurchase } from "../src/themes/contract.js";
import ProductView from "../src/themes/tempered/ProductView.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

function purchase(overrides: Partial<ProductPurchase> = {}): ProductPurchase {
	return {
		priceFormatted: "$12.00",
		compareAtFormatted: null,
		priceStruck: false,
		availability: "in_stock",
		sku: "OTTA-TEE",
		addToCart: {
			sku: "OTTA-TEE",
			productId: "p1",
			idempotencyKey: "k1",
			returnTo: "/products/otta-tee",
		},
		cartHoldMinutes: 15,
		holdNote: "Held for 15 minutes.",
		soldOut: false,
		...overrides,
	};
}

const render = (purchaseModel: ProductPurchase): Promise<string> => {
	const model: ProductContentModel = {
		state: "ok",
		title: "Otta Tee",
		description: null,
		art: "otta-tee",
		image: null,
		dimmed: purchaseModel.soldOut,
		degradedLead: null,
		errorMessage: null,
		errorAction: null,
		purchase: purchaseModel,
		showNotForSale: false,
	};
	return container.renderToString(ProductView, { props: { model } });
};

/** The spec ledger's Price row, from its label to the next row. */
function priceRow(html: string): string {
	const start = html.indexOf(">Price<");
	return html.slice(start, html.indexOf(">Stock<", start));
}

describe("the product page's spec ledger on a sale", () => {
	test("strikes the was-price beside the price, and names both for a screen reader", async () => {
		const row = priceRow(await render(purchase({ compareAtFormatted: "$20.00" })));
		expect(row).toMatch(/<s [^>]*>[\s\S]*Was [\s\S]*\$20\.00[\s\S]*<\/s>/);
		expect(row).toMatch(/Now [\s\S]*\$12\.00/);
	});

	test("no sale ⇒ the single price, no Was/Now", async () => {
		const row = priceRow(await render(purchase()));
		expect(row).toContain("$12.00");
		expect(row).not.toContain("<s ");
		expect(row).not.toContain("Was ");
	});

	test("sold out on sale ⇒ one struck price, the was-price dropped", async () => {
		const row = priceRow(
			await render(
				purchase({
					compareAtFormatted: "$20.00",
					priceStruck: true,
					availability: "out_of_stock",
					addToCart: null,
					soldOut: true,
				}),
			),
		);
		expect(row).toContain("data-sold-out");
		expect(row).not.toContain("$20.00");
	});
});
