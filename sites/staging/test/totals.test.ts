/**
 * The money rules (docs/theme/TEMPERED.md §7) — the part of this theme with the
 * least room for interpretation.
 *
 * "Not calculated" is not zero. A store with no shipping zone and no tax class
 * gets `shippingCents: 0` / `taxCents: 0` from the quote pipeline's synthetic
 * zeros, and the view model already refuses to turn those into money (`money:
 * null` + an honest label — see the plugin's checkout-view-model.ts). This
 * module is the theme half of that contract: it decides which rows are prose
 * rather than figures, and it writes the footnote that NAMES what the total is
 * missing.
 */
import { NOT_APPLICABLE_LABEL, NOT_CALCULATED_LABEL, type CheckoutAmountView } from "@urumi/plugin";
import { describe, expect, test } from "vitest";
import { isUncalculated, sumRowText, uncalculatedFootnote } from "../src/lib/totals.js";

const money = (formatted: string): CheckoutAmountView => ({
	money: { amount: 4000, currency: "USD", formatted },
	label: formatted,
});
const uncomputed = (label: string): CheckoutAmountView => ({ money: null, label });

describe("isUncalculated — figures and prose are told apart by the view model, not by parsing", () => {
	test("a computed amount is a figure, even at zero", () => {
		// A genuine free-shipping order is a real number and must render as one.
		expect(
			isUncalculated({ money: { amount: 0, currency: "USD", formatted: "$0.00" }, label: "$0.00" }),
		).toBe(false);
	});

	test("an uncomputed amount is prose", () => {
		expect(isUncalculated(uncomputed(NOT_CALCULATED_LABEL))).toBe(true);
		expect(isUncalculated(uncomputed(NOT_APPLICABLE_LABEL))).toBe(true);
	});
});

describe("sumRowText — what a row actually prints", () => {
	test("a computed row prints its formatted money verbatim, never re-assembled", () => {
		expect(sumRowText({ label: "Subtotal", amount: money("$40.00") })).toBe("$40.00");
	});

	test("an uncomputed row prints its honest label", () => {
		expect(sumRowText({ label: "Shipping", amount: uncomputed(NOT_CALCULATED_LABEL) })).toBe(
			"Not calculated",
		);
	});

	test("a bare em dash is replaced by the row's own prose — §7 forbids it alone", () => {
		// The view model's NOT_APPLICABLE_LABEL is "—", which on its own is
		// indistinguishable from an outage, a free item and a store that cannot
		// price the row. The page supplies the sentence; the component never
		// prints the dash by itself.
		expect(
			sumRowText({
				label: "Discount",
				amount: uncomputed(NOT_APPLICABLE_LABEL),
				fallback: "No coupon applied",
			}),
		).toBe("No coupon applied");
	});

	test("a fallback NEVER overrides real money", () => {
		expect(
			sumRowText({ label: "Discount", amount: money("−$5.00"), fallback: "No coupon applied" }),
		).toBe("−$5.00");
	});

	test("nothing here can produce $0.00, an empty string, or the word Free", () => {
		for (const label of [NOT_CALCULATED_LABEL, NOT_APPLICABLE_LABEL]) {
			const text = sumRowText({
				label: "Shipping",
				amount: uncomputed(label),
				fallback: "Not calculated",
			});
			expect(text).not.toBe("");
			expect(text).not.toMatch(/^[^\d]*0[.,]00/);
			expect(text.toLowerCase()).not.toContain("free");
		}
	});
});

describe("uncalculatedFootnote — the footnote NAMES what is missing", () => {
	const shipping = { label: "Shipping", amount: uncomputed(NOT_CALCULATED_LABEL) };
	const tax = { label: "Tax", amount: uncomputed(NOT_CALCULATED_LABEL) };
	const subtotal = { label: "Subtotal", amount: money("$40.00") };
	const discount = {
		label: "Discount",
		amount: uncomputed(NOT_APPLICABLE_LABEL),
		fallback: "No coupon applied",
	};

	test("names both components when neither was calculated", () => {
		const note = uncalculatedFootnote([subtotal, discount, shipping, tax], true);
		expect(note).toContain("shipping");
		expect(note).toContain("tax");
	});

	test("names only the one that is missing", () => {
		const note = uncalculatedFootnote(
			[subtotal, shipping, { label: "Tax", amount: money("$3.20") }],
			true,
		);
		expect(note).toContain("shipping");
		expect(note).not.toContain("tax");
	});

	test("a row that is merely not APPLICABLE is not called uncalculated", () => {
		// "no coupon on this order" is not "this store never set discounts up".
		const note = uncalculatedFootnote([subtotal, discount], true);
		expect(note).toBeNull();
	});

	test("no footnote when the total is complete", () => {
		expect(
			uncalculatedFootnote([subtotal, { label: "Tax", amount: money("$3.20") }], false),
		).toBeNull();
	});

	test("the view model has the last word — no flag, no footnote", () => {
		// `totalExcludesUncalculated` is the plugin's own signal; the theme does
		// not second-guess it from the rows.
		expect(uncalculatedFootnote([subtotal, shipping, tax], false)).toBeNull();
	});

	test("is written from the shopper's side, and does not apologise or name internals", () => {
		const note = uncalculatedFootnote([subtotal, shipping, tax], true) ?? "";
		expect(note).not.toMatch(/sorry|apolog/i);
		expect(note).not.toMatch(/commerce service|view model|CMS|plugin/i);
		expect(note).not.toMatch(/free/i);
	});
});
