import type { IdempotencyKey, ProductId } from "../money/ids.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type {
	ProductCommerce,
	ProductCommerceStore,
	ProductCommerceView,
	UpsertProductCommerceInput,
} from "../ports/product-commerce-store.js";

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
