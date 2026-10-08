/**
 * The Pricing & stock cards' decisions, as pure functions (ADR-0014, amendment
 * 2026-10-01). Everything the cards decide about money and stock lives in
 * `pricing-model.ts` so it is proven here without a document; the DOM suite
 * only proves the wiring.
 */
import { currencyChoicesWith } from "@otta-sh/admin-presentation";
import { describe, expect, test } from "vitest";
import type { ProductRecord } from "../src/console-api.js";
import {
	CURRENCY_CHOICES,
	currencyChoiceLabel,
	draftFromRecord,
	isDraftDirty,
	marginSummary,
	mergeDraft,
	salePreview,
	savePayload,
	stockStatus,
	validateDraft,
} from "../src/products/pricing-model.js";

const BASE: ProductRecord = {
	productId: "p_tee",
	sku: "OTTA-TEE",
	title: "Otta Tee",
	priceCents: 3200,
	currency: "USD",
	taxClass: "standard",
	compareAtCents: 4000,
	compareAtCurrency: "USD",
	unitCostCents: 1250,
	unitCostCurrency: "USD",
	inventoryPolicy: "deny",
	weightGrams: 200,
	lengthMm: null,
	widthMm: null,
	heightMm: null,
	productKind: "physical",
	active: true,
	deletedAt: null,
	onHand: 24,
	createdAt: "2026-09-01T09:00:00.000Z",
	updatedAt: "2026-09-30T10:00:00.000Z",
};

describe("the draft", () => {
	test("is the record as the inputs show it: money as decimals, blanks for unset", () => {
		expect(draftFromRecord(BASE)).toEqual({
			price: "32.00",
			currency: "USD",
			compareAt: "40.00",
			unitCost: "12.50",
			sku: "OTTA-TEE",
			productKind: "physical",
			taxClass: "standard",
			taxStatus: "taxable",
			weightGrams: "200",
			lengthMm: "",
			widthMm: "",
			heightMm: "",
		});
	});

	test("an unpriced product offers USD until the merchant picks another currency", () => {
		const draft = draftFromRecord({
			...BASE,
			priceCents: null,
			currency: null,
			compareAtCents: null,
			unitCostCents: null,
		});
		expect(draft.price).toBe("");
		expect(draft.currency).toBe("USD");
	});

	test("an unpriced product starts on the store currency when the detail read carried one; a priced one keeps its own", () => {
		const unpriced: ProductRecord = {
			...BASE,
			priceCents: null,
			currency: null,
			compareAtCents: null,
			unitCostCents: null,
		};
		expect(draftFromRecord(unpriced, "EUR").currency).toBe("EUR");
		expect(draftFromRecord(BASE, "EUR").currency).toBe(BASE.currency);
	});

	test("the picker offers a saved code the table no longer lists, first, so the select has a matching option", () => {
		expect(currencyChoicesWith("USD")).toBe(CURRENCY_CHOICES);
		expect(currencyChoicesWith("XYZ")).toEqual(["XYZ", ...CURRENCY_CHOICES]);
		// Nothing chosen yet adds nothing.
		expect(currencyChoicesWith("")).toBe(CURRENCY_CHOICES);
	});

	test("a JPY product's amounts are WHOLE YEN, both ways: 1500 shows as 1500 and '1500' saves as 1500", () => {
		const jpy: ProductRecord = {
			...BASE,
			priceCents: 1500,
			currency: "JPY",
			compareAtCents: 2000,
			compareAtCurrency: "JPY",
			unitCostCents: 900,
			unitCostCurrency: "JPY",
		};
		const draft = draftFromRecord(jpy);
		expect(draft.price).toBe("1500");
		expect(draft.compareAt).toBe("2000");
		expect(validateDraft(draft, jpy)).toEqual({});
		expect(savePayload(jpy, { ...draft, price: " 1600 " })).toMatchObject({
			price: "1600",
			currency: "JPY",
		});
		// A fraction of a yen is a problem quoted in the currency's own shape.
		expect(validateDraft({ ...draft, price: "15.50" }, jpy).price).toBe("Enter a price like 2499");
		expect(isDraftDirty(draft, { ...draft, price: "1500" })).toBe(false);
	});

	test("a first pricing in JPY reads the picked currency, and every offered currency is supported", () => {
		const unpriced: ProductRecord = {
			...BASE,
			priceCents: null,
			currency: null,
			compareAtCents: null,
			unitCostCents: null,
		};
		const draft = { ...draftFromRecord(unpriced), price: "1500", currency: "JPY" };
		expect(validateDraft(draft, unpriced)).toEqual({});
		expect(savePayload(unpriced, draft)).toMatchObject({ price: "1500", currency: "JPY" });
		expect(validateDraft({ ...draft, currency: "XYZ" }, unpriced).currency).toBe(
			"Choose a supported currency",
		);
		expect(CURRENCY_CHOICES.slice(0, 3)).toEqual(["USD", "EUR", "GBP"]);
		expect(CURRENCY_CHOICES).toContain("JPY");
		expect(CURRENCY_CHOICES).toContain("KWD");
		expect(new Set(CURRENCY_CHOICES).size).toBe(CURRENCY_CHOICES.length);
		expect(currencyChoiceLabel("JPY")).toBe("JPY — Japanese Yen");
	});

	test("is dirty only when a value differs, and `32` vs `32.00` is not a difference", () => {
		const saved = draftFromRecord(BASE);
		expect(isDraftDirty(saved, { ...saved })).toBe(false);
		expect(isDraftDirty(saved, { ...saved, price: "32" })).toBe(false);
		expect(isDraftDirty(saved, { ...saved, price: "31.99" })).toBe(true);
		expect(isDraftDirty(saved, { ...saved, sku: " OTTA-TEE " })).toBe(false);
	});
});

