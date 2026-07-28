/**
 * §5 (storefront-checkout plan) — the cart page's money cells, and the missing
 * test the plan calls out: NOTHING in `sites/staging/test/` exercised the cart
 * page at all, which is how the em-dash symptom shipped unnoticed.
 *
 * The reported bug ("every money column shows —") was never a pricing-code bug.
 * `buildCartPricing`'s first gate short-circuits any line whose `productId` is
 * null (legacy bare adds made before #80 was deployed; the cart cookie lives 30
 * days, so a QA browser still points at one), and that path is SILENT BY
 * DESIGN: `degraded` stays false, so no banner renders, every cell falls to
 * "—", and the total row is suppressed. A visually identical failure comes from
 * a stale worker bundle, where `result.pricing` is `undefined` and the page's
 * `pricing?.degraded` check quietly evaluates to nothing.
 *
 * Both are indistinguishable from an outage at the page, which is the same
 * dishonesty the checkout's "Not calculated" rule exists to prevent. So the
 * decision is a pure function, tested here, and the page is pinned to use it.
 *
 * (No render/DOM harness exists in this package — plan §7.3 / issue #40. The
 * decision is extracted precisely so it can be asserted without one.)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CartPricingWire, type CartWire, totalQty } from "@urumi/plugin";
import { describe, expect, test } from "vitest";
import {
	cartMoneyCell,
	isCartPricingDegraded,
	PRICED_AT_CHECKOUT_LABEL,
	UNAVAILABLE_LABEL,
} from "../src/lib/cart-view.js";
import { HOLD_RELEASED_NEXT_STEP } from "../src/lib/hold.js";
import { isUnpricedText, moneyCellText } from "../src/lib/totals.js";

const CART_PAGE = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../src/pages/cart/index.astro",
);

const HEALTHY: CartPricingWire = {
	degraded: false,
	lines: [],
	total: null,
	allLinesPriced: false,
};

describe("isCartPricingDegraded", () => {
	test("an explicit degraded flag is degraded", () => {
		expect(isCartPricingDegraded({ ...HEALTHY, degraded: true })).toBe(true);
	});

	test("UNDEFINED pricing is degraded too — the stale-bundle case the page used to swallow", () => {
		// `pricing?.degraded` on an undefined pricing is `undefined`, i.e. falsy,
		// i.e. no banner: the page rendered an outage as if it were an empty
		// catalogue. Treating absent as degraded is the fix.
		expect(isCartPricingDegraded(undefined)).toBe(true);
		expect(isCartPricingDegraded(null)).toBe(true);
	});

	test("healthy pricing is not degraded", () => {
		expect(isCartPricingDegraded(HEALTHY)).toBe(false);
	});
});

describe("cartMoneyCell", () => {
	test("a priced line shows its formatted money", () => {
		expect(cartMoneyCell("$19.99", false)).toBe("$19.99");
	});

	test("an UNPRICED line says so honestly instead of showing a bare em-dash", () => {
		// The line exists and is real; we just cannot price it here. "—" is
		// indistinguishable from an outage, and from a free item.
		expect(cartMoneyCell(null, false)).toBe(PRICED_AT_CHECKOUT_LABEL);
		expect(cartMoneyCell(undefined, false)).toBe(PRICED_AT_CHECKOUT_LABEL);
		expect(PRICED_AT_CHECKOUT_LABEL).not.toBe("—");
	});

	test("when the whole pricing lookup is degraded the cell defers to the banner", () => {
		expect(cartMoneyCell(null, true)).toBe(UNAVAILABLE_LABEL);
	});

	test("neither label ever fabricates a number", () => {
		expect(PRICED_AT_CHECKOUT_LABEL).not.toMatch(/\d/);
		expect(UNAVAILABLE_LABEL).not.toMatch(/\d/);
	});
});

describe("the cart page uses the honest cells (and offers checkout)", () => {
	const source = readFileSync(CART_PAGE, "utf8");

	test("renders money cells through cartMoneyCell, never a bare ?? '—'", () => {
		expect(source).toContain("cartMoneyCell");
		expect(source).not.toMatch(/formatted\s*\?\?\s*"—"/);
	});

	test("treats absent pricing as degraded (the stale-bundle branch)", () => {
		expect(source).toContain("isCartPricingDegraded");
		expect(source).not.toMatch(/pricing\?\.degraded\s*&&/);
	});

	test("offers the way forward the whole journey was missing: a link to /checkout", () => {
		expect(source).toContain('href="/checkout"');
	});
});

/**
 * Increment 4 (docs/theme/TEMPERED.md §6–§8): the table became lines, and the
 * hold ribbon became the thing the page is built around.
 *
 * Still source text, for the reason the header gives — there is no render
 * harness for a page in this package, and the parts that CAN be executed
 * (`holdView`, `moneyCellText`, `cartMoneyCell`) already are, in their own
 * suites. What is asserted here is the WIRING those suites cannot see: that the
 * page hands the ribbon a real `expiresAt`, that money reaches the screen
 * through the §7 helpers rather than beside them, and that the behaviour paid
 * for in earlier fixes — the per-form idempotency keys, the error copy, the
 * empty state — survived the restyle.
 */
