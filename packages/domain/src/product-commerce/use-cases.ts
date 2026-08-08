import type { IdempotencyKey, ProductId } from "../money/ids.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type {
	ProductCommerce,
	ProductCommerceStore,
	ProductCommerceUpdateResult,
	ProductCommerceView,
	ProductVariant,
	ProductVariantSummary,
	ProductVariantUpdateResult,
	UpdateProductCommerceFieldsInput,
	UpdateProductVariantFieldsInput,
	UpsertProductCommerceInput,
	UpsertProductVariantInput,
} from "../ports/product-commerce-store.js";
import { InvalidProductFieldError } from "./errors.js";

export interface ProductCommerceDeps {
	productCommerce: ProductCommerceStore;
	inventory: InventoryStore;
}

/**
 * Thin IO-free orchestration over the `ProductCommerceStore` +
 * `InventoryStore` ports (Phase 1 §7/§8 Risk 4).
 *
 * Composes two ports: the commercial upsert itself, plus a create-if-absent
 * `InventoryStore.seedOnHand` write. The seed is attempted on EVERY save with
 * a known sku — deliberately NOT gated on "sku was just set" (review B1) and,
 * since PR 1a, not gated on a stock figure being supplied either: the two
 * writes are separate IO calls with no shared transaction, so a crash/fault
 * after the upsert commits but before the seed lands would otherwise strand a
 * durably-priced product with no inventory row forever. Because `seedOnHand`
 * is a single-statement `INSERT … ON CONFLICT (sku) DO NOTHING`
 * (contract-proven to never clobber an existing or already-decremented
 * `on_hand`), the always-attempt shape is safe AND self-healing: a retried
 * save re-attempts the seed and heals the stranding. On seed failure the error
 * propagates (the command fails, the caller retries) — never swallowed.
 *
 * PR 1a — the INVARIANT is "a product with a sku has an inventory row", held
 * by the data rather than by one caller, so an absent `initialOnHand` seeds
 * `0` rather than skipping: the integrator path (`PUT /products/:id/commerce`)
 * can no longer mint a sku with no inventory row, which is what made
 * `POST /admin/products/:id/restock` a permanent NO_INVENTORY_ROW 409.
 * CONSEQUENCE, deliberate: because the seed is create-if-absent, once a row
 * exists a LATER save's `initialOnHand` is a no-op — the create-only Stock
 * figure only ever lands on the save that first carries the sku. Adding stock
 * after that is `restock`'s job (which now always has a row to add to).
 */
export async function upsertProductCommerce(
	deps: ProductCommerceDeps,
	input: UpsertProductCommerceInput,
	key: IdempotencyKey,
	initialOnHand?: number,
): Promise<ProductCommerce> {
	const row = await deps.productCommerce.upsert(input, key);

	// Seed against the RETURNED row's sku, never the input's. The returned row is
	// authoritative in every case: a genuine apply returns the applied sku; a
	// same-key replay and a STALE-watermark no-op both return the currently
	// stored row (the adapter re-reads it when the guarded upsert matches no
	// rows). `input.sku` is therefore either identical to it or — on a reordered
	// `content:afterSave` delivery whose older watermark was rejected — the sku
	// of a payload that was NOT applied, which would mint an inventory row for a
	// sku no product owns.
	const seedSku = row.sku ?? undefined;
	if (seedSku !== undefined) {
		await deps.inventory.seedOnHand(seedSku, initialOnHand ?? 0);
	}

	return row;
}

export async function getProductCommerce(
	store: ProductCommerceStore,
	productId: ProductId,
): Promise<ProductCommerce | null> {
	return store.getByProductId(productId);
}

/**
 * Batch catalog read (Phase 2 §6) — a query, not a command (no idempotency
 * key). Straight pass-through: the semantics (missing ids omitted,
 * commerce-complete rows only, intra-store `inStock` join) are the PORT's
 * contract; this wrapper exists so `@otta-sh/service` composes use-cases, not
 * store methods, like its siblings.
 */
export async function listProductCommerceByIds(
	store: ProductCommerceStore,
	productIds: ProductId[],
): Promise<ProductCommerceView[]> {
	return store.listCommerceByIds(productIds);
}

