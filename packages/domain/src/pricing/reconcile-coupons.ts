import type { Order } from "../orders/model.js";
import type { Clock } from "../ports/clock.js";
import type { CouponRedemption, CouponStore } from "../ports/coupon-store.js";
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
 * The order that holds a redemption's use, or null when none ever became durable.
 *
 * Looked up by the redemption's order id, then by its idempotency key (issue
 * #598): a same-key checkout replay replays the FIRST call's redemption — which
 * names that call's order id — while the order row, deduped on the same key, can
 * persist under the second call's id. That order carries the discount, so it holds
 * the use; judging by id alone would release it. An order store holds at most one
 * order per key, so the key names this checkout's order and no other.
 */
export async function orderHoldingRedemption(
	orderStore: Pick<OrderStore, "getById" | "getByIdempotencyKey">,
	redemption: Pick<CouponRedemption, "orderId" | "idempotencyKey">,
): Promise<Order | null> {
	return (
		(await orderStore.getById(redemption.orderId)) ??
		(await orderStore.getByIdempotencyKey(redemption.idempotencyKey))
	);
}

/**
 * Crash-recovery coupon release sweep (Phase 6 §5, mirrors Phase 3's reservation
 * sweep). Scans `coupon_redemptions` older than the grace window and releases any
 * whose order never became a durable `orders` row — the process died between
 * `redeem()` and the order becoming durable. A redemption whose order DOES exist
 * (by id or by key — see {@link orderHoldingRedemption})
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
		const order = await orderHoldingRedemption(deps.orderStore, redemption);
		if (order === null) {
			// The order never became durable — free the redemption.
			await deps.couponStore.release(redemption.id);
			released++;
		}
	}
	return released;
}
