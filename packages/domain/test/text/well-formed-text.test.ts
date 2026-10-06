import { describe, expect, test } from "vitest";
import {
	findIllFormedText,
	isWellFormedText,
	repairIllFormedText,
	toWellFormedText,
} from "../../src/text/well-formed.js";

/**
 * The text rule Postgres's `jsonb` imposes on every stored document (review
 * R3-B X1): a string is storable unless it holds a LONE UTF-16 surrogate or
 * U+0000. Everything else — controls, noncharacters, astral pairs — is fine,
 * and refusing it would refuse legitimate input for nothing.
 */
const ILL_FORMED: ReadonlyArray<[string, string]> = [
	["a lone high surrogate", "a\uD800b"],
	["a lone high surrogate at the end", "Berlin\uDBFF"],
	["a lone low surrogate", "\uDC00Berlin"],
	["a reversed pair", "\uDE00\uD83D"],
	["a high surrogate followed by a non-surrogate", "\uD83Dx"],
	["NUL", "Ber\u0000lin"],
	["NUL alone", "\u0000"],
];

const WELL_FORMED: ReadonlyArray<[string, string]> = [
	["empty", ""],
	["ASCII", "12 Park Street"],
	["an emoji (a proper surrogate pair)", "caf\u00E9 \uD83D\uDE00"],
	["a flag (two pairs)", "\uD83C\uDDEE\uD83C\uDDF3"],
	["Devanagari with ZWJ", "\u0915\u094D\u200D\u0937"],
	["other C0 controls", "\u0001\u001f\t\n"],
	["DEL and C1", "\u007f\u0085"],
	["noncharacters", "\uFFFE\uFFFF"],
	["U+FFFD itself", "\uFFFD"],
];

describe("isWellFormedText", () => {
	test.each(ILL_FORMED)("%s is not storable", (_label, value) => {
		expect(isWellFormedText(value)).toBe(false);
	});

	test.each(WELL_FORMED)("%s is storable", (_label, value) => {
		expect(isWellFormedText(value)).toBe(true);
	});

	test("agrees with String.prototype.isWellFormed on every surrogate case", () => {
		for (const [, value] of [...ILL_FORMED, ...WELL_FORMED]) {
			if (value.includes("\u0000")) continue;
			// `isWellFormed` is ES2024; the build's lib is ES2023, the runtime has it.
			const native = (value as unknown as { isWellFormed(): boolean }).isWellFormed();
			expect(isWellFormedText(value)).toBe(native);
		}
	});
});

describe("toWellFormedText", () => {
	test("every offending code unit becomes U+FFFD and nothing else moves", () => {
		expect(toWellFormedText("a\uD800b")).toBe("a\uFFFDb");
		expect(toWellFormedText("\uDE00\uD83D")).toBe("\uFFFD\uFFFD");
		expect(toWellFormedText("Ber\u0000lin")).toBe("Ber\uFFFDlin");
		expect(toWellFormedText("caf\u00E9 \uD83D\uDE00")).toBe("caf\u00E9 \uD83D\uDE00");
	});

	test.each([...ILL_FORMED, ...WELL_FORMED])("%s: the output is always storable", (_l, value) => {
		expect(isWellFormedText(toWellFormedText(value))).toBe(true);
		expect(toWellFormedText(value)).toHaveLength(value.length);
	});
});

describe("findIllFormedText", () => {
	test("names the first offending string's path, keys included", () => {
		expect(findIllFormedText({ a: 1, b: ["ok", { city: "x\uD800" }] })).toBe("b[1].city");
		expect(findIllFormedText({ ["k\u0000"]: "v" })).toBe('(key "k\\u0000")');
		expect(findIllFormedText("\uDC00")).toBe("");
	});

	test("a clean value — including non-string leaves — is null", () => {
		expect(
			findIllFormedText({ a: 1, b: null, c: true, d: ["x", { e: "\uD83D\uDE00" }], f: undefined }),
		).toBeNull();
	});
});

describe("repairIllFormedText", () => {
	test("returns the SAME reference when nothing needs repair", () => {
		const doc = { a: "ok", b: [1, { c: "\uD83D\uDE00" }] };
		expect(repairIllFormedText(doc)).toBe(doc);
	});

	test("repairs values and keys in a copy, leaving the input untouched", () => {
		const doc = { a: "ok", b: [1, { city: "x\uD800" }], ["k\u0000"]: "v" };
		const out = repairIllFormedText(doc);
		expect(out).toEqual({ a: "ok", b: [1, { city: "x\uFFFD" }], ["k\uFFFD"]: "v" });
		expect(doc.b[1]).toEqual({ city: "x\uD800" });
		// Untouched branches are shared, not copied.
		expect((out as { a: string }).a).toBe("ok");
	});
});