/**
 * Guarded admin EDIT of the commerce-owned fields (admin-UX Increment 2,
 * slice 2). A thin IO-free orchestration: pure field validation (the domain
 * rules the branded types cannot express), then the store's optimistic
 * compare-and-set (`ProductCommerceStore.updateCommerceFields`) — the port doc
 * carries the guard semantics (replay dedupe, not_found, stale, currency
 * integrity). Exists so `@otta-sh/service` composes a use-case, not a store
 * method, like its siblings.
 *
 * Validation (throws `InvalidProductFieldError`, mapped to 400 upstream):
 *  - `price.amount` must be STRICTLY POSITIVE — a $0 commerce price is not a
 *    valid edit (branded `Cents` already rejects negatives/floats; ">0" is the
 *    one rule left to the domain). `compareAtPrice`/`unitCost` are NOT held to
 *    ">0" (a $0 compare-at / cost is a meaningful "cleared to zero"; branded
 *    `Cents` still rejects negatives/floats). `compareAtPrice >= price` is
 *    deliberately allowed (see the port's `UpdateProductCommerceFieldsInput`).
 *  - WITHIN-EDIT currency consistency: every money field SUPPLIED in a single
 *    edit (`price`, `compareAtPrice`, `unitCost`) must share ONE currency. This
 *    is a pure client-shape rule (independent of stored state), so a mixed-
 *    currency edit is rejected atomically here as a 400 — never partially
 *    applied — BEFORE the store's stored-vs-new `currency_mismatch` guard runs.
 *    A cleared field (`null`) carries no currency and is exempt.
 *  - `weightGrams` / `lengthMm` / `widthMm` / `heightMm`, when provided
 *    non-null, must be non-negative safe integers.
 * NOT re-checked here: stored-currency integrity + existence + staleness are the
 * STORE's atomic concern (checking them here would be a TOCTOU race the CAS
 * already closes); SKU live-uniqueness stays the store's partial-index guard.
 *
 * PR 1a — after an `ok`, this ALSO seeds a create-if-absent inventory row for
 * the resulting `sku` at `0`, so the invariant "a product with a sku has an
 * inventory row" holds on the ADMIN write path too (before 1a, the console was
 * able to set the first sku with nothing ever creating the row, and
 * `POST /admin/products/:id/restock` 409'd NO_INVENTORY_ROW forever). It takes
 * `ProductCommerceDeps` rather than a bare store for that reason. Always-
 * attempt, never gated on "the sku changed" — the same B1 reasoning as
 * `upsertProductCommerce`: two IO calls, no shared transaction.
 *
 * WHY THAT IS SAFE HERE, given this is a CAS and not an upsert. If the guarded
 * UPDATE commits and the seed then throws, `updatedAt` has already moved, so a
 * naive retry would be `stale` and the product would be stranded with a sku and
 * no inventory row. It self-heals through a three-link chain — the whole safety
 * argument, so do not reorder any of it without re-reading this:
 *  1. When the guarded UPDATE matches zero rows, every adapter classifies the
 *     no-op in ONE fixed order — not_found → REPLAY → stale → currency_mismatch
 *     (pinned by the port doc on `ProductCommerceStore.updateCommerceFields`
 *     and by the contract suite on both dialects).
 *  2. So a SAME-KEY retry takes the replay branch and returns `ok` carrying the
 *     stored row, AHEAD of the staleness check — and the always-attempt seed
 *     below then runs again and lands.
 *  3. And a retry of the same submission IS same-key: the admin plugin derives
 *     its `Idempotency-Key` from the wire's content and sends it; a client that
 *     sends no header gets the service's deterministic per-submission fallback.
 * That replay branch models a DOUBLE-SUBMIT or a transport-level retry of the
 * byte-identical request. It is NOT the merchant clicking Save again — that
 * reloads the fresh detail first, so it carries a new `expectedUpdatedAt` and
 * hence a new key, and heals through the ordinary CAS path instead. Both routes
 * heal; the tests name and pin each one separately.
 *
 * A SKU RENAME IS NOT THIS FUNCTION'S BUSINESS, and that is deliberate. When an
 * edit CHANGES the sku, the store carries that sku's on-hand row onto the new
 * one inside its own transaction (THE SKU-RENAME RULE on `ProductCommerceStore`
 * — carry, retain the source zeroed, or refuse with `SkuStockConflictError`),
 * because only the store can make the movement atomic with the row write; this
 * use-case composes two ports over two IO calls and could only ever leave a
 * half-done rename behind. The seed below therefore stays exactly what it was:
 * UNCONDITIONAL on every `ok`, never gated on "the sku changed". It runs after
 * a rename too, where the row it would create already exists holding the
 * carried units, so create-if-absent makes it the no-op it always was — the
 * always-attempt heal path is preserved, and the carried count is never
 * clobbered back to zero. A refusal propagates: the store threw, nothing was
 * written on either side, and no seed is attempted.
 */
