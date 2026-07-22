import type { IdempotencyKey, ProductId } from "../money/ids.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type {
	ProductCommerce,
	ProductCommerceStore,
	ProductCommerceUpdateResult,
	ProductCommerceView,
	UpdateProductCommerceFieldsInput,
	UpsertProductCommerceInput,
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
 * `InventoryStore.seedOnHand` write for the initial stock the panel's Stock
 * field captured. The seed is attempted on EVERY save that carries a stock
 * figure and a known sku — deliberately NOT gated on "sku was just set"
 * (review B1): the two writes are separate IO calls with no shared
 * transaction, so a crash/fault after the upsert commits but before the
 * seed lands would otherwise strand a durably-priced product with no
 * inventory row forever (the Stock field is create-only and no other Phase-1
 * path writes inventory). Because `seedOnHand` is a single-statement
 * `INSERT … ON CONFLICT (sku) DO NOTHING` (contract-proven to never clobber
 * an existing or already-decremented `on_hand`), the always-attempt shape is
 * safe AND self-healing: a retried save re-attempts the seed and heals the
 * stranding. On seed failure the error propagates (the command fails, the
 * caller retries) — never swallowed.
 *
 * `initialOnHand` is undefined when the caller has no stock figure (e.g. a
 * bare content sync) — no inventory write happens in that case.
 */
export async function upsertProductCommerce(
	deps: ProductCommerceDeps,
	input: UpsertProductCommerceInput,
	key: IdempotencyKey,
	initialOnHand?: number,
): Promise<ProductCommerce> {
	const row = await deps.productCommerce.upsert(input, key);

	// The sku to seed against: the input's if this save set it, else the
	// stored one (a retry after a failed seed replays the upsert as a
	// same-key no-op, so the sku arrives via the returned row).
	const seedSku = input.sku ?? row.sku ?? undefined;
	if (initialOnHand !== undefined && seedSku !== undefined) {
		await deps.inventory.seedOnHand(seedSku, initialOnHand);
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
 * contract; this wrapper exists so `@urumi/service` composes use-cases, not
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
 * integrity). Exists so `@urumi/service` composes a use-case, not a store
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
 */
export async function updateProductCommerceFields(
	store: ProductCommerceStore,
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
	return store.updateCommerceFields(input, key, expectedUpdatedAt);
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
 * publish/unpublish delivery converges). Exists so `@urumi/service` composes
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
 * Exists so `@urumi/service` composes use-cases, not store methods, like its
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
