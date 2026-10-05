/**
 * Sum and Ledger — the money block on screen (docs/theme/TEMPERED.md §7).
 *
 * This is the most scrutinised surface in the theme, so the assertions are
 * about what CANNOT appear as much as what does: a store that never configured
 * shipping must not see "$0.00", must not see "Free", and must not see a bare
 * em dash standing in for an explanation. The plugin's view model already
 * refuses to turn a synthetic zero into money; these tests hold the rendering
 * half of that contract.
 */
import {
	NOT_APPLICABLE_LABEL,
	NOT_CALCULATED_LABEL,
	type CheckoutAmountView,
} from "@otta-sh/plugin";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import Ledger from "../src/components/Ledger.astro";
import { UNAVAILABLE_LABEL } from "../src/lib/cart-view.js";
import { NOT_APPLIED_LABEL, sumRowText } from "../src/lib/totals.js";
import Sum from "../src/components/Sum.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

const money = (formatted: string): CheckoutAmountView => ({
	money: { amount: 4000, currency: "USD", formatted },
	label: formatted,
});
const uncomputed = (label: string): CheckoutAmountView => ({ money: null, label });

/** The text of every "this was not calculated" cell in a rendered block. */
function uncalculatedCells(html: string): string[] {
	return [...html.matchAll(/<span class="[^"]*\buncalc\b[^"]*"[^>]*>([^<]*)<\/span>/g)].map(
		(m) => m[1] ?? "",
	);
}

const sum = (props: Record<string, unknown>): Promise<string> =>
	container.renderToString(Sum, { props });

/** The totals a store with nothing configured actually gets. */
const UNCONFIGURED = {
	rows: [
		{ label: "Subtotal", amount: money("$40.00") },
		{ label: "Discount", amount: uncomputed(NOT_APPLICABLE_LABEL), fallback: "No coupon applied" },
		{ label: "Shipping", amount: uncomputed(NOT_CALCULATED_LABEL) },
		{ label: "Tax", amount: uncomputed(NOT_CALCULATED_LABEL) },
	],
	total: money("$40.00"),
	excludesUncalculated: true,
};

describe("Sum — 'Not calculated' is not zero (§7)", () => {
	test("an uncalculated row reads as prose, and never as a figure", async () => {
		const html = await sum(UNCONFIGURED);
		expect(html).toContain("Not calculated");
		const cells = uncalculatedCells(html);
		expect(cells).toHaveLength(3); // discount, shipping, tax
		// Not "no zero anywhere" — the subtotal is legitimately $40.00. The rule
		// is that a cell which was never calculated contains no figure at all.
		for (const cell of cells) expect(cell).not.toMatch(/\d/);
	});

	test("nowhere does it say 'Free'", async () => {
		expect((await sum(UNCONFIGURED)).toLowerCase()).not.toContain("free");
	});

	test("a row with NO fallback still never prints a lone em dash", async () => {
		// The regression. `fallback` is optional, and every test in this suite
		// used to supply one — so the default path, which the discount row takes
		// on every ordinary order, printed exactly the dash §7 forbids.
		const html = await sum({
			rows: [
				{ label: "Subtotal", amount: money("$40.00") },
				{ label: "Discount", amount: uncomputed(NOT_APPLICABLE_LABEL) },
			],
			total: money("$40.00"),
		});
		expect(html).not.toMatch(/>\s*—\s*</);
		expect(html).toContain(NOT_APPLIED_LABEL);
	});

	test("no bare em dash stands in for an explanation", async () => {
		// The view model's NOT_APPLICABLE_LABEL is "—". On its own it is
		// indistinguishable from an outage; the row's own prose replaces it.
		const html = await sum(UNCONFIGURED);
		expect(html).toContain("No coupon applied");
		expect(html).not.toMatch(/>\s*—\s*</);
	});

	test("uncalculated rows are set differently from figures, not just worded differently", async () => {
		const html = await sum(UNCONFIGURED);
		expect(html).toContain("uncalc");
		// The computed rows go through PriceTag; the uncomputed ones must not.
		expect(html.match(/class="[^"]*price/g) ?? []).toHaveLength(2); // subtotal + total
	});

	test("a genuine zero IS money and renders as money", async () => {
		// A store that really did calculate free shipping has a right to say so.
		const html = await sum({
			rows: [{ label: "Shipping", amount: money("$0.00") }],
			total: money("$40.00"),
		});
		expect(html).toContain("$0.00");
		expect(html).not.toContain("uncalc");
	});
});

