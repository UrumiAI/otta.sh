/**
 * Money is integer minor units, never floats (DEVELOPMENT.md §4).
 *
 * `Cents` is a branded number: a plain `number` reaching a money field is a
 * type error, and `cents()` is the only way to mint one. Amounts always
 * travel with an explicit `Currency`.
 *
 * MIRRORED by `@otta-sh/plugin`'s `src/presentation/money.ts` (see its header
 * for why it does not import this module) — behavior parity between the two
 * is pinned by `packages/plugin/test/money-parity.test.ts`. Change the
 * accept/reject semantics of `cents()`/`currency()` in BOTH places together.
 */

declare const CentsBrand: unique symbol;
export type Cents = number & { readonly [CentsBrand]: true };

declare const CurrencyBrand: unique symbol;
/** ISO-4217 alpha code (e.g. "USD"), branded. */
export type Currency = string & { readonly [CurrencyBrand]: true };

export interface Money {
	readonly amount: Cents;
	readonly currency: Currency;
}

/**
 * Rejects float *literals* at compile time (`cents(4.99)` does not compile)
 * while still accepting dynamic `number` values, which are validated at
 * runtime instead.
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

export function money(amount: Cents, currencyCode: Currency): Money {
	return { amount, currency: currencyCode };
}
