import { describe, expect, test } from "vitest";
import { cents as domainCents, currency as domainCurrency } from "@otta-sh/domain";
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
