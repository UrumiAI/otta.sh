/**
 * `src/lib/tape.ts` — the home hero's rows and the catalog's counts
 * (docs/theme/TEMPERED.md §7, §8).
 *
 * These rules were `.astro` frontmatter until increment 3's review, where all
 * three of them turned out to be wrong in ways a source-text grep could not
 * see: a count taken from a capped fetch, a `??` chain that let a blank tagline
 * render an empty `<h1>`, and a tape that showed a sold-out price identically
 * to a buyable one. What follows is the boundary cases, run against the
 * functions rather than against the pages that call them.
 */
import { describe, expect, test } from "vitest";
import type { ProductViewModel } from "@urumi/plugin";
import {
	exactCount,
	FALLBACK_THESIS,
	itemCountLabel,
	shopLinkLabel,
	storeDescription,
	storeThesis,
	storeTitle,
	tapeRows,
	TAPE_ROWS,
} from "../src/lib/tape.js";

/** A priced, sellable view model — the shape the plugin's list route returns. */
function priced(
	n: number,
	availability: "in_stock" | "out_of_stock" = "in_stock",
): ProductViewModel {
	return {
		id: `product:p${n}`,
		title: `Product ${n}`,
		purchasable: true,
		sku: `SKU-${n}`,
		price: { amount: 1000 + n, currency: "USD", formatted: `$${10 + n}.00` },
		availability,
		slots: { addToCart: null },
	} as unknown as ProductViewModel;
}

/** A product the store has published but never priced. */
function unpriced(n: number): ProductViewModel {
	return {
		id: `product:u${n}`,
		title: `Unpriced ${n}`,
		purchasable: false,
		sku: null,
		price: null,
		availability: null,
		slots: { addToCart: null },
	} as unknown as ProductViewModel;
}

const list = (count: number): ProductViewModel[] =>
	Array.from({ length: count }, (_, i) => priced(i + 1));

describe("tapeRows — only what the store can actually sell", () => {
	test("no products ⇒ no rows, and the page renders its thesis alone", () => {
		expect(tapeRows([])).toEqual([]);
	});

	test("a null view model list — commerce unreachable — is the same as none", () => {
		// §8's degraded rule: the tape is omitted, not filled with blanks.
		expect(tapeRows(null)).toEqual([]);
	});

	test("one product ⇒ one row", () => {
		const rows = tapeRows(list(1));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			item: "SKU-1",
			price: "$11.00",
			stock: "In stock",
			soldOut: false,
		});
	});

	test("exactly TAPE_ROWS products fill the tape and drop nothing", () => {
		expect(tapeRows(list(TAPE_ROWS))).toHaveLength(TAPE_ROWS);
	});

	test("one MORE than TAPE_ROWS is bounded — the shop link must stay on screen", () => {
		const rows = tapeRows(list(TAPE_ROWS + 1));
		expect(rows).toHaveLength(TAPE_ROWS);
		// It is the FIRST rows that survive, in catalog order.
		expect(rows.at(-1)?.item).toBe(`SKU-${TAPE_ROWS}`);
	});

	test("an all-unpriced catalog yields no rows at all", () => {
		// §7: an unpriced product has no price cell to fill, and a dash in a money
		// column is indistinguishable from free. The hero degrades to thesis-only
		// even though the commerce read succeeded.
		expect(tapeRows([unpriced(1), unpriced(2), unpriced(3)])).toEqual([]);
	});

	test("unpriced products are skipped, not counted against the row budget", () => {
		const mixed = [unpriced(1), priced(1), unpriced(2), priced(2)];
		expect(tapeRows(mixed).map((row) => row.item)).toEqual(["SKU-1", "SKU-2"]);
	});

	test("a sold-out product keeps its row, its price and its state", () => {
		const rows = tapeRows([priced(1, "out_of_stock")]);
		expect(rows[0]?.stock).toBe("Sold out");
		expect(rows[0]?.soldOut).toBe(true);
		// The price is still a fact — the theme strikes it, it does not hide it.
		expect(rows[0]?.price).toBe("$11.00");
	});

	test("rows keep catalog order — sold-out products are NOT pushed to the end", () => {
		const rows = tapeRows([priced(1, "out_of_stock"), priced(2)]);
		expect(rows.map((row) => row.item)).toEqual(["SKU-1", "SKU-2"]);
	});

	test("a priced product with no sku falls back to its title", () => {
		const model = { ...priced(9), sku: null } as ProductViewModel;
		expect(tapeRows([model])[0]?.item).toBe("Product 9");
	});

	test("an UNKNOWN availability token makes no claim either way", () => {
		// The rule the `=== "out_of_stock"` test exists for. `AvailabilityToken`
		// is the plugin's to extend; under the old `!== "in_stock"` test a
		// `preorder` product would arrive struck through and labelled "Sold out",
		// which is a fact about a sellable product that the store never quoted.
		const model = { ...priced(1), availability: "preorder" } as unknown as ProductViewModel;
		const row = tapeRows([model])[0];
		expect(row?.soldOut).toBe(false);
		expect(row?.stock).toBe("");
		// The price is the store's own figure and is still printed, unstruck.
		expect(row?.price).toBe("$11.00");
	});
});

