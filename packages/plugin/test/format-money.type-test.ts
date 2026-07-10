/**
 * Negative type-level test for `formatMoney` (Phase 2 §7 step 7, mirroring
 * Phase 0's `Cents` type-test): a bare `number`/`string` must NOT format —
 * this function is the plugin's ONE sanctioned money→display boundary
 * (§4.6), and it accepts only the branded types the domain defines.
 *
 * Checked by `pnpm typecheck`, not vitest: each `@ts-expect-error` must be
 * triggered. If the brand ever stops being required, the suppressed error
 * vanishes, tsc reports the unused directive, and typecheck fails.
 */
import { expectTypeOf } from "vitest";
import { cents, currency } from "../src/presentation/money.js";
import { formatMoney, majorUnits } from "../src/presentation/format-money.js";

// @ts-expect-error — a raw number amount must not format
formatMoney(1999, currency("USD"), "en-US");

// @ts-expect-error — a raw string currency must not format
formatMoney(cents(1999), "USD", "en-US");

// @ts-expect-error — a float literal cannot even mint the Cents to format
formatMoney(cents(19.99), currency("USD"), "en-US");

// @ts-expect-error — the JSON-LD price path is gated by the same brands
majorUnits(1999, currency("USD"));

// @ts-expect-error — ...on both parameters
majorUnits(cents(1999), "USD");

// The branded happy path compiles and returns a plain display string.
expectTypeOf(formatMoney(cents(1999), currency("USD"), "en-US")).toEqualTypeOf<string>();
expectTypeOf(majorUnits(cents(1999), currency("USD"))).toEqualTypeOf<string>();
