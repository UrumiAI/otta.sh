import type { IdempotencyKey, Sku } from "../money/ids.js";
import type { InventoryStore, ReserveResult } from "../ports/inventory-store.js";

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
