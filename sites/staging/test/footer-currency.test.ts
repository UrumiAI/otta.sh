/**
 * Which pages name a currency in the footer, and which deliberately do not
 * (docs/theme/TEMPERED.md §7).
 *
 * The chip is fed a value the page already holds; it is never assembled by the
 * layout. That makes its ABSENCE meaningful — and easy to mistake for a
 * rendering bug — so the split is pinned here rather than left to whoever next
 * notices the footer looks empty on the home page.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/pages");
const read = (relative: string): string => readFileSync(path.join(PAGES, relative), "utf8");

/** Pages that render money, and the view-model field the currency rides on. */
const NAMES_A_CURRENCY: ReadonlyArray<readonly [string, string]> = [
	["cart/index.astro", "cart?.currency"],
	["checkout/index.astro", "totals.total.money?.currency"],
	["orders/[orderId].astro", "order?.currency"],
	["products/[slug].astro", "product?.price?.currency"],
	// Increment 3 moved both catalog pages into this list. `products/index.astro`
	// has always printed `price.formatted` on every card and named no currency,
	// which was the split being wrong rather than the pages being exempt; and the
	// home hero now carries the inventory tape, so it quotes prices too. Both read
	// the currency off the FIRST PRICED view model on the page — the same figure
	// those prices were formatted from — and both still name none when the
	// commerce service is unreachable and no price rendered at all.
	["index.astro", "product.price !== null)?.price?.currency"],
	["products/index.astro", "product.price !== null)?.price?.currency"],
];

/** Pages that read no money at all. Bare is correct, not a bug. */
const NAMES_NOTHING: readonly string[] = [
	"404.astro",
	// /checkout/pay makes NO commerce call by design — its cookie stash holds an
	// order id and a client secret, nothing money-shaped. It gains the currency
	// when it gains the amount ("Pay $40.00", §7), not before.
	"checkout/pay.astro",
];

describe("footer currency", () => {
	test.each(NAMES_A_CURRENCY)("%s passes its own %s", (file, field) => {
		const source = read(file);
		expect(source).toMatch(/<Base[\s\S]*?currency=\{/);
		expect(source).toContain(field);
	});

	test.each(NAMES_NOTHING)("%s passes none, because it reads no money", (file) => {
		expect(read(file)).not.toMatch(/<Base[\s\S]*?currency=/);
	});

	test("no page hands the layout a currency literal", () => {
		// The whole point of the prop: `currency="USD"` anywhere is the same lie
		// the hardcoded footer told, just moved one file along.
		for (const [file] of NAMES_A_CURRENCY) {
			expect(read(file), `${file} hardcodes a currency`).not.toMatch(/currency=["'][A-Z]{3}["']/);
		}
	});
});
