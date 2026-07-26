import { describe, expect, test } from "vitest";
import { renderBlockerValue } from "../src/product-commerce/commerce-rejection-message.js";
import { commerceSaveBlockers } from "../src/product-commerce/commerce-save-blockers.js";

/** A non-breaking space — whitespace to `String.prototype.trim` and to `\s`,
 *  invisible to a merchant, and accepted verbatim by `parseCommerceFields`. */
const NBSP = " ";

/**
 * The SAVE-BLOCKING predicate (plan §4.1) — deliberately NARROWER than
 * `parseCommerceFields` (the derive guard). It blocks only PRESENT-AND-WRONG
 * values; absence, `""` and cleared inputs are always clean, because those are
 * ordinary widget gestures and blocking them would make legitimately unpriced
 * products permanently unsaveable — strictly worse than the bug this closes.
 */
describe("commerceSaveBlockers — present-and-wrong only", () => {
	test("blocks a decimal price", () => {
		const blockers = commerceSaveBlockers({ price: 24.99 });
		expect(blockers).toHaveLength(1);
		expect(blockers[0]?.field).toBe("price");
		expect(blockers[0]?.value).toBe(24.99);
	});

	test("blocks a negative price", () => {
		expect(commerceSaveBlockers({ price: -5 }).map((b) => b.field)).toEqual(["price"]);
	});

	test("blocks NaN / Infinity / string / null / object / unsafe-integer prices", () => {
		const bad: unknown[] = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			"2499",
			null,
			{},
			[],
			true,
			Number.MAX_SAFE_INTEGER + 2,
		];
		for (const price of bad) {
			expect(commerceSaveBlockers({ price }).map((b) => b.field)).toEqual(["price"]);
		}
		// …and the well-formed values stay clean, INCLUDING zero (parity with the
		// derive guard's `>= 0`; the domain's `price > 0` rule lives in the service).
		for (const price of [0, 1, 2499, Number.MAX_SAFE_INTEGER]) {
			expect(commerceSaveBlockers({ price })).toEqual([]);
		}
	});

	test("does NOT block an absent price (the `{currency:'USD'}` gesture stays saveable)", () => {
		expect(commerceSaveBlockers({ sku: "S", currency: "USD" })).toEqual([]);
		expect(commerceSaveBlockers({ currency: "USD" })).toEqual([]);
	});

	test("does NOT block a cleared price — the documented escape hatch", () => {
		// The number input emits `undefined` when cleared, which JSON.stringify
		// drops entirely. Both spellings must be clean so a merchant can ALWAYS
		// get an entry back to a saveable state without knowing the right number.
		const roundTripped: unknown = JSON.parse(JSON.stringify({ price: undefined, currency: "USD" }));
		expect(commerceSaveBlockers(roundTripped)).toEqual([]);
		expect(commerceSaveBlockers({ price: undefined, currency: "USD" })).toEqual([]);
	});

	test("does NOT block a placeholder currency / productKind", () => {
		expect(commerceSaveBlockers({ price: 2499, currency: "" })).toEqual([]);
		expect(commerceSaveBlockers({ productKind: "" })).toEqual([]);
	});

	test("blocks a malformed currency", () => {
		for (const currency of ["usd", "US", "USDD", "U$D", 840]) {
			expect(commerceSaveBlockers({ price: 2499, currency }).map((b) => b.field)).toEqual([
				"currency",
			]);
		}
	});

	test("blocks a malformed sku: control chars, newline, over-length, non-string", () => {
		const bad: unknown[] = [
			"S\u0000K",
			"S\u007FK",
			"line1\nline2",
			"tab\there",
			"S".repeat(129),
			42,
			{},
			true,
		];
		for (const sku of bad) {
			expect(commerceSaveBlockers({ sku }).map((b) => b.field)).toEqual(["sku"]);
		}
		// Absent and explicitly-empty are clean — a product may legitimately have
		// no sku (afterSave simply skips the upsert).
		expect(commerceSaveBlockers({ sku: "" })).toEqual([]);
		expect(commerceSaveBlockers({ price: 2499 })).toEqual([]);
		expect(commerceSaveBlockers({ sku: "S".repeat(128) })).toEqual([]);
	});

	test("blocks a WHITESPACE-ONLY sku, and renders the offending value VISIBLY", () => {
		// `parse-commerce-fields.ts:51-52` accepts ANY non-empty string, so "   "
		// would be derived and PUT to the service as a real SKU — the same
		// silent-bad-write class this PR exists to close.
		for (const sku of [" ", "   ", "\t ", NBSP]) {
			const blockers = commerceSaveBlockers({ sku });
			expect(blockers).toHaveLength(1);
			expect(blockers[0]?.field).toBe("sku");
			expect(blockers[0]?.expected).toContain("SKU cannot be blank");
			// Rendered visibly — never an invisible empty string in the message.
			const rendered = renderBlockerValue(blockers[0]?.value);
			expect(rendered.trim().length).toBeGreaterThan(0);
		}
		// We never auto-trim: a padded but non-blank sku is the merchant's value
		// and stays saveable (parse-commerce-fields keeps its semantics untouched).
		expect(commerceSaveBlockers({ sku: " S-1 " })).toEqual([]);
	});

	test("blocks present-and-wrong stock, dimensions, kind and tax class only", () => {
		expect(commerceSaveBlockers({ onHand: -1 }).map((b) => b.field)).toEqual(["onHand"]);
		expect(commerceSaveBlockers({ weightGrams: 1.5 }).map((b) => b.field)).toEqual(["weightGrams"]);
		for (const field of ["lengthMm", "widthMm", "heightMm"]) {
			expect(commerceSaveBlockers({ [field]: "10" }).map((b) => b.field)).toEqual([field]);
		}
		expect(commerceSaveBlockers({ productKind: "gaseous" }).map((b) => b.field)).toEqual([
			"productKind",
		]);
		expect(commerceSaveBlockers({ taxClass: 7 }).map((b) => b.field)).toEqual(["taxClass"]);
		// Absent / well-formed → clean.
		expect(commerceSaveBlockers({ onHand: 0, weightGrams: 500, lengthMm: 10 })).toEqual([]);
		expect(commerceSaveBlockers({ productKind: "digital", taxClass: "standard" })).toEqual([]);
	});

	test("a non-object / array / missing bag is a clean no-op", () => {
		for (const bag of [undefined, null, [], "x", 7, true]) {
			expect(commerceSaveBlockers(bag)).toEqual([]);
		}
	});

	test("an all-empty bag is clean — unpriced products stay saveable", () => {
		expect(commerceSaveBlockers({})).toEqual([]);
		expect(commerceSaveBlockers({ sku: "", currency: "", productKind: "", taxClass: "" })).toEqual(
			[],
		);
	});
});
