import type { Clock } from "../ports/clock.js";
import type { CouponStore } from "../ports/coupon-store.js";
import type { OrderStore } from "../ports/order-store.js";

/** The crash-recovery grace window (§5) — matches the checkout hold TTL. */
export const DEFAULT_COUPON_GRACE_MS = 15 * 60 * 1000;

export interface ReconcileCouponsDeps {
	couponStore: CouponStore;
	orderStore: OrderStore;
	clock: Clock;
}

export interface ReconcileCouponsOptions {
	/** Grace window in ms; defaults to {@link DEFAULT_COUPON_GRACE_MS}. */
	graceMs?: number;
}

/**
 * Crash-recovery coupon release sweep (Phase 6 §5, mirrors Phase 3's reservation
 * sweep). Scans `coupon_redemptions` older than the grace window and releases any
 * whose `order_id` never became a durable `orders` row — the process died between
 * `redeem()` and the order becoming durable. A redemption whose order DOES exist
 * is left alone (redeemed for real). Returns the number released. Idempotent:
 * re-running releases nothing new (releasing a released id is a no-op).
 */
export async function reconcileCouponRedemptions(
	deps: ReconcileCouponsDeps,
	options: ReconcileCouponsOptions = {},
): Promise<number> {
	const graceMs = options.graceMs ?? DEFAULT_COUPON_GRACE_MS;
	const cutoff = new Date(deps.clock.now().getTime() - graceMs).toISOString();
	const stale = await deps.couponStore.listRedemptionsCreatedBefore(cutoff);
	let released = 0;
	for (const redemption of stale) {
		const order = await deps.orderStore.getById(redemption.orderId);
		if (order === null) {
			// The order never became durable — free the redemption.
			await deps.couponStore.release(redemption.id);
			released++;
		}
	}
	return released;
}