export async function updateProductCommerceFields(
	deps: ProductCommerceDeps,
	input: UpdateProductCommerceFieldsInput,
	key: IdempotencyKey,
	expectedUpdatedAt: string,
): Promise<ProductCommerceUpdateResult> {
	if (input.price !== undefined && input.price.amount <= 0) {
		throw new InvalidProductFieldError("price", "price must be greater than zero");
	}
	// Within-edit currency consistency: every money field supplied in THIS edit
	// must agree on one currency (a pure client-shape rule — the stored-vs-new
	// axis is the store's CAS concern). A cleared (`null`) field carries no
	// currency and is exempt.
	const suppliedMoney: Array<{ field: string; currency: string }> = [];
	if (input.price != null) suppliedMoney.push({ field: "price", currency: input.price.currency });
	if (input.compareAtPrice != null) {
		suppliedMoney.push({ field: "compareAtPrice", currency: input.compareAtPrice.currency });
	}
	if (input.unitCost != null) {
		suppliedMoney.push({ field: "unitCost", currency: input.unitCost.currency });
	}
	const firstCurrency = suppliedMoney[0]?.currency;
	for (const m of suppliedMoney) {
		if (firstCurrency !== undefined && m.currency !== firstCurrency) {
			throw new InvalidProductFieldError(
				m.field,
				"price, compare-at, and cost must all use the same currency",
			);
		}
	}
	const dims = [
		["weightGrams", input.weightGrams],
		["lengthMm", input.lengthMm],
		["widthMm", input.widthMm],
		["heightMm", input.heightMm],
	] as const;
	for (const [field, value] of dims) {
		if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
			throw new InvalidProductFieldError(field, `${field} must be a non-negative integer`);
		}
	}
	const result = await deps.productCommerce.updateCommerceFields(input, key, expectedUpdatedAt);
	// Only an applied (or replayed) edit seeds: a not_found / stale /
	// currency_mismatch wrote nothing, so there is no sku it may claim.
	if (result.ok && result.product.sku !== null) {
		await deps.inventory.seedOnHand(result.product.sku, 0);
	}
	return result;
}

export async function softDeleteProductCommerce(
	store: ProductCommerceStore,
	productId: ProductId,
	key: IdempotencyKey,
): Promise<void> {
	return store.softDelete(productId, key);
}

/**
 * The afterPublish→activate follow-up (plan §6 step 7): a thin pass-through
 * to `ProductCommerceStore.activate` — the port's doc carries the semantics
 * (unknown/soft-deleted/already-active rows are no-ops; a soft-deleted
 * product is never resurrected by a publish; a stale `contentUpdatedAt`
 * watermark arriving after a newer lifecycle event is a no-op so out-of-order
 * publish/unpublish delivery converges). Exists so `@otta-sh/service` composes
 * use-cases, not store methods, like its siblings.
 */
export async function activateProductCommerce(
	store: ProductCommerceStore,
	productId: ProductId,
	key: IdempotencyKey,
	contentUpdatedAt: string,
): Promise<void> {
	return store.activate(productId, key, contentUpdatedAt);
}

/**
 * The afterUnpublish→deactivate follow-up (plan §6 step 7): the mirror of
 * `activateProductCommerce`, a thin pass-through to
 * `ProductCommerceStore.deactivate` — the port's doc carries the semantics
 * (unknown/soft-deleted/already-inactive rows are no-ops; deactivation flips
 * only the publish gate and never touches `deletedAt`; a stale
 * `contentUpdatedAt` watermark is a no-op so out-of-order delivery converges).
 * Exists so `@otta-sh/service` composes use-cases, not store methods, like its
 * siblings.
 */
export async function deactivateProductCommerce(
	store: ProductCommerceStore,
	productId: ProductId,
	key: IdempotencyKey,
	contentUpdatedAt: string,
): Promise<void> {
	return store.deactivate(productId, key, contentUpdatedAt);
}

