import { cents, type Cents } from "@otta-sh/domain";

/**
 * US cents ↔ USDC atomic units (ADR-0028 Decision 3): exact, integer, no floats.
 *
 * USDC has 6 decimals and a cent has 2, so one cent is 10^4 atomic units. The
 * arithmetic is `BigInt` because `cents * 10_000` as a `number` loses precision
 * once it passes 2^53 — about 9 × 10^11 cents, a price no store charges but a
 * bound this code must not depend on nobody reaching.
 */
const ATOMIC_PER_CENT = 10_000n;

/** The wire's `amount` / `value` grammar: a positive base-10 integer with no
 *  sign, no leading zero, no exponent, at most 31 digits. */
const ATOMIC_AMOUNT = /^[1-9][0-9]{0,30}$/u;

/** `cents` as a base-10 atomic-unit string. */
export function centsToAtomic(amount: Cents): string {
	return (BigInt(amount) * ATOMIC_PER_CENT).toString(10);
}

/**
 * A wire atomic amount back to the exact `Cents` the domain compares, or
 * `undefined`. Never rounds: a value that is not a whole number of cents, or
 * whose cents are not a safe integer, is refused rather than made "close enough".
 */
export function atomicToCents(value: unknown): Cents | undefined {
	if (typeof value !== "string" || !ATOMIC_AMOUNT.test(value)) return undefined;
	const atomic = BigInt(value);
	if (atomic % ATOMIC_PER_CENT !== 0n) return undefined;
	const whole = atomic / ATOMIC_PER_CENT;
	if (whole > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
	return cents(Number(whole));
}
