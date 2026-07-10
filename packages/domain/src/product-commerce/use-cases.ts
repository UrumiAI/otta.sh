import type { IdempotencyKey, ProductId } from "../money/ids.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type {
	ProductCommerce,
	ProductCommerceStore,
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
 * Composes two ports: the commercial upsert itself, plus — ONLY the moment a
 * sku is first set on a product_commerce row (the "create then price"
 * moment, not merely the moment the row first exists — an `afterSave` sync
 * upsert may create a bare row with no sku long before pricing happens) —
 * a single create-if-absent `InventoryStore.seedOnHand` write for the
 * initial stock the panel's Stock field captured. `seedOnHand`'s own
 * `ON CONFLICT (sku) DO NOTHING` guard makes this safe to attempt even if it
 * somehow re-fires; it can never clobber a concurrent reserve/adjust.
 *
 * `initialOnHand` is undefined when the caller has no stock figure yet (e.g.
 * a bare content sync) — no inventory write happens in that case.
 */
export async function upsertProductCommerce(
	deps: ProductCommerceDeps,
	input: UpsertProductCommerceInput,
	key: IdempotencyKey,
	initialOnHand?: number,
): Promise<ProductCommerce> {
	const existing = await deps.productCommerce.getByProductId(input.productId).catch(() => null);
	const row = await deps.productCommerce.upsert(input, key);

	const skuWasUnset = existing === null || existing.sku === null;
	if (skuWasUnset && input.sku !== undefined && initialOnHand !== undefined) {
		await deps.inventory.seedOnHand(input.sku, initialOnHand);
	}

	return row;
}

export async function getProductCommerce(
	store: ProductCommerceStore,
	productId: ProductId,
): Promise<ProductCommerce | null> {
	return store.getByProductId(productId);
}

export async function softDeleteProductCommerce(
	store: ProductCommerceStore,
	productId: ProductId,
	key: IdempotencyKey,
): Promise<void> {
	return store.softDelete(productId, key);
}
