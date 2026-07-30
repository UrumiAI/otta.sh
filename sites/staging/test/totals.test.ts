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
import { NOT_APPLICABLE_LABEL, NOT_CALCULATED_LABEL, type CheckoutAmountView } from "@otta-sh/plugin";
import { describe, expect, test } from "vitest";
import { PRICED_AT_CHECKOUT_LABEL, UNAVAILABLE_LABEL } from "../src/lib/cart-view.js";
import {
	NOT_APPLIED_LABEL,
	PAY_FALLBACK_LABEL,
	isUncalculated,
	isUnpricedText,
	moneyCellText,
	payButtonLabel,
	sumRowText,
	uncalculatedFootnote,
} from "../src/lib/totals.js";

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

describe("payButtonLabel — the pay button carries the amount (§7)", () => {
	test("a real total becomes 'Pay $40.00', with the plugin's string untouched", () => {
		expect(payButtonLabel("$40.00")).toBe("Pay $40.00");
	});

	test("the amount is printed VERBATIM — the theme never re-assembles money", () => {
		// A non-USD, non-Latin, RTL or zero-decimal figure has to survive intact:
		// it came out of Intl at place-time and nothing here is entitled to a
		// second opinion about symbol placement or grouping.
		expect(payButtonLabel("¥4,000")).toBe("Pay ¥4,000");
		expect(payButtonLabel("40,00 €")).toBe("Pay 40,00 €");
		expect(payButtonLabel("‏٤٠٫٠٠ ر.س.‏")).toBe("Pay ‏٤٠٫٠٠ ر.س.‏");
	});

	test("a genuinely free order still states its amount rather than falling back", () => {
		// $0.00 is a figure, not an absence — the same rule the totals rows follow.
		expect(payButtonLabel("$0.00")).toBe("Pay $0.00");
	});

	test("NO amount falls back to 'Pay now' — a pre-total stash must stay payable", () => {
		// The backward-compatibility case, and the only reason the fallback still
		// exists: a `otta_checkout` cookie written before the total shipped is
		// valid for the rest of its 15-minute TTL and its order is real.
		expect(payButtonLabel(undefined)).toBe(PAY_FALLBACK_LABEL);
		expect(PAY_FALLBACK_LABEL).toBe("Pay now");
	});

	test("a string that SAYS nothing falls back too — 'Pay —' is not a button", () => {
		// Same substance rule as the totals cells: blank, whitespace and every
		// spelling of a dash are indistinguishable from an outage, and this is the
		// one control in the theme that moves money.
		for (const empty of ["", "   ", "—", "–", "-"]) {
			expect(payButtonLabel(empty), `${empty} reached the button`).toBe(PAY_FALLBACK_LABEL);
		}
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

	test("a bare em dash NEVER reaches the screen, even with no fallback supplied", () => {
		// The regression this exists for. `fallback` is optional; the discount
		// row hits this path on every ordinary order; and the earlier
		// implementation returned `row.amount.label` when the prop was omitted,
		// printing exactly the lone dash §7 forbids. Every test in the suite
		// happened to supply a fallback, so none of them saw it.
		const text = sumRowText({ label: "Discount", amount: uncomputed(NOT_APPLICABLE_LABEL) });
		expect(text).not.toBe(NOT_APPLICABLE_LABEL);
		expect(text).toBe(NOT_APPLIED_LABEL);
		expect(text.trim().length).toBeGreaterThan(1);
	});

	test("the default is keyed on the plugin's CONSTANT, not on a hard-coded dash", () => {
		// If the plugin ever changes what "not applicable" looks like, this has
		// to keep working rather than silently start echoing the new label.
		expect(NOT_APPLICABLE_LABEL).toBe("—");
		expect(sumRowText({ label: "Discount", amount: uncomputed(NOT_APPLICABLE_LABEL) })).toBe(
			NOT_APPLIED_LABEL,
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

	test("a label that says NOTHING falls through to the honest default", () => {
		// The final fallthrough used to be `row.fallback ?? row.amount.label`,
		// which returns the label whatever it is. Keying only on the imported em
		// dash guards ONE spelling of the mistake: an empty label, a label of
		// spaces, and a label that is a different dash codepoint are all
		// indistinguishable from an outage on screen, and all of them are one
		// keystroke from the constant.
		for (const label of ["", "  ", "–", "-", "—", "…"]) {
			expect(
				sumRowText({ label: "Shipping", amount: uncomputed(label) }),
				`label: ${JSON.stringify(label)}`,
			).toBe(NOT_APPLIED_LABEL);
		}
	});

	test("a fallback that says nothing is not trusted either", () => {
		for (const fallback of ["", "   ", "–"]) {
			expect(
				sumRowText({ label: "Discount", amount: uncomputed(NOT_APPLICABLE_LABEL), fallback }),
				`fallback: ${JSON.stringify(fallback)}`,
			).toBe(NOT_APPLIED_LABEL);
		}
	});

	test("but a label that DOES say something is still printed verbatim", () => {
		// The guard is about substance, not about length, and it must not start
		// swallowing honest prose — in any script.
		for (const label of ["Not calculated", "Ask at checkout", "非課税", "0"]) {
			expect(sumRowText({ label: "Shipping", amount: uncomputed(label) })).toBe(label);
		}
	});
});

describe("moneyCellText — the same rule, for a line item's money cell (§7)", () => {
	test("real money is printed verbatim", () => {
		expect(moneyCellText("$25.00")).toBe("$25.00");
		expect(moneyCellText("−$4.00")).toBe("−$4.00");
	});

	test("honest prose is printed verbatim too", () => {
		expect(moneyCellText(PRICED_AT_CHECKOUT_LABEL)).toBe(PRICED_AT_CHECKOUT_LABEL);
	});

	test("the cart's own UNAVAILABLE_LABEL never reaches the screen as itself", () => {
		// `cart-view.ts` returns a bare "—" when the pricing lookup failed, and
		// §7 forbids exactly that: alone it is indistinguishable from an outage,
		// from a free item, and from a line the store cannot price.
		expect(UNAVAILABLE_LABEL).toBe("—");
		expect(moneyCellText(UNAVAILABLE_LABEL)).toBe(NOT_APPLIED_LABEL);
	});

	test("blank and punctuation-only cells go the same way", () => {
		for (const cell of ["", "   ", "-", "–", "—"]) {
			expect(moneyCellText(cell), `cell: ${JSON.stringify(cell)}`).toBe(NOT_APPLIED_LABEL);
		}
	});

	test("a page that knows WHY the cell is empty says so instead", () => {
		expect(moneyCellText(UNAVAILABLE_LABEL, "Unavailable right now")).toBe("Unavailable right now");
	});

	test("a fallback NEVER overrides a cell that already says something", () => {
		expect(moneyCellText("$25.00", "Unavailable right now")).toBe("$25.00");
		expect(moneyCellText(PRICED_AT_CHECKOUT_LABEL, "Unavailable")).toBe(PRICED_AT_CHECKOUT_LABEL);
	});

	test("a fallback that says nothing is not trusted", () => {
		expect(moneyCellText(UNAVAILABLE_LABEL, "—")).toBe(NOT_APPLIED_LABEL);
		expect(moneyCellText("", "")).toBe(NOT_APPLIED_LABEL);
	});

	test("it agrees with sumRowText on the case the two share", () => {
		expect(moneyCellText(NOT_APPLICABLE_LABEL)).toBe(
			sumRowText({ label: "Discount", amount: uncomputed(NOT_APPLICABLE_LABEL) }),
		);
	});
});

describe("isUnpricedText — the value decides, not a flag the caller may forget", () => {
	test("a formatted amount is a figure", () => {
		for (const text of ["$25.00", "−$4.00", "0", "$0.00", "£1,234.50", "٤٠٫٠٠ US$"]) {
			expect(isUnpricedText(text), `text: ${JSON.stringify(text)}`).toBe(false);
		}
	});

	test("prose, a dash and a blank are not", () => {
		for (const text of [PRICED_AT_CHECKOUT_LABEL, NOT_APPLIED_LABEL, "—", "", "   "]) {
			expect(isUnpricedText(text), `text: ${JSON.stringify(text)}`).toBe(true);
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

	test("a row that is merely not APPLICABLE is never NAMED as uncalculated", () => {
		// "no coupon on this order" is not "this store never set discounts up",
		// so the footnote must not blame the discount row. It still admits the
		// gap the flag reports — it just declines to invent a name for it.
		const note = uncalculatedFootnote([subtotal, discount], true) ?? "";
		expect(note).not.toContain("discount");
		expect(note).toMatch(/doesn.t include/);
	});

	test("the flag with no named component still admits the gap", () => {
		// `totalExcludesUncalculated` can be set while none of the rows PASSED IN
		// carries the not-calculated label — a shortened totals block, or a
		// pipeline component this theme does not list yet. Naming nothing is
		// right; saying nothing is not, because a shopper is about to act on an
		// incomplete total.
		const note = uncalculatedFootnote([subtotal], true);
		expect(note).not.toBeNull();
		expect(note).toMatch(/doesn.t include/);
		expect(note).not.toMatch(/undefined|null/);
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
