import { describe, expect, test } from "vitest";
import {
	SUPPORTED_CURRENCIES as ADMIN_CURRENCIES,
	DEFAULT_STORE_CURRENCY as ADMIN_DEFAULT_STORE_CURRENCY,
	checkoutPaymentWarning as adminCheckoutPaymentWarning,
	currencyDigits as adminCurrencyDigits,
	isSupportedCurrency as adminIsSupported,
	minorUnitDigits as adminMinorUnitDigits,
	checkoutPaymentWarning,
} from "@otta-sh/admin-presentation";
import {
	SUPPORTED_CURRENCIES as DOMAIN_CURRENCIES,
	DEFAULT_STORE_CURRENCY as DOMAIN_DEFAULT_STORE_CURRENCY,
	isCheckoutPayableCurrency as domainIsCheckoutPayable,
	cents as domainCents,
	currency as domainCurrency,
	currencyDigits as domainCurrencyDigits,
	isSupportedCurrency as domainIsSupported,
	minorUnitDigits as domainMinorUnitDigits,
} from "@otta-sh/domain";
import { stripeRefusesCurrency } from "@otta-sh/payments-stripe";
import { cents as pluginCents, currency as pluginCurrency } from "../src/presentation/money.js";

/**
 * Drift guard for the money-brand MIRROR (review B3, both reviewers):
 * `plugin/src/presentation/money.ts` deliberately re-declares
 * `@otta-sh/domain`'s `cents()`/`currency()` instead of importing them (see
 * that file's header for why). This test imports BOTH — test files run in
 * Node with workspace resolution and are never bundled by the sandbox
 * harness (it copies `src/` only) — and pins that the two implementations
 * accept and reject IDENTICALLY, so the mirror cannot drift silently.
 * Reciprocal pointers live on both modules' headers.
 */

/** Runs fn and captures outcome: accepted value or rejection marker+message. */
function outcome(fn: () => unknown): { ok: boolean; value?: unknown; error?: string } {
	try {
		return { ok: true, value: fn() };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? `${err.name}` : String(err) };
	}
}

describe("money mirror parity (plugin/presentation/money.ts ⇄ domain/money/cents.ts)", () => {
	const amountInputs: Array<{ label: string; value: number }> = [
		{ label: "zero", value: 0 },
		{ label: "small integer", value: 1 },
		{ label: "typical price", value: 1999 },
		{ label: "MAX_SAFE_INTEGER", value: Number.MAX_SAFE_INTEGER },
		{ label: "float", value: 4.99 },
		{ label: "tiny float", value: 0.1 },
		{ label: "negative integer", value: -1 },
		{ label: "negative float", value: -4.99 },
		{ label: "unsafe integer (2^53)", value: 2 ** 53 },
		{ label: "NaN", value: Number.NaN },
		{ label: "Infinity", value: Number.POSITIVE_INFINITY },
		{ label: "-Infinity", value: Number.NEGATIVE_INFINITY },
	];

	test.each(amountInputs)("cents() parity: $label", ({ value }) => {
		const domain = outcome(() => domainCents(value));
		const plugin = outcome(() => pluginCents(value));
		expect(plugin.ok).toBe(domain.ok);
		if (domain.ok) {
			expect(plugin.value).toBe(domain.value);
		} else {
			// Same error CLASS (RangeError) — messages may drift wording, the
			// accept/reject semantics may not.
			expect(plugin.error).toBe(domain.error);
		}
	});

	const currencyInputs: Array<{ label: string; value: string }> = [
		{ label: "valid USD", value: "USD" },
		{ label: "valid EUR", value: "EUR" },
		{ label: "valid zero-decimal JPY", value: "JPY" },
		{ label: "lowercase", value: "usd" },
		{ label: "mixed case", value: "UsD" },
		{ label: "too short", value: "US" },
		{ label: "too long", value: "USDD" },
		{ label: "empty", value: "" },
		{ label: "symbol", value: "€" },
		{ label: "digits", value: "123" },
		{ label: "whitespace-padded", value: " USD" },
	];

	test.each(currencyInputs)("currency() parity: $label", ({ value }) => {
		const domain = outcome(() => domainCurrency(value));
		const plugin = outcome(() => pluginCurrency(value));
		expect(plugin.ok).toBe(domain.ok);
		if (domain.ok) {
			expect(plugin.value).toBe(domain.value);
		} else {
			expect(plugin.error).toBe(domain.error);
		}
	});
});

/**
 * The CURRENCY TABLE has the same mirror: `@otta-sh/domain`'s
 * `money/currencies.ts` is canonical, `@otta-sh/admin-presentation`'s
 * `currencies.ts` is its copy (the admin surfaces cannot import the domain).
 * Deep equality here is what makes the pair ONE source of truth: a row added,
 * removed or changed in one file and not the other fails this test.
 */
describe("currency table mirror parity (admin-presentation/currencies.ts ⇄ domain/money/currencies.ts)", () => {
	test("the two tables are identical, row for row and in order", () => {
		expect(ADMIN_CURRENCIES).toEqual(DOMAIN_CURRENCIES);
	});

	test("the admin's checkout warning and the domain's payability agree on every listed code", () => {
		for (const { code } of DOMAIN_CURRENCIES) {
			expect(adminCheckoutPaymentWarning(code) === null, code).toBe(domainIsCheckoutPayable(code));
		}
	});

	test("the never-saved store currency is the same in both", () => {
		expect(ADMIN_DEFAULT_STORE_CURRENCY).toBe(DOMAIN_DEFAULT_STORE_CURRENCY);
	});

	test("the helpers agree on every listed code and on unlisted ones", () => {
		const probes = [
			...DOMAIN_CURRENCIES.map((row) => row.code),
			"XYZ",
			"usd",
			"",
			"LKR",
			"UGX",
			"ISK",
			"ALL",
			"CLF",
		];
		for (const code of probes) {
			expect(adminIsSupported(code), code).toBe(domainIsSupported(code));
			expect(adminCurrencyDigits(code), code).toBe(domainCurrencyDigits(code));
			// The DISPLAY exponent (table → ICU → 2): the domain's refund flags and
			// the admin's `formatMoney` must print one amount the same way.
			expect(adminMinorUnitDigits(code), code).toBe(domainMinorUnitDigits(code));
		}
	});
});

describe("the admin's 'not yet payable at checkout' warning names exactly what Stripe refuses", () => {
	test("for every listed currency, warned ⇔ refused by the live Stripe path", () => {
		for (const row of DOMAIN_CURRENCIES) {
			expect(checkoutPaymentWarning(row.code) !== null, row.code).toBe(
				stripeRefusesCurrency(row.code),
			);
		}
		expect(checkoutPaymentWarning("KWD")).toMatch(/not yet payable at checkout/);
		expect(checkoutPaymentWarning("USD")).toBeNull();
		expect(checkoutPaymentWarning("JPY")).toBeNull();
	});
});