describe("the Tempered cart: lines, ribbons and an honest totals block", () => {
	const source = readFileSync(CART_PAGE, "utf8");
	/** The template only — comments describe the rules and would answer for
	 *  them otherwise. */
	const markup = source
		.slice(source.indexOf("\n---", 3) + 4)
		.replace(/<style>[\s\S]*?<\/style>/, "");

	test("the table is gone — §8's lines replaced it", () => {
		expect(markup).not.toContain("<table");
		expect(markup).not.toContain("<td");
		expect(markup).toContain('class="line"');
	});

	test("every line carries a hold ribbon wired to that line's own expiresAt (§6)", () => {
		// Attribute-order- and whitespace-insensitive: what is being pinned is
		// that the ribbon gets THAT LINE's expiry (a page-wide constant, or the
		// cart's first line, would be a lie on every other row), not the exact
		// spelling of one JSX tag. The literal form this used to assert broke on
		// a reformat and said nothing extra when it passed.
		expect(markup).toMatch(/<HoldRibbon[^>]*\sexpiresAt=\{view\.line\.expiresAt\}/);
		// The raw ISO instant used to be a table cell. The ribbon renders the
		// countdown, and the no-JS fallback renders the absolute time — neither
		// is a bare timestamp printed by this page.
		expect(markup).not.toContain("{line.expiresAt ?? ");
	});

	test("the released hold's next step is the ribbon's copy, not a second copy here", () => {
		// HoldRibbon already ships `HOLD_RELEASED_NEXT_STEP` and reveals it when
		// a hold lapses under the shopper's eyes. A page-side duplicate would be
		// a second sentence to keep in sync, and it would render on lines whose
		// hold is still live.
		expect(source).not.toContain(HOLD_RELEASED_NEXT_STEP);
		expect(source).not.toContain("Stock went back on sale");
	});

	test("line money goes through §7's gate, so no cell can print a bare dash", () => {
		// EXECUTED, not grepped: the composition the page performs is run here,
		// so this fails when the RULE breaks rather than when the call is
		// spelled differently. `cartMoneyCell` answers which failure this is;
		// `moneyCellText` is the last gate before the screen and substitutes
		// prose for anything that does not say something — cart-view's
		// degraded label is a lone "—", which is precisely what §7 forbids.
		expect(moneyCellText(cartMoneyCell(undefined, true), "Price unavailable")).toBe(
			"Price unavailable",
		);
		expect(moneyCellText(cartMoneyCell(null, true), "Price unavailable")).toBe("Price unavailable");
		// Real money and real prose pass through untouched.
		expect(moneyCellText(cartMoneyCell("$25.00", false), "Price unavailable")).toBe("$25.00");
		expect(moneyCellText(cartMoneyCell(null, false), "Price unavailable")).toBe(
			PRICED_AT_CHECKOUT_LABEL,
		);

		// And the page is wired to that composition rather than beside it.
		expect(markup).toContain("view.money");
		expect(source).toMatch(/moneyCellText\(/);
		expect(source).toMatch(/cartMoneyCell\(formatted, pricingDegraded\)/);
		expect(source).toContain("PRICE_UNAVAILABLE");
		// No element whose whole content is a dash. (Em dashes inside a
		// SENTENCE are prose and are fine — the banners use them.)
		expect(markup).not.toMatch(/>\s*[—–-]\s*</);
		expect(markup).not.toMatch(/\?\?\s*"[—–-]"/);
	});

	test("the unit price beside the line total passes the same gate", () => {
		// `unitPrice.formatted` was the one money string on the page taken raw
		// off the wire — it reached the screen as "$25.00 each" without ever
		// meeting §7's gate, so a blank or dashed unit price would have printed
		// as "— each".
		expect(source).toMatch(/const unitPrice = lineMoneyText\(linePricing\?\.unitPrice/);
		expect(source).not.toMatch(/linePricing\?\.unitPrice\?\.formatted \?\? null/);
	});

	test('"each" is suppressed when the unit price is prose, not a figure', () => {
		// A cell with no digit in it is prose (the same rule Ledger follows), and
		// "Priced at checkout each" is not a sentence — the line total is already
		// saying it.
		expect(isUnpricedText(PRICED_AT_CHECKOUT_LABEL)).toBe(true);
		expect(isUnpricedText("Price unavailable")).toBe(true);
		expect(isUnpricedText("$25.00")).toBe(false);
		expect(source).toMatch(/each:\s*line\.qty > 1 && !isUnpricedText\(unitPrice\)/);
	});

	test("the unpriced cell is sentence-cased HERE, not in the shared constant", () => {
		// The shared label is lower-case because it is also read mid-sentence;
		// on this page it is a cell of its own beside sentence-cased siblings
		// (§10). The mapping is page-side, so nothing else that imports the
		// constant is re-cased behind its back.
		expect(PRICED_AT_CHECKOUT_LABEL).toBe("priced at checkout");
		expect(source).toContain('const PRICED_AT_CHECKOUT = "Priced at checkout"');
		expect(source).toMatch(/cell === PRICED_AT_CHECKOUT_LABEL \? PRICED_AT_CHECKOUT : cell/);
	});

	test("prose cells are set as prose, decided by the value and not by a flag", () => {
		// The same rule Ledger follows: a cell with no digit in it is prose
		// whatever the page believes about it.
		expect(markup).toContain("isUnpricedText(view.money)");
	});

	test("the totals block names what it does not know instead of inventing it", () => {
		expect(markup).toContain("<Sum");
		// §7: shipping is quoted one step later. Never "Free", never a zero.
		expect(source).toContain('label: "Shipping"');
		expect(source).toContain("At checkout");
		expect(markup).not.toMatch(/Free shipping|\$\d/);
	});

	test("a cart with no priced line says money is confirmed at checkout (§7)", () => {
		// Quantity-only is the cart's normal state for a legacy or unsynced
		// line, and the shopper is about to act on the total either way.
		expect(source).toContain("Confirmed at checkout");
		expect(source).toContain("Priced at checkout");
	});

	test("a partial total says what it is short of", () => {
		expect(source).toContain("allLinesPriced");
		expect(source).toContain("Some items are priced at checkout");
	});

	test("the foot carries the primary action and the whole price disclosure", () => {
		expect(markup).toContain("Check out");
		// BOTH halves. The restyle shortened the pre-theme disclosure ("prices
		// shown are informational and may change") to "your total is confirmed
		// at checkout" while newly rendering a live unit price beside a hold
		// countdown — and a hold reserves STOCK, not a price. §7: don't imply
		// otherwise.
		expect(markup).toContain("your total is confirmed at checkout.");
		expect(markup).toMatch(/[Pp]rices are live and may change/);
	});

	test("the header count is UNITS, and it makes no claim about holds", () => {
		// It read "3 items · 2 held" and both halves could be wrong at once: the
		// items were units, the held count was LINES (four units on three lines
		// rendered "4 items · 3 held"), and the held clause was a render-time
		// snapshot printed above ribbons that keep ticking — it said "2 held"
		// over two ribbons reading "Hold released".
		const cart: CartWire = {
			cartId: "cart_1",
			state: "active",
			currency: "USD",
			lines: [
				{ lineId: "l1", sku: "A", productId: "p1", qty: 3, reservationId: null, expiresAt: null },
				{ lineId: "l2", sku: "B", productId: "p2", qty: 1, reservationId: null, expiresAt: null },
			],
		};
		expect(totalQty(cart)).toBe(4);
		expect(source).toMatch(/itemCount === 1 \? "item" : "items"/);
		// No held clause, and no render-time hold snapshot left to go stale.
		expect(source).not.toContain("heldCount");
		expect(source).not.toContain("holdView");
		// Nothing interpolated into the header line counts holds.
		expect(source).not.toMatch(/\$\{[^}]*held/i);
	});

	test("the lines are a LIST, which is what the table used to give for free", () => {
		// A flat stack of divs announces nothing; the table it replaced gave a
		// screen reader "row 2 of 3". `role="list"` is redundant markup that is
		// not redundant in practice — WebKit drops list semantics from a list
		// styled `list-style: none`, and this one is (StepTrack, same reason).
		expect(markup).toMatch(/<ul[^>]*role="list"/);
		expect(markup).toContain('<li class="line">');
	});

	test("both forms survived the restyle, each with its own fresh idempotency key", () => {
		expect(markup).toContain('action="/cart/update"');
		expect(markup).toContain('action="/cart/remove"');
		expect(markup).toContain(
			'<input type="hidden" name="idempotencyKey" value={view.updateKey} />',
		);
		expect(markup).toContain(
			'<input type="hidden" name="idempotencyKey" value={view.removeKey} />',
		);
		// One key per RENDERED form: a double-submit replays, a reload does not.
		expect(source).toContain("updateKey: crypto.randomUUID()");
		expect(source).toContain("removeKey: crypto.randomUUID()");
	});

	test("every row's controls are distinguishable to a screen reader", () => {
		// Three "Remove" buttons in a row are three identical accessible names
		// unless the line says which line it is.
		expect(markup).toContain("label={`Quantity, ${view.name}`}");
		expect(markup).toMatch(/Remove<span class="u-sr-only"> \{view\.name\}<\/span>/);
		expect(markup).toMatch(/Update<span class="u-sr-only"> \{view\.name\}<\/span>/);
	});

	test("error copy is still quoted from error-messages.ts, not rewritten (§10)", () => {
		expect(source).toContain("cartErrorMessage(error)");
	});

	test("the empty cart is a designed surface, and a degraded read is not one", () => {
		// §8: "empty and degraded states are designed surfaces, not
		// afterthoughts". The mockup's own empty-cart frame — a display-face
		// line, one sentence about what this store does for you, and a way out.
		expect(markup).toContain("Nothing held yet.");
		expect(markup).toContain(
			"Your cart is empty. Pick something and we'll hold the stock while you decide.",
		);
		expect(markup).toMatch(/<a href="\/products"[^>]*class="btn btn-ghost"/);
		// A cart we could not READ is not an empty cart.
		expect(markup).toContain("!degraded");
	});

	test("the content read is ONE batched, request-cached query — not a fan-out", () => {
		// `getEmDashEntry` per distinct productId was an uncapped parallel fan-out
		// of D1 round-trips on a public route, and it is not request-cached. The
		// array `where` value compiles to one `WHERE id IN (…)`, which is.
		expect(source).toContain("getEmDashCollection(");
		expect(source).not.toMatch(/getEmDashEntry\(/);
		expect(source).toMatch(/where:\s*\{\s*id:\s*productIds\s*\}/);
		// Bounded, and the bound is stated: `IN (?, ?, …)` binds one parameter
		// per id and D1 caps those per statement.
		expect(source).toContain("CART_CONTENT_ID_CAP");
		expect(source).toMatch(/\.slice\(0, CART_CONTENT_ID_CAP\)/);
		// Keyed on the CONTENT id (the cart line's productId), not entry.id,
		// which is the slug-derived routing id and would miss every line.
		expect(source).toContain("contentById.set(data.id, data)");
	});

	test("a failed content read is LOGGED, not swallowed into SKU-only lines", () => {
		// `getEmDashCollection` does not throw for a CMS/DB fault — it returns
		// `{ entries: [], error }` (see cart/add.ts's reproduced-live
		// investigation of the same contract on the entry API). Destructuring
		// only the data is how a D1 outage renders every line SKU-only with
		// nothing in the log to say why.
		expect(source).toMatch(/const \{ entries, error: contentError \}/);
		expect(source).toMatch(/contentError !== undefined && contentError\.name !== /);
		expect(source).toMatch(/console\.error\("\[site-staging\] cart line content lookup failed/);
		// The catch stays as a backstop against the contract changing again.
		expect(source).toMatch(/console\.error\("\[site-staging\] cart line content lookup threw/);
	});

	test("the image rule is the shared one, not a second copy of it", () => {
		// `images.src ?? images.url` lived here AND in products.ts; a second copy
		// is how one of them silently stops resolving when a third spelling of a
		// media value turns up.
		expect(source).toContain("productImage(content)");
		expect(source).not.toContain("images?.src");
	});

	test("nothing sticks: <main> is a scroll container while legacy-bridge is in play", () => {
		// Kept deliberately, though it pins an ABSENCE nothing currently wants to
		// add: `overflow-x: auto` on <main> (legacy-bridge.css, transitional)
		// forces overflow-y to auto too, so a sticky totals block would stick to
		// <main> instead of the viewport and look broken in a way no unit test
		// would otherwise catch. Delete this with legacy-bridge.css.
		expect(source).not.toContain("position: sticky");
	});

	test("the page styles no component's root — a rule that could never match", () => {
		// Astro scopes a page's CSS to the page's hash; a component's root
		// carries its own. The layout is done with grid tracks and wrappers for
		// exactly that reason.
		for (const component of ["HoldRibbon", "MediaPanel", "PriceTag", "QtyField", "Sum"]) {
			expect(markup, `${component} is styled from the page`).not.toMatch(
				new RegExp(`<${component}[^>]*\\sclass=`),
			);
		}
	});

	test("declares no colour of its own beyond the transitional notice panel", () => {
		const styles = /<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? "";
		const declarations = styles.replace(/\/\*[\s\S]*?\*\//g, "");
		// The two literals are the pre-theme `?error=` panel, which increment 6
		// replaces with the Notice component; legacy-bridge.css pins its ink to
		// this exact pale ground.
		const hexes = declarations.match(/#[\da-f]{3,8}\b/gi) ?? [];
		expect(hexes.toSorted()).toEqual(["#e6c200", "#fff7e0"]);
	});
});
