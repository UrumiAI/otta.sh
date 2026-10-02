/**
 * ProductCard, and the two components it composes — PriceTag and StockRule
 * (docs/theme/TEMPERED.md §4, §7).
 *
 * The money rule is the one worth breaking a build over: a card is handed a
 * PRE-FORMATTED string or nothing at all, and when it has nothing it says so in
 * prose. There is no code path here that can produce a figure the store did not
 * quote.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import PriceTag from "../src/components/PriceTag.astro";
import ProductCard from "../src/components/ProductCard.astro";
import StockRule from "../src/components/StockRule.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

const card = (props: Record<string, unknown>): Promise<string> =>
	container.renderToString(ProductCard, {
		props: { href: "/products/otta-mug", title: "Otta Mug", slug: "otta-mug", ...props },
	});

describe("ProductCard — the shape of a card", () => {
	test("the whole card is one link: media, title and price share a target", async () => {
		const html = await card({});
		expect(html).toMatch(/^<a [^>]*href="\/products\/otta-mug"/);
		expect(html).toContain("Otta Mug");
		expect(html).toContain("<svg");
	});

	test("renders the description when there is one, and nothing when there is not", async () => {
		expect(await card({ description: "Holds exactly one coffee." })).toContain(
			"Holds exactly one coffee.",
		);
		const bare = await card({ description: null });
		expect(bare).not.toContain("card-desc");
	});

	test("an empty description string is not a paragraph either", async () => {
		expect(await card({ description: "" })).not.toContain("card-desc");
	});

	test("a product with a photograph shows the photograph, not the coil", async () => {
		const html = await card({ image: "/media/mug.jpg" });
		expect(html).toContain('src="/media/mug.jpg"');
		expect(html).not.toContain("<svg");
	});
});

describe("ProductCard — the heading level is the page's to choose", () => {
	test("defaults to h2", async () => {
		expect(await card({})).toMatch(/<h2[^>]*class="card-title"/);
	});

	test("drops to h3 under a section that already has an h2", async () => {
		// A hard-coded h2 skips a level anywhere the card is not directly under
		// the page's h1, and heading order is how a screen reader navigates.
		expect(await card({ level: "h3" })).toMatch(/<h3[^>]*class="card-title"/);
	});
});

describe("ProductCard — money (§7)", () => {
	test("prints the view model's formatted price verbatim", async () => {
		expect(await card({ price: "$15.00", availability: "in_stock" })).toContain("$15.00");
	});

	test("an unpriced product says so in prose — never a zero, never a dash alone", async () => {
		const html = await card({ price: null, availability: null });
		expect(html).toContain("Not currently available for purchase");
		expect(html).not.toContain("0.00");
		expect(html).not.toMatch(/>\s*—\s*</);
	});

	test("the fallback prose is the page's to choose", async () => {
		expect(await card({ price: null, priceNote: "Prices are unavailable right now" })).toContain(
			"Prices are unavailable right now",
		);
	});

	test("sold out strikes the price rather than hiding it", async () => {
		const html = await card({ price: "$12.00", availability: "out_of_stock" });
		expect(html).toContain("$12.00");
		expect(html).toContain("data-sold-out");
	});

	test("sold out DIMS THE ART, and does it through MediaPanel's own class", async () => {
		// The regression this exists for: the dimming used to be a parent rule,
		// `.card[cid-parent] .card-media[cid-parent]`, which can never match
		// MediaPanel's root — that element carries MediaPanel's hash. The rule
		// shipped and did nothing, and the sold-out coil rendered at full weight.
		const html = await card({ price: "$12.00", availability: "out_of_stock" });
		expect(html).toContain("dimmed");
	});

	test("an in-stock card dims nothing", async () => {
		expect(await card({ price: "$12.00", availability: "in_stock" })).not.toContain("dimmed");
	});

	test("in stock does NOT mark the card sold out", async () => {
		expect(await card({ price: "$12.00", availability: "in_stock" })).not.toContain(
			"data-sold-out",
		);
	});
});

describe("PriceTag — a figure, and only ever a figure it was handed", () => {
	const price = (props: Record<string, unknown>): Promise<string> =>
		container.renderToString(PriceTag, { props });

	test("prints its `formatted` string", async () => {
		expect(await price({ formatted: "$25.00" })).toContain("$25.00");
	});

	test("carries the sold-out marker only when sold out", async () => {
		expect(await price({ formatted: "$25.00", soldOut: true })).toContain("data-sold-out");
		expect(await price({ formatted: "$25.00" })).not.toContain("data-sold-out");
	});

	test("a non-dollar currency passes through untouched", async () => {
		// The component knows nothing about currency; whatever the view model
		// formatted is what shows.
		expect(await price({ formatted: "₹1,250.00" })).toContain("₹1,250.00");
		expect(await price({ formatted: "12,00 €" })).toContain("12,00 €");
	});

	test("takes three sizes and nothing else decides its weight", async () => {
		for (const size of ["sm", "md", "lg"] as const) {
			expect(await price({ formatted: "$1.00", size })).toContain(`size-${size}`);
		}
	});
});

describe("PriceTag — the compare-at (was) price", () => {
	const price = (props: Record<string, unknown>): Promise<string> =>
		container.renderToString(PriceTag, { props });

	test("a was-price is struck BESIDE the price, both handed in pre-formatted", async () => {
		const html = await price({ formatted: "$12.00", was: "$20.00" });
		expect(html).toMatch(/<s [^>]*class="[^"]*\bwas\b[^"]*"[^>]*>[\s\S]*\$20\.00[\s\S]*<\/s>/);
		expect(html).toContain("$12.00");
		// Was first, then now — the conventional reading order.
		expect(html.indexOf("$20.00")).toBeLessThan(html.indexOf("$12.00"));
	});

	test("a screen reader hears which figure is which — a strike is not announced", async () => {
		const html = await price({ formatted: "$12.00", was: "$20.00" });
		expect(html).toMatch(/<span class="u-sr-only"[^>]*>Was <\/span>\s*\$20\.00/);
		expect(html).toMatch(/<span class="u-sr-only"[^>]*>Now <\/span>\s*\$12\.00/);
	});

	test("no was-price ⇒ the same single figure as ever, with no Was/Now words", async () => {
		for (const was of [undefined, null, ""]) {
			const html = await price({ formatted: "$12.00", was });
			expect(html).not.toContain("<s ");
			expect(html).not.toContain("Now ");
		}
	});

	test("sold out wins over on sale: ONE struck figure, never two", async () => {
		// Sold out already strikes the price. Striking the was-price beside it
		// would put two crossed-out figures side by side and say nothing either
		// one does not; the sale is moot while nothing can be bought.
		const html = await price({ formatted: "$12.00", was: "$20.00", soldOut: true });
		expect(html).toContain("data-sold-out");
		expect(html).toContain("$12.00");
		expect(html).not.toContain("$20.00");
		expect(html).not.toContain("<s ");
		expect(html).not.toContain("Was ");
	});
});

describe("ProductCard — a product on sale", () => {
	test("the card's foot shows the struck was-price beside the price", async () => {
		const html = await card({ price: "$12.00", was: "$20.00", availability: "in_stock" });
		expect(html).toMatch(/<s [^>]*>[\s\S]*\$20\.00/);
		expect(html).toContain("$12.00");
	});

	test("a sold-out card on sale shows its one struck price, not two", async () => {
		const html = await card({ price: "$12.00", was: "$20.00", availability: "out_of_stock" });
		expect(html).toContain("$12.00");
		expect(html).not.toContain("$20.00");
	});

	test("no price ⇒ no was-price either: a sale needs a figure to be a sale of", async () => {
		const html = await card({ price: null, was: "$20.00" });
		expect(html).not.toContain("$20.00");
	});
});

describe("StockRule — a rule, not a coloured badge (§4)", () => {
	const stock = (props: Record<string, unknown>): Promise<string> =>
		container.renderToString(StockRule, { props });

	test("in stock is the solid state", async () => {
		const html = await stock({ availability: "in_stock" });
		expect(html).toContain('data-state="in"');
		expect(html).toContain("In stock");
	});

	test("out of stock is the dashed state", async () => {
		const html = await stock({ availability: "out_of_stock" });
		expect(html).toContain('data-state="out"');
		expect(html).toContain("Sold out");
	});

	test("a product with no stock fact renders nothing at all", async () => {
		// `availability: null` means "not purchasable" — there is no stock
		// statement to make, and inventing "Sold out" would be one.
		expect((await stock({ availability: null })).trim()).toBe("");
	});

	test("the wording is overridable for a store that shows counts", async () => {
		expect(await stock({ availability: "in_stock", label: "3 left" })).toContain("3 left");
	});

	test("spends no tempering colour — those belong to states a shopper waits on", async () => {
		for (const availability of ["in_stock", "out_of_stock"]) {
			const html = await stock({ availability });
			expect(html).not.toContain("--u-violet");
			expect(html).not.toContain("--u-bronze");
		}
	});
});
