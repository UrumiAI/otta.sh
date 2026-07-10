/**
 * Negative type-level test for product-commerce money integrity (Phase 1 step
 * 2 / DoD). Checked by `pnpm typecheck`, not vitest — mirrors
 * `money.type-test.ts`.
 */
import { expectTypeOf } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { productId, sku } from "../src/money/ids.js";
import type { UpsertProductCommerceInput } from "../src/ports/product-commerce-store.js";

const validInput: UpsertProductCommerceInput = {
	productId: productId("prod-1"),
	sku: sku("SKU-1"),
	price: money(cents(500), currency("USD")),
};
expectTypeOf(validInput).toEqualTypeOf<UpsertProductCommerceInput>();

const badInput: UpsertProductCommerceInput = {
	productId: productId("prod-1"),
	// @ts-expect-error — price must be branded Money, not a raw number
	price: 500,
};

const badAmount: UpsertProductCommerceInput = {
	productId: productId("prod-1"),
	// @ts-expect-error — price.amount must be branded Cents, not a raw number literal
	price: { amount: 500, currency: currency("USD") },
};

// Reference the consts so oxlint doesn't flag unused locals in this
// deliberately-type-only file.
export const typeOnlyRefs = { badInput, badAmount };
