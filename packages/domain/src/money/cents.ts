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

declare const SignedCentsBrand: unique symbol;
/**
 * A SIGNED integer number of minor units — an adjustment, never a price or a
 * total: today only the checkout's rounding line (ADR-0033's amendment), which
 * is negative when the final total rounds down. `Cents` stays non-negative; a
 * `SignedCents` is not assignable to it, so an adjustment can never be stored as
 * an amount by accident. `signedCents()` is the only way to mint one.
 */
export type SignedCents = number & { readonly [SignedCentsBrand]: true };

/** Mint a {@link SignedCents}: any safe integer, negative included. */
export function signedCents(n: number): SignedCents {
	if (!Number.isSafeInteger(n)) {
		throw new RangeError(`signedCents() requires a safe integer, got ${String(n)}`);
	}
	return n as SignedCents;
}

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

/** ISO 4217's alphabetic SHAPE (three upper-case letters) — not membership in
 *  the currency table. The one copy of the shape in the domain. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function currency(code: string): Currency {
	if (!CURRENCY_PATTERN.test(code)) {
		throw new RangeError(`currency() requires an ISO-4217 alpha code, got "${code}"`);
	}
	return code as Currency;
}

export function money(amount: Cents, currencyCode: Currency): Money {
	return { amount, currency: currencyCode };
}
