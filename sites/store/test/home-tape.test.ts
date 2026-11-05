/**
 * Tempered's home tape, RENDERED (docs/theme/TEMPERED.md §8).
 *
 * `tape.test.ts` pins what a row says; this pins what the shopper gets from
 * it. QA found the tape's ITEM column reading OTTA-STICKERS / OTTA-MUG /
 * OTTA-TEE with nothing to click: a shelf on the front door that named its
 * products by stock code and led nowhere. Each row is now the product's name,
 * linked to its page, with the sku kept beneath as the reference.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import type { TapeRow } from "../src/lib/tape.js";
import type { HomeModel } from "../src/themes/contract.js";
import HomeView from "../src/themes/tempered/HomeView.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

const row = (overrides: Partial<TapeRow> = {}): TapeRow => ({
	title: "Otta Mug",
	sku: "OTTA-MUG",
	href: "/products/otta-mug",
	price: "$18.00",
	was: null,
	stock: "In stock",
	soldOut: false,
	...overrides,
});

const home = (rows: TapeRow[]): Promise<string> => {
	const model: HomeModel = {
		thesis: "Otta",
		lede: "Everything in the shop.",
		shopHref: "/products",
		shopLabel: "Shop",
		rows,
		count: rows.length,
		cards: [],
		notice: null,
	};
	return container.renderToString(HomeView, { props: { model } });
};

describe("the home tape — names that lead somewhere", () => {
	test("each row's item cell is a link to the product, named by its title", async () => {
		const html = await home([row()]);
		expect(html).toMatch(/<a [^>]*href="\/products\/otta-mug"[^>]*>[\s\S]*Otta Mug[\s\S]*<\/a>/);
	});

	test("the sku stays, beneath the name, as the reference — never as the name", async () => {
		const html = await home([row()]);
		expect(html).toContain("OTTA-MUG");
		expect(html.indexOf("Otta Mug")).toBeLessThan(html.indexOf("OTTA-MUG"));
	});

	test("a row with no sku keeps its name and opens no empty reference line", async () => {
		const html = await home([row({ sku: null })]);
		expect(html).toContain("Otta Mug");
		expect(html).not.toContain("home-sku");
	});

	test("a row on sale strikes its was-price beside the price, as the cards do", async () => {
		const html = await home([row({ price: "$12.00", was: "$20.00" })]);
		expect(html).toMatch(/<s [^>]*>[\s\S]*\$20\.00[\s\S]*<\/s>/);
		expect(html).toContain("$12.00");
	});

	test("the item cell keeps its table role, so the link sits INSIDE the cell", async () => {
		const html = await home([row()]);
		expect(html).toMatch(/role="cell"[^>]*>\s*<a /);
	});
});
