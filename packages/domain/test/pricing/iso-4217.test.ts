import { describe, expect, test } from "vitest";
import { CURRENCY_CODES, isIsoCurrencyCode } from "../../src/index.js";

/** Codes ICU still lists but a store must not be offered, each with its reason.
 *  The drift test below fails if ICU's list moves in either direction, so a
 *  change of the runtime's currency data is a reviewed edit here, never silent. */
const EXCLUDED_FROM_ICU: Readonly<Record<string, string>> = {
	ANG: "replaced by XCG (Caribbean guilder), 2025",
	BGN: "Bulgaria adopted the euro on 2026-01-01",
	CUC: "withdrawn by Cuba, 2021",
	HRK: "Croatia adopted the euro on 2023-01-01",
	SLL: "redenominated as SLE; withdrawn",
	XDR: "IMF special drawing right — a unit of account, not a cart currency",
	XSU: "ALBA sucre — a clearing unit, not a cart currency",
	ZWL: "replaced by ZWG (Zimbabwe gold), 2024",
};

describe("ISO-4217 membership", () => {
	test("accepts the currencies a store prices in, refuses shapes and non-currencies", () => {
		for (const code of ["USD", "EUR", "GBP", "JPY", "INR", "CHF", "KWD", "XCG", "ZWG"]) {
			expect(isIsoCurrencyCode(code), code).toBe(true);
		}
		for (const code of ["XYZ", "AAA", "usd", "US", "USDD", "", "12$"]) {
			expect(isIsoCurrencyCode(code), code).toBe(false);
		}
	});

	test("withdrawn currencies and fund/accounting units are not offered", () => {
		for (const code of Object.keys(EXCLUDED_FROM_ICU)) {
			expect(isIsoCurrencyCode(code), code).toBe(false);
		}
	});

	// NODE-ONLY DRIFT CHECK. The list is static on purpose (workerd's ICU must not
	// decide a validation rule), so this is where a newer runtime's data is
	// noticed: every listed code is still a currency ICU knows, and every ICU
	// currency is either listed or excluded above with a reason.
	//
	// IF THIS FAILS IN CI, it is almost always the RUNTIME, not the code: the
	// list is a snapshot of ICU 78.3 (Node 22.23), and another Node/ICU build may
	// list a code more or fewer. Fix it in `src/pricing/iso-4217.ts` — add a newly
	// issued currency to `CURRENCY_CODES`, or add a withdrawn/fund code to
	// `EXCLUDED_FROM_ICU` here with its reason — and update the source/date note
	// in that file's header. Never loosen the assertion.
	test.skipIf(typeof Intl.supportedValuesOf !== "function")(
		"matches this runtime's ICU list, modulo the documented exclusions",
		() => {
			const icu = new Set(Intl.supportedValuesOf("currency"));
			expect([...CURRENCY_CODES].filter((code) => !icu.has(code))).toEqual([]);
			expect(
				[...icu].filter((code) => !CURRENCY_CODES.has(code) && !(code in EXCLUDED_FROM_ICU)),
			).toEqual([]);
		},
	);
});