describe("Sum — the footnote NAMES what is missing (§7)", () => {
	test("names both uncalculated components", async () => {
		const html = await sum(UNCONFIGURED);
		expect(html).toContain("shipping");
		expect(html).toContain("tax");
		expect(html).toMatch(/doesn(&#39;|.)t include/);
	});

	test("no footnote when the view model says the total is complete", async () => {
		const html = await sum({ ...UNCONFIGURED, excludesUncalculated: false });
		expect(html).not.toMatch(/doesn(&#39;|.)t include/);
	});

	test("a page can override the footnote with something more specific", async () => {
		expect(await sum({ ...UNCONFIGURED, footnote: "Delivery is quoted by email." })).toContain(
			"Delivery is quoted by email.",
		);
	});

	test("an explicit null footnote suppresses it", async () => {
		const html = await sum({ ...UNCONFIGURED, footnote: null });
		expect(html).not.toMatch(/doesn(&#39;|.)t include/);
	});
});

describe("Sum — the total line", () => {
	test('says "Total" while it is a quote', async () => {
		expect(await sum(UNCONFIGURED)).toContain("Total");
	});

	test('says "Paid" once the order has settled', async () => {
		const html = await sum({ ...UNCONFIGURED, totalLabel: "Paid" });
		expect(html).toContain("Paid");
	});

	test("a total that could not be calculated is prose too, not a zero", async () => {
		const html = await sum({
			rows: [{ label: "Subtotal", amount: uncomputed(NOT_CALCULATED_LABEL) }],
			total: uncomputed(NOT_CALCULATED_LABEL),
		});
		expect(html).not.toContain("0.00");
		expect(html).toContain("Not calculated");
	});
});

describe("Ledger — SKU, quantity, money", () => {
	const ledger = (props: Record<string, unknown>): Promise<string> =>
		container.renderToString(Ledger, { props });

	test("renders one line per row, in the order given", async () => {
		const html = await ledger({
			rows: [
				{ sku: "OTTA-TEE-01", qty: 1, money: "$25.00" },
				{ sku: "OTTA-MUG-01", qty: 2, money: "$30.00" },
			],
		});
		expect(html.indexOf("OTTA-TEE-01")).toBeLessThan(html.indexOf("OTTA-MUG-01"));
		expect(html).toContain("$25.00");
		expect(html).toContain("$30.00");
	});

	test("the quantity is announced as one — a bare figure is ambiguous", async () => {
		const html = await ledger({ rows: [{ sku: "OTTA-TEE-01", qty: 3, money: "$75.00" }] });
		expect(html).toContain("u-sr-only");
		expect(html).toContain("Quantity");
	});

	test("both figures are named — position is all that distinguishes them visually", async () => {
		const html = await ledger({ rows: [{ sku: "OTTA-TEE-01", qty: 3, money: "$75.00" }] });
		expect(html).toContain("Quantity");
		expect(html).toContain("Line total");
		expect(html.match(/u-sr-only/g) ?? []).toHaveLength(2);
	});

	test("a line the store cannot price says so, and is set as prose", async () => {
		const html = await ledger({
			rows: [{ sku: "OTTA-TEE-01", qty: 1, money: "priced at checkout", unpriced: true }],
		});
		expect(html).toContain("priced at checkout");
		expect(html).toContain("unpriced");
		expect(html).not.toContain("0.00");
	});

	test("an empty ledger renders an empty block, not a broken one", async () => {
		const html = await ledger({ rows: [] });
		expect(html).toContain("ledger");
		expect(html).not.toContain("line");
	});
});

describe("Ledger — the receipt names what was bought (title)", () => {
	const ledger = (props: Record<string, unknown>): Promise<string> =>
		container.renderToString(Ledger, { props });

	test("a row WITH a title leads with it, and keeps the SKU as the reference", async () => {
		// CLAUDE.md's "orders snapshot price + title at purchase time" is what
		// makes a confirmation page a receipt rather than a list of part numbers.
		const html = await ledger({
			rows: [{ title: "Otta Tee", sku: "OTTA-TEE-01", qty: 1, money: "$25.00" }],
		});
		expect(html).toContain("Otta Tee");
		expect(html).toContain("OTTA-TEE-01");
		// The name comes first in the reading order, not just visually.
		expect(html.indexOf("Otta Tee")).toBeLessThan(html.indexOf("OTTA-TEE-01"));
	});

	test("a row WITHOUT one is unchanged — a line the store cannot name shows its SKU alone", async () => {
		const html = await ledger({ rows: [{ sku: "OTTA-TEE-01", qty: 1, money: "$25.00" }] });
		expect(html).toContain("OTTA-TEE-01");
		expect(html).not.toContain('class="title"');
	});

	test("a blank title is the same as none — it must not open an empty line", async () => {
		const html = await ledger({
			rows: [{ title: "", sku: "OTTA-TEE-01", qty: 1, money: "$25.00" }],
		});
		expect(html).not.toContain('class="title"');
	});
});

describe("Ledger — a bare em dash never reaches the money column either (§7)", () => {
	const ledger = (props: Record<string, unknown>): Promise<string> =>
		container.renderToString(Ledger, { props });

	test("a row with NO fallback still never prints a lone em dash", async () => {
		// The same regression as the totals block's discount row, one component
		// over. `cart-view.ts` exports `UNAVAILABLE_LABEL = "—"` for a cart whose
		// pricing lookup failed, so increment 4's wired cart hands this component
		// exactly that string per row — and it used to print `row.money`
		// verbatim.
		const html = await ledger({
			rows: [{ sku: "OTTA-TEE-01", qty: 1, money: UNAVAILABLE_LABEL }],
		});
		expect(html).not.toMatch(/>\s*—\s*</);
		expect(html).toContain(NOT_APPLIED_LABEL);
	});

	test("it is the SAME substitution the totals block applies, not a second one", async () => {
		// One rule in one place. A second implementation is a second thing to
		// forget.
		const html = await ledger({ rows: [{ sku: "X", qty: 1, money: UNAVAILABLE_LABEL }] });
		expect(html).toContain(
			sumRowText({ label: "Discount", amount: uncomputed(NOT_APPLICABLE_LABEL) }),
		);
	});

	test("a page with something better to say says it instead", async () => {
		const html = await ledger({
			rows: [{ sku: "X", qty: 1, money: UNAVAILABLE_LABEL, fallback: "Unavailable right now" }],
		});
		expect(html).toContain("Unavailable right now");
		expect(html).not.toMatch(/>\s*—\s*</);
	});

	test("a blank cell is prose too, not an empty column", async () => {
		for (const cell of ["", "   ", "-", "–"]) {
			const html = await ledger({ rows: [{ sku: "X", qty: 1, money: cell }] });
			expect(html, `money: ${JSON.stringify(cell)}`).toContain(NOT_APPLIED_LABEL);
		}
	});

	test("prose is SET as prose even when the caller forgot the flag", async () => {
		// `unpriced` is optional, and an omitted optional prop is how the dash
		// shipped in the first place — so the value decides. A money string
		// carries a digit; nothing this theme prints as prose does.
		const html = await ledger({ rows: [{ sku: "X", qty: 1, money: "priced at checkout" }] });
		expect(html).toContain("unpriced");
	});

	test("and real money is never dimmed as prose by accident", async () => {
		const html = await ledger({ rows: [{ sku: "X", qty: 1, money: "$25.00" }] });
		expect(html).toContain("$25.00");
		expect(html).not.toContain("unpriced");
	});

	test("the flag can still force prose onto a cell that carries a digit", async () => {
		const html = await ledger({
			rows: [{ sku: "X", qty: 1, money: "2 items to price", unpriced: true }],
		});
		expect(html).toContain("unpriced");
	});

	test("nowhere does a ledger say 'Free' or invent a zero", async () => {
		const html = await ledger({
			rows: [
				{ sku: "X", qty: 1, money: UNAVAILABLE_LABEL },
				{ sku: "Y", qty: 2, money: "priced at checkout" },
			],
		});
		expect(html.toLowerCase()).not.toContain("free");
		expect(html).not.toContain("0.00");
	});
});

describe("a coupon code keeps its spelling (QA round 2)", () => {
	test("the code is its own element, out of the label's uppercase", async () => {
		const html = await container.renderToString(Sum, {
			props: {
				rows: [{ label: "Discount", code: "qa2admin2", amount: money("$3.00") }],
				total: money("$7.00"),
			},
		});
		expect(html).toMatch(/<span class="[^"]*\bcode\b[^"]*"[^>]*>qa2admin2<\/span>/);
		expect(html).not.toContain("QA2ADMIN2");
	});

	test("its style undoes the label's text-transform", () => {
		const source = readFileSync(
			path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/components/Sum.astro"),
			"utf8",
		);
		expect(source).toMatch(/\.code\s*\{[^}]*text-transform:\s*none/);
	});
});

describe("Ledger — a digital line the buyer may download carries its link (issue #376)", () => {
	const ledger = (props: Record<string, unknown>): Promise<string> =>
		container.renderToString(Ledger, { props });

	test("a row WITH a downloadHref links to it, named for the line", async () => {
		const html = await ledger({
			rows: [
				{
					title: "Field Guide",
					sku: "EBOOK-01",
					qty: 1,
					money: "$9.00",
					downloadHref: "/orders/o-1/download/EBOOK-01",
				},
			],
		});
		expect(html).toMatch(/<a [^>]*href="\/orders\/o-1\/download\/EBOOK-01"[^>]*>/);
		expect(html).toMatch(/>Download<span class="u-sr-only"[^>]*> Field Guide<\/span><\/a>/);
	});

	test("a row WITHOUT one draws no link at all", async () => {
		const html = await ledger({
			rows: [{ title: "Otta Tee", sku: "OTTA-TEE-01", qty: 1, money: "$25.00" }],
		});
		expect(html).not.toContain("<a ");
		expect(html).not.toContain("Download");
	});

	test("a title-less row names the link by its SKU", async () => {
		const html = await ledger({
			rows: [
				{ sku: "EBOOK-01", qty: 1, money: "$9.00", downloadHref: "/orders/o/download/EBOOK-01" },
			],
		});
		expect(html).toMatch(/>Download<span class="u-sr-only"[^>]*> EBOOK-01<\/span><\/a>/);
	});
});