describe("validation, in the merchant's words", () => {
	test("a valid draft has no problems", () => {
		expect(validateDraft(draftFromRecord(BASE), BASE)).toEqual({});
	});

	test("money must look like money", () => {
		const draft = { ...draftFromRecord(BASE), price: "32,00", unitCost: "abc" };
		expect(validateDraft(draft, BASE)).toEqual({
			price: "Enter a price like 24.99",
			unitCost: "Enter an amount like 9.50",
		});
	});

	test("a price of zero is refused — a free product is not something checkout can sell", () => {
		expect(validateDraft({ ...draftFromRecord(BASE), price: "0" }, BASE).price).toBe(
			"Enter a price like 24.99",
		);
	});

	test("a compare-at price must be HIGHER than the price, or it is not a sale", () => {
		expect(validateDraft({ ...draftFromRecord(BASE), compareAt: "32.00" }, BASE).compareAt).toBe(
			"Must be higher than the price to show a sale",
		);
	});

	test("a compare-at price or a cost needs a price to belong to", () => {
		const unpriced = {
			...BASE,
			priceCents: null,
			currency: null,
			compareAtCents: null,
			unitCostCents: null,
		};
		const draft = { ...draftFromRecord(unpriced), compareAt: "40" };
		expect(validateDraft(draft, unpriced).price).toBe("Add a price first");
	});

	test("weights and sizes are whole numbers", () => {
		expect(validateDraft({ ...draftFromRecord(BASE), weightGrams: "1.5" }, BASE).weightGrams).toBe(
			"Use a whole number",
		);
	});
});

describe("a value the store cannot clear is never offered as cleared", () => {
	// The plugin's save reads a BLANK price, SKU, weight or size as "keep what is
	// stored". A panel that let the merchant blank one would answer "Saved" and
	// then put the old value back. Compare-at, cost and tax class DO clear.
	test.each([
		["price", "A product that has a price needs one — enter the new price"],
		["sku", "A SKU can be changed but not removed"],
		["weightGrams", "Can be changed but not removed"],
		["lengthMm", "Can be changed but not removed"],
	] as const)("blanking %s is refused in words", (field, message) => {
		const record = { ...BASE, lengthMm: 300 };
		expect(validateDraft({ ...draftFromRecord(record), [field]: " " }, record)[field]).toBe(
			message,
		);
	});

	test("blanking compare-at or cost is a real clear, and allowed", () => {
		expect(validateDraft({ ...draftFromRecord(BASE), compareAt: "", unitCost: "" }, BASE)).toEqual(
			{},
		);
	});

	test("a currency picked for a product that still has no price changes nothing to save", () => {
		const unpriced = {
			...BASE,
			priceCents: null,
			currency: null,
			compareAtCents: null,
			unitCostCents: null,
		};
		const saved = draftFromRecord(unpriced);
		expect(isDraftDirty(saved, { ...saved, currency: "EUR" })).toBe(false);
		expect(isDraftDirty(saved, { ...saved, currency: "EUR", price: "18" })).toBe(true);
	});
});