// -- Variants: one commerce row per sellable unit ----------------------------

/**
 * The CMS-sync declare (port doc on `ProductCommerceStore.upsertVariant`): a
 * thin pass-through, because this channel writes only the variant's display-name
 * cache and its presence — no sku, so there is nothing for an inventory row to
 * be seeded against and no second port to compose (the deliberate contrast with
 * `upsertProductCommerce`, which always attempts a seed precisely because it CAN
 * carry a sku). Exists so `@otta-sh/service` composes a use-case, not a store
 * method, like its siblings.
 */
export async function upsertProductVariant(
	store: ProductCommerceStore,
	input: UpsertProductVariantInput,
	key: IdempotencyKey,
): Promise<ProductVariant> {
	return store.upsertVariant(input, key);
}

/** Every variant of one product (port doc) — a query, not a command. Ordered by
 *  key, orphans included and flagged, `onHand` joined in the same statement. */
export async function listProductVariants(
	store: ProductCommerceStore,
	productId: ProductId,
): Promise<ProductVariantSummary[]> {
	return store.listVariants(productId);
}

/**
 * The guarded admin edit at variant grain — `updateProductCommerceFields`'s
 * mirror, one level down: pure field validation the branded types cannot
 * express, then the store's compare-and-set (whose guard order, currency
 * integrity and rename carry are the PORT's contract).
 *
 * Validation (throws `InvalidProductFieldError`, mapped to 400 upstream):
 *  - `price.amount` must be STRICTLY POSITIVE. Branded `Cents` already rejects a
 *    float or a negative; ">0" is the one rule left to the domain, and it is the
 *    same rule the product level applies — a $0 size is not a price, it is a
 *    missing one, and an absent price is expressed by leaving the field unset.
 * There is no within-edit currency check here as there is at product level: a
 * variant edit carries exactly ONE money field, so there is nothing for it to
 * disagree with inside one call. The cross-row agreements — against the
 * variant's own stored currency and against the product's — are the store's
 * atomic concern, checked under the same compare-and-set that applies the write.
 *
 * IT SEEDS, exactly like its product-level sibling and for the same B1 reason:
 * the invariant is "a sellable unit with a sku has an inventory row", held by the
 * data rather than by one caller. THE SKU-RENAME RULE already claims (and thereby
 * creates) the target row inside the store's own transaction, so the seed is a
 * no-op after a rename; the case it actually covers is a FIRST sku, where the
 * rule never engages and nothing else would create the row. Always-attempt, never
 * gated on "the sku changed", so a retried save heals a stranded unit — and
 * because `seedOnHand` is create-if-absent, it can never clobber units the carry
 * just moved. A refused edit (a throw) never reaches it, and every zero-row
 * outcome except the replay `ok` wrote no sku for it to claim.
 */
export async function updateProductVariantFields(
	deps: ProductCommerceDeps,
	input: UpdateProductVariantFieldsInput,
	key: IdempotencyKey,
	expectedUpdatedAt: string,
): Promise<ProductVariantUpdateResult> {
	if (input.price !== undefined && input.price.amount <= 0) {
		throw new InvalidProductFieldError("price", "price must be greater than zero");
	}
	const result = await deps.productCommerce.updateVariantFields(input, key, expectedUpdatedAt);
	// The same always-attempt heal the product level runs, for the same reason
	// (two IO calls, no shared transaction): only an applied or replayed edit has
	// a sku it may claim, and `seedOnHand` is create-if-absent, so it can never
	// clobber units the rename carry just moved.
	if (result.ok && result.variant.sku !== null) {
		await deps.inventory.seedOnHand(result.variant.sku, 0);
	}
	return result;
}

/** The ORPHAN transition (port doc): a thin pass-through. Deactivation, never
 *  deletion — the row, its sku, its price and its stock are all retained, and a
 *  stale watermark is a no-op so out-of-order delivery converges. */
export async function deactivateProductVariant(
	store: ProductCommerceStore,
	productId: ProductId,
	variantKey: string,
	key: IdempotencyKey,
	contentUpdatedAt: string,
): Promise<void> {
	return store.deactivateVariant(productId, variantKey, key, contentUpdatedAt);
}