describe("exactCount — a number only when the number is true", () => {
	test("a window that did not fill IS the whole catalog", () => {
		expect(exactCount(3, 12)).toBe(3);
		expect(exactCount(0, 12)).toBe(0);
		expect(exactCount(11, 12)).toBe(11);
	});

	test("a FULL window with no second opinion means `at least this many`", () => {
		// `hasMore` absent — no limit was passed, or the loader did not answer —
		// so the window could be the whole catalog or the first page of nine
		// hundred. Absent is not `false`.
		expect(exactCount(12, 12)).toBeNull();
		expect(exactCount(48, 48)).toBeNull();
	});

	test("`hasMore: true` vetoes a count it cannot invent", () => {
		expect(exactCount(3, 12, true)).toBeNull();
		expect(exactCount(12, 12, true)).toBeNull();
		expect(exactCount(3, 12, false)).toBe(3);
	});

	test("a full window PLUS `hasMore: false` is a proof, and the count survives", () => {
		// Not a guess: em-dash asks its loader for `limit + 1` rows precisely so
		// it can answer `hasMore`, so `false` on a full window means the
		// limit-plus-first row was not there. A catalog of exactly 48 is knowable
		// and gets said — refusing would drop the figure for the one store size
		// where it is provable.
		expect(exactCount(12, 12, false)).toBe(12);
		expect(exactCount(48, 48, false)).toBe(48);
	});

	test("an OVER-full window is still refused — that is a bug, not a count", () => {
		// Nothing should hand back more rows than the limit. If something does,
		// the page states no number rather than one it cannot account for.
		expect(exactCount(49, 48, false)).toBeNull();
	});
});

describe("the counted labels", () => {
	test("pluralisation, and nothing at all when the count is unknown", () => {
		expect(itemCountLabel(0)).toBe("0 items");
		expect(itemCountLabel(1)).toBe("1 item");
		expect(itemCountLabel(2)).toBe("2 items");
		expect(itemCountLabel(48)).toBe("48 items");
		expect(itemCountLabel(null)).toBeNull();
	});

	test("the shop link carries the count only when the count is exact", () => {
		expect(shopLinkLabel(3)).toBe("Shop all 3 items");
		expect(shopLinkLabel(48)).toBe("Shop all 48 items");
	});

	test("an unknown count keeps the promise and drops the figure", () => {
		expect(shopLinkLabel(null)).toBe("Shop everything");
		expect(shopLinkLabel(null)).not.toMatch(/\d/);
	});

	test("at one product or none a number is noise", () => {
		expect(shopLinkLabel(1)).toBe("Shop");
		expect(shopLinkLabel(0)).toBe("Shop");
	});
});

describe("the store's own words — blank is not the same as set", () => {
	test("the tagline leads where there is one", () => {
		expect(storeThesis({ title: "Urumi", tagline: "A reference storefront" })).toBe(
			"A reference storefront",
		);
	});

	test("an EMPTY tagline falls through to the title, not to an empty h1", () => {
		// The bug this function exists for: `settings.tagline ?? settings.title`
		// keeps `""`, and the biggest type on the site renders nothing.
		expect(storeThesis({ title: "Urumi", tagline: "" })).toBe("Urumi");
	});

	test("a WHITESPACE tagline is empty too", () => {
		expect(storeThesis({ title: "Urumi", tagline: "   \n\t " })).toBe("Urumi");
	});

	test("a ZERO-WIDTH tagline is empty too — `trim` alone does not catch it", () => {
		// U+200B is a format character, not whitespace, so `"​".trim()` is
		// still truthy. A field cleared by select-and-delete in a rich editor
		// routinely keeps one behind, and it would otherwise be a "set" tagline
		// rendering as an empty `<h1>` — the same bug through another door.
		expect(storeThesis({ title: "Urumi", tagline: "​" })).toBe("Urumi");
		expect(storeThesis({ title: "Urumi", tagline: " ​ ﻿ " })).toBe("Urumi");
		expect(storeDescription({ tagline: "​" })).toBeUndefined();
		expect(storeTitle({ title: "​", tagline: "A reference storefront" })).toBe(FALLBACK_THESIS);
		// A real tagline keeps every character a shopper can see.
		expect(storeThesis({ tagline: "Spring steel" })).toBe("Spring steel");
	});

	test("a blank title falls through as well, to the theme's own name", () => {
		expect(storeThesis({ title: "  ", tagline: "" })).toBe(FALLBACK_THESIS);
		expect(storeThesis({})).toBe(FALLBACK_THESIS);
	});

	test("a set tagline is trimmed rather than rendered with its padding", () => {
		expect(storeThesis({ tagline: "  Spring steel  " })).toBe("Spring steel");
	});

	test("the document title never falls back to the TAGLINE", () => {
		// A page title is the store's name, and a tagline in the browser tab is a
		// different fact. Blank ⇒ the theme's own name.
		expect(storeTitle({ title: "Urumi", tagline: "A reference storefront" })).toBe("Urumi");
		expect(storeTitle({ title: "", tagline: "A reference storefront" })).toBe(FALLBACK_THESIS);
	});

	test("a blank tagline yields NO meta description, not an empty one", () => {
		expect(storeDescription({ tagline: "A reference storefront" })).toBe("A reference storefront");
		expect(storeDescription({ tagline: "" })).toBeUndefined();
		expect(storeDescription({ tagline: "  " })).toBeUndefined();
		expect(storeDescription({})).toBeUndefined();
	});
});