describe("a re-read keeps only what the merchant changed", () => {
	test("untouched fields take the newer record's values", () => {
		const newer = { ...BASE, weightGrams: 450, updatedAt: "2026-10-01T09:00:00.000Z" };
		const draft = { ...draftFromRecord(BASE), price: "30.00" };
		expect(mergeDraft(BASE, newer, draft)).toEqual({
			draft: { ...draftFromRecord(newer), price: "30.00" },
			conflict: false,
		});
	});

	test("a field changed on BOTH sides is a conflict: the store wins that field, the merchant keeps the rest", () => {
		const newer = { ...BASE, priceCents: 3500, updatedAt: "2026-10-01T09:00:00.000Z" };
		const draft = { ...draftFromRecord(BASE), price: "30.00", sku: "TEE-2" };
		expect(mergeDraft(BASE, newer, draft)).toEqual({
			draft: { ...draftFromRecord(newer), sku: "TEE-2" },
			conflict: true,
		});
	});
});

describe("a digital product ships nothing", () => {
	test("its hidden weight and size are neither checked nor sent", () => {
		const record = { ...BASE, productKind: "digital", weightGrams: 200 };
		const draft = { ...draftFromRecord(record), weightGrams: "", lengthMm: "abc" };
		expect(validateDraft(draft, record)).toEqual({});
		expect(savePayload(record, draft)).toMatchObject({ weightGrams: "", lengthMm: "" });
		// Not a change either, so the panel never says "Saved" for something it dropped.
		expect(isDraftDirty(draftFromRecord(record), draft)).toBe(false);
	});
});

describe("what the merchant sees beside the numbers", () => {
	test("profit and margin, from price and cost", () => {
		expect(marginSummary("32.00", "12.50", "USD")).toEqual({ profit: "$19.50", margin: "61%" });
		expect(marginSummary("32.00", "", "USD")).toBeNull();
		expect(marginSummary("", "12.50", "USD")).toBeNull();
	});

	test("a cost above the price is a loss, said as one", () => {
		expect(marginSummary("10.00", "12.50", "USD")).toEqual({ profit: "−$2.50", margin: "−25%" });
	});

	test("the sale preview shows the was and now prices only for a real sale", () => {
		expect(salePreview("32.00", "40.00", "USD")).toEqual({ was: "$40.00", now: "$32.00" });
		expect(salePreview("32.00", "", "USD")).toBeNull();
		expect(salePreview("32.00", "30.00", "USD")).toBeNull();
	});

	test("stock reads as a status a shop owner recognises", () => {
		expect(stockStatus(24, 5)).toEqual({ tone: "ok", label: "In stock" });
		expect(stockStatus(5, 5)).toEqual({ tone: "warn", label: "Low stock" });
		expect(stockStatus(0, 5)).toEqual({ tone: "fail", label: "Out of stock" });
		// No inventory record is UNKNOWN, never zero.
		expect(stockStatus(null, 5)).toEqual({ tone: "none", label: "Not tracked" });
		// No threshold configured: only zero is a warning.
		expect(stockStatus(2, null)).toEqual({ tone: "ok", label: "In stock" });
	});
});

describe("the save", () => {
	test("sends every field the panel owns, with the watermark the panel loaded", () => {
		expect(savePayload(BASE, draftFromRecord(BASE))).toEqual({
			productId: "p_tee",
			expectedUpdatedAt: "2026-09-30T10:00:00.000Z",
			sku: "OTTA-TEE",
			price: "32.00",
			currency: "USD",
			compareAt: "40.00",
			unitCost: "12.50",
			productKind: "physical",
			taxClass: "standard",
			taxStatus: "taxable",
			weightGrams: "200",
			lengthMm: "",
			widthMm: "",
			heightMm: "",
		});
	});

	test("the tax status rides with the save; a record without one reads taxable (PR 2b)", () => {
		expect(draftFromRecord({ ...BASE, taxStatus: "none" }).taxStatus).toBe("none");
		const draft = { ...draftFromRecord(BASE), taxStatus: "shipping_only" };
		expect(savePayload(BASE, draft).taxStatus).toBe("shipping_only");
	});

	test("a cleared compare-at is sent BLANK, which is how the plugin clears it", () => {
		const draft = { ...draftFromRecord(BASE), compareAt: "  " };
		expect(savePayload(BASE, draft).compareAt).toBe("");
	});

	test("an unpriced product sends the currency the merchant picked", () => {
		const unpriced = {
			...BASE,
			priceCents: null,
			currency: null,
			compareAtCents: null,
			unitCostCents: null,
		};
		const draft = { ...draftFromRecord(unpriced), price: "18", currency: "EUR" };
		expect(savePayload(unpriced, draft)).toMatchObject({ price: "18.00", currency: "EUR" });
	});

	test("never carries a title or a status — those are the CMS's (ADR-0013)", () => {
		const payload = savePayload(BASE, draftFromRecord(BASE));
		expect(payload).not.toHaveProperty("title");
		expect(payload).not.toHaveProperty("active");
	});
});
