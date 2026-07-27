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
import type { CartPricingWire } from "@urumi/plugin";
import { describe, expect, test } from "vitest";
import {
	cartMoneyCell,
	isCartPricingDegraded,
	PRICED_AT_CHECKOUT_LABEL,
	UNAVAILABLE_LABEL,
} from "../src/lib/cart-view.js";

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
