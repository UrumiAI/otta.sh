/**
 * Negative type-level test for product-commerce money integrity (Phase 1 step
 * 2 / DoD). Checked by `pnpm typecheck`, not vitest — mirrors
 * `money.type-test.ts`.
 */
import { expectTypeOf } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { productId, sku } from "../src/money/ids.js";
import type {
	UpdateProductCommerceFieldsInput,
	UpdateProductVariantFieldsInput,
	UpsertProductCommerceInput,
	UpsertProductVariantInput,
} from "../src/ports/product-commerce-store.js";

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

/**
 * ADR-0013 rung 2 — the compile-time half of "title has exactly one writer".
 *
 * `title` is CMS-owned: the ONLY channel that may write `product_commerce.title`
 * is the content sync's `upsert` (see `UpsertProductCommerceInput.title`, still
 * present above). The guarded admin edit must not carry it, so re-adding a Title
 * input to the admin form fails to COMPILE rather than failing silently at
 * runtime. Rung 1 is the port type itself; rung 3 is the `.strict()`-backed HTTP
 * test in `packages/service/test/admin-product-edit-http.test.ts`; rung 4 is the
 * "Deliberately EXCLUDES" doc block on the port.
 * Reasoning: `adr/0013-product-title-is-cms-owned.md`.
 */
const badEditTitle: UpdateProductCommerceFieldsInput = {
	productId: productId("prod-1"),
	// @ts-expect-error — title is CMS-owned; the admin edit port must not accept it (ADR-0013)
	title: "Renamed",
};

// The sync's channel, by contrast, DOES carry it — the positive half of the
// same rule, so this file states the asymmetry rather than only half of it.
const syncTitle: UpsertProductCommerceInput = {
	productId: productId("prod-1"),
	title: "Renamed by the CMS",
};

/**
 * ADR-0016 rung 2, one level down — the compile-time half of "a variant's name
 * has exactly one writer", and of "the admin owns the commerce fields".
 *
 * The two channels are DISJOINT, and this file pins both directions rather than
 * only the one that would be noticed. Rung 1 is the port types; rung 3 is the
 * contract suite on all three adapters; rung 4 is the "Deliberately EXCLUDES"
 * doc block on each input. Reasoning: `adr/0016-variant-title-is-cms-owned.md`.
 */
const badVariantEditTitle: UpdateProductVariantFieldsInput = {
	productId: productId("prod-1"),
	variantKey: "large",
	// @ts-expect-error — the variant name is CMS-owned; the admin edit must not accept it (ADR-0016)
	title: "Large",
};

const badVariantDeclareSku: UpsertProductVariantInput = {
	productId: productId("prod-1"),
	variantKey: "large",
	// @ts-expect-error — sku is admin-owned; the CMS sync channel must not accept it (ADR-0016)
	sku: sku("SKU-L"),
};

const badVariantDeclarePrice: UpsertProductVariantInput = {
	productId: productId("prod-1"),
	variantKey: "large",
	// @ts-expect-error — price is admin-owned; the CMS sync channel must not accept it (ADR-0016)
	price: money(cents(500), currency("USD")),
};

const badVariantRawPrice: UpdateProductVariantFieldsInput = {
	productId: productId("prod-1"),
	variantKey: "large",
	// @ts-expect-error — price must be branded Money, not a raw number (money is minor units + currency)
	price: 500,
};

const badVariantRawAmount: UpdateProductVariantFieldsInput = {
	productId: productId("prod-1"),
	variantKey: "large",
	// @ts-expect-error — price.amount must be branded Cents, not a raw number literal
	price: { amount: 500, currency: currency("USD") },
};

// The positive halves, so the file states each asymmetry rather than half of it:
// the declare carries the name, the edit carries the money.
const variantDeclare: UpsertProductVariantInput = {
	productId: productId("prod-1"),
	variantKey: "large",
	title: "Large",
};

const variantEdit: UpdateProductVariantFieldsInput = {
	productId: productId("prod-1"),
	variantKey: "large",
	sku: sku("SKU-L"),
	price: money(cents(2599), currency("USD")),
};

// Reference the consts so oxlint doesn't flag unused locals in this
// deliberately-type-only file.
export const typeOnlyRefs = {
	badInput,
	badAmount,
	badEditTitle,
	syncTitle,
	badVariantEditTitle,
	badVariantDeclareSku,
	badVariantDeclarePrice,
	badVariantRawPrice,
	badVariantRawAmount,
	variantDeclare,
	variantEdit,
};
