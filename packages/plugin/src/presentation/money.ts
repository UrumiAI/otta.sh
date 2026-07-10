/**
 * The plugin's OWN branded money types — a deliberate, documented mirror of
 * `@urumi/domain`'s `money/cents.ts` (same brands, same constructors, same
 * float-literal rejection), NOT an import of it.
 *
 * Why not import: OUR OWN sandbox test harness (`test/sandbox/harness.ts`)
 * deliberately bundles `sandbox-entry.ts` from a bare copy of `src/` with
 * no workspace `node_modules` — a design choice of the harness (it pins
 * that the shipped bundle is self-contained), not an inherent platform
 * constraint (a bundler CAN inline a workspace dependency). Given that
 * choice, plus ADR-0001/0002's rule that the plugin reaches commerce truth
 * ONLY over HTTP (`ctx.http`) and never by linking domain code, `src/`
 * keeps zero runtime workspace imports — the same standalone discipline as
 * `types.ts`'s mirror of the em-dash plugin surface. The two `Cents` types
 * are intentionally NOT cross-assignable — a value crosses the wire as an
 * integer and is re-validated/re-branded here at the plugin edge
 * (`catalog/commerce-view.ts`), so each side's brand proves ITS OWN
 * validation ran, not the other's. Behavior parity with the domain module
 * is pinned by `test/money-parity.test.ts` (test files run in Node with
 * workspace resolution and are never sandbox-bundled, so importing BOTH
 * there is safe) — change accept/reject semantics in both places together.
 *
 * Money is integer minor units, never floats (DEVELOPMENT.md §4): `cents()`
 * is the only mint, and a raw `number` reaching a branded field is a type
 * error (pinned by `test/format-money.type-test.ts`).
 */

declare const CentsBrand: unique symbol;
export type Cents = number & { readonly [CentsBrand]: true };

declare const CurrencyBrand: unique symbol;
/** ISO-4217 alpha code (e.g. "USD"), branded. */
export type Currency = string & { readonly [CurrencyBrand]: true };

/**
 * Rejects float *literals* at compile time (`cents(4.99)` does not compile)
 * while still accepting dynamic `number` values — e.g. wire-parsed amounts —
 * which are validated at runtime instead.
 */
type IntegerLiteral<N extends number> = `${N}` extends `${bigint}` ? N : never;

export function cents<N extends number>(n: number extends N ? N : IntegerLiteral<N>): Cents {
	if (!Number.isSafeInteger(n)) {
		throw new RangeError(`cents() requires a safe integer, got ${String(n)}`);
	}
	if (n < 0) {
		throw new RangeError(`cents() requires a non-negative amount, got ${String(n)}`);
	}
	return n as number as Cents;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function currency(code: string): Currency {
	if (!CURRENCY_PATTERN.test(code)) {
		throw new RangeError(`currency() requires an ISO-4217 alpha code, got "${code}"`);
	}
	return code as Currency;
}
