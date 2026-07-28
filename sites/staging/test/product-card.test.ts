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
		props: { href: "/products/urumi-mug", title: "Urumi Mug", slug: "urumi-mug", ...props },
	});

describe("ProductCard — the shape of a card", () => {
	test("the whole card is one link: media, title and price share a target", async () => {
		const html = await card({});
		expect(html).toMatch(/^<a [^>]*href="\/products\/urumi-mug"/);
		expect(html).toContain("Urumi Mug");
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

describe("ProductCard — the coil's tint follows the grid position", () => {
	test("the index reaches MediaPanel", async () => {
		const tint = async (index: number): Promise<string | undefined> =>
			/--coil-tint: var\((--u-tint-\w+)\)/.exec(await card({ index }))?.[1];
		expect(new Set([await tint(0), await tint(1), await tint(2)]).size).toBe(3);
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
