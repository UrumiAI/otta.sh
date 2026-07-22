import type { IdempotencyKey, Sku } from "../money/ids.js";
import type {
	InventoryStore,
	ReserveResult,
	RestockResult,
	StockRemovalResult,
} from "../ports/inventory-store.js";

/**
 * Thin IO-free orchestration over the InventoryStore port (Phase 0 step 0.2c).
 *
 * Branding is applied at this boundary (risk R1): the use-case takes a
 * branded `Sku`, the port keeps its verbatim `sku: string` signature for
 * portability to a future EmdashStore.
 */
export async function reserve(
	store: InventoryStore,
	sku: Sku,
	qty: number,
	key: IdempotencyKey,
): Promise<ReserveResult> {
	if (!Number.isSafeInteger(qty) || qty <= 0) {
		throw new RangeError(`reserve requires a positive integer qty, got ${String(qty)}`);
	}
	return store.reserve(sku, qty, key);
}

export async function commit(store: InventoryStore, reservationId: string): Promise<void> {
	return store.commit(reservationId);
}

export async function release(store: InventoryStore, reservationId: string): Promise<void> {
	return store.release(reservationId);
}

/**
 * Merchant restock (admin-UX Increment 2): ADD `qty` units to an existing sku's
 * on-hand. Branding is applied at this boundary (risk R1), and the positive-
 * integer bound is enforced here as well as in the store (defense-in-depth). A
 * restock is race-safe by construction — a commutative, unconditional increment
 * that can never cause an oversell (see the port doc).
 */
export async function restock(
	store: InventoryStore,
	sku: Sku,
	qty: number,
	key: IdempotencyKey,
): Promise<RestockResult> {
	if (!Number.isSafeInteger(qty) || qty <= 0) {
		throw new RangeError(`restock requires a positive integer qty, got ${String(qty)}`);
	}
	return store.restock(sku, qty, key);
}

/**
 * Merchant stock removal (admin-UX Increment 2): REMOVE `qty` units from an
 * existing sku's on-hand (damaged/shrinkage). The oversell-critical counterpart
 * of {@link restock}: the store applies a single GUARDED decrement that can
 * never drive on-hand below 0 or race a reservation into oversell (see the port
 * doc). Bounds enforced here and in the store.
 */
export async function removeStock(
	store: InventoryStore,
	sku: Sku,
	qty: number,
	key: IdempotencyKey,
): Promise<StockRemovalResult> {
	if (!Number.isSafeInteger(qty) || qty <= 0) {
		throw new RangeError(`removeStock requires a positive integer qty, got ${String(qty)}`);
	}
	return store.removeStock(sku, qty, key);
}
