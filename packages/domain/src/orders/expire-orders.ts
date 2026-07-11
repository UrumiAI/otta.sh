import type { Clock } from "../ports/clock.js";
import type { CouponStore } from "../ports/coupon-store.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type { OrderStore } from "../ports/order-store.js";

export interface ExpireOrdersDeps {
	orderStore: OrderStore;
	inventoryStore: InventoryStore;
	/** Phase 6 (review I2): release the expired order's coupon, symmetric with
	 *  the inventory-hold release below. */
	couponStore: CouponStore;
	clock: Clock;
}

/**
 * Order-level expiry (§5) — a **real `orders`-table guarded transition**, NOT a
 * reuse of the Phase-3 reservation sweep. For each unpaid past-TTL order, the
 * guarded `pending → expired` flip (which re-checks `hold_expires_at <= now`
 * atomically) fires exactly once; only the winner then `release`s the order's
 * adopted reservations, so stock returns exactly once even under a double-sweep
 * race. Clock-driven; run by a self-interval or the `POST /internal/expire-orders`
 * trigger. Returns the count of orders actually expired.
 */
export async function expireOrders(deps: ExpireOrdersDeps, at?: Date): Promise<number> {
	const now = (at ?? deps.clock.now()).toISOString();
	const ids = await deps.orderStore.listExpirable(now);
	let expired = 0;
	for (const id of ids) {
		const won = await deps.orderStore.expire(id, now);
		if (!won) continue; // someone else won the transition (paid/failed/expired)
		expired++;
		const order = await deps.orderStore.getById(id);
		if (order === null) continue;
		for (const line of order.lines) {
			// Order-SCOPED release (review G2): only a hold THIS order adopted is
			// released — a line pointing at another order's reservation (a stale
			// pre-fence order) is a silent skip, never a foreign release or a throw
			// that would crash every subsequent sweep run.
			if (line.reservationId !== null) {
				await deps.inventoryStore.releaseAdopted(line.reservationId, order.id);
			}
		}
		// Review I2: free the coupon too — symmetric with the inventory release.
		// Order-scoped + idempotent (a double-sweep releases exactly once).
		await deps.couponStore.releaseByOrder(order.id);
	}
	return expired;
}
