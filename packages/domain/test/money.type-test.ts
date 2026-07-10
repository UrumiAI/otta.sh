/**
 * Negative type-level test for branded money (Phase 0 step 0.2a).
 *
 * Checked by `pnpm typecheck`, not vitest: each `@ts-expect-error` must be
 * triggered. If the brand is ever removed, the suppressed error vanishes,
 * tsc reports the unused directive, and typecheck fails.
 */
import { expectTypeOf } from "vitest";
import { cents, currency, type Cents, type Currency } from "../src/money/cents.js";
import {
	idempotencyKey,
	reservationId,
	sku,
	type IdempotencyKey,
	type ProductId,
	type ReservationId,
	type Sku,
} from "../src/money/ids.js";

// @ts-expect-error — a plain number must not be assignable to Cents
const plainNumber: Cents = 500;

// @ts-expect-error — a float must not construct Cents
cents(4.99);

// A dynamic (non-literal) number is allowed at the type level; the
// constructor validates it at runtime instead.
const dynamic: number = 500;
expectTypeOf(cents(dynamic)).toEqualTypeOf<Cents>();

expectTypeOf(cents(500)).toEqualTypeOf<Cents>();

// @ts-expect-error — a plain string must not be assignable to Currency
const plainCurrency: Currency = "USD";

expectTypeOf(currency("USD")).toEqualTypeOf<Currency>();

// @ts-expect-error — a plain string must not be assignable to Sku
const plainSku: Sku = "SKU-1";

// @ts-expect-error — one branded id must not be assignable to another
const crossBrand: ReservationId = idempotencyKey("key-1");

// @ts-expect-error — Cents must not be assignable where a ProductId is expected
const centsAsId: ProductId = cents(500);

expectTypeOf(sku("SKU-1")).toEqualTypeOf<Sku>();
expectTypeOf(idempotencyKey("key-1")).toEqualTypeOf<IdempotencyKey>();
expectTypeOf(reservationId("res-1")).toEqualTypeOf<ReservationId>();

// Reference the consts so oxlint doesn't flag unused locals in this
// deliberately-type-only file.
export const typeOnlyRefs = { plainNumber, plainCurrency, plainSku, crossBrand, centsAsId };
