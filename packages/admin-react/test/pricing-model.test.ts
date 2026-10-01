/**
 * The Pricing & stock panel's decisions, as pure functions (ADR-0014, amendment
 * 2026-10-01). Everything the panel decides about money and stock lives in
 * `pricing-model.ts` so it is proven here without a document; the DOM suite
 * only proves the wiring.
 */
import { describe, expect, test } from "vitest";
import type { ProductRecord } from "../src/console-api.js";
import {
	draftFromRecord,
	isDraftDirty,
	marginSummary,
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
		expect(validateDraft(draftFromRecord(BASE))).toEqual({});
	});

	test("money must look like money", () => {
		const draft = { ...draftFromRecord(BASE), price: "32,00", unitCost: "abc" };
		expect(validateDraft(draft)).toEqual({
			price: "Enter a price like 24.99",
			unitCost: "Enter an amount like 9.50",
		});
	});

	test("a price of zero is refused — a free product is not something checkout can sell", () => {
		expect(validateDraft({ ...draftFromRecord(BASE), price: "0" }).price).toBe(
			"Enter a price like 24.99",
		);
	});

	test("a compare-at price must be HIGHER than the price, or it is not a sale", () => {
		expect(validateDraft({ ...draftFromRecord(BASE), compareAt: "32.00" }).compareAt).toBe(
			"Must be higher than the price to show a sale",
		);
	});

	test("a compare-at price or a cost needs a price to belong to", () => {
		const draft = { ...draftFromRecord(BASE), price: "", compareAt: "40", unitCost: "" };
		expect(validateDraft(draft).price).toBe("Add a price first");
	});

	test("weights and sizes are whole numbers", () => {
		expect(validateDraft({ ...draftFromRecord(BASE), weightGrams: "1.5" }).weightGrams).toBe(
			"Use a whole number",
		);
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
			weightGrams: "200",
			lengthMm: "",
			widthMm: "",
			heightMm: "",
		});
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
