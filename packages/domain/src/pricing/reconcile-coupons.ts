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
 * The order holding a redemption's use — {@link orderHoldingRedemption}'s answer.
 * `durable: false` is a key whose order was CLAIMED but never created (the
 * document store's claim-then-create window): `order` is the prepared order the
 * claim carries, which does not exist.
 */
export interface RedemptionHolder {
	order: Order;
	durable: boolean;
}

/**
 * The order that holds a redemption's use, or null when none does.
 *
 * Looked up by the redemption's order id, then by its idempotency key (issue
 * #598): a same-key checkout replay replays the FIRST call's redemption — which
 * names that call's order id — while the order row, deduped on the same key, can
 * persist under the second call's id. That order carries the discount, so it holds
 * the use; judging by id alone would release it. An order store holds at most one
 * order per key, so the key names this checkout's order and no other.
 *
 * An order found ONLY by the key holds the use only if it APPLIED this
 * redemption's coupon (#598 review). A redemption is claimed before its order is
 * inserted, so a call that dies in between leaves one bound to the key alone, and
 * the shopper may then drop or swap the coupon and place again under the same key:
 * that order never applied the stranded coupon, and the redemption is dead. The
 * coupon is read only on this path (codes are immutable); one that cannot be read
 * keeps the order, the safe direction.
 *
 * The key is read through `peekByIdempotencyKey`, never the healing
 * `getByIdempotencyKey`: a sweep must not complete a crashed checkout's claim.
 * Costs: one order read when the id names the order; otherwise that read, the key
 * peek (one or two reads), and a coupon read when the key's order applied a coupon.
 */
export async function orderHoldingRedemption(
	stores: {
		orderStore: Pick<OrderStore, "getById" | "peekByIdempotencyKey">;
		couponStore: Pick<CouponStore, "findById">;
	},
	redemption: Pick<CouponRedemption, "orderId" | "idempotencyKey" | "couponId">,
): Promise<RedemptionHolder | null> {
	const byId = await stores.orderStore.getById(redemption.orderId);
	if (byId !== null) return { order: byId, durable: true };
	const peeked = await stores.orderStore.peekByIdempotencyKey(redemption.idempotencyKey);
	if (peeked === null) return null;
	const applied = peeked.order.totals.appliedCouponCode;
	if (applied === null) return null;
	const coupon = await stores.couponStore.findById(redemption.couponId);
	if (coupon !== null && coupon.code !== applied) return null;
	return { order: peeked.order, durable: peeked.state === "minted" };
}

/**
 * Whether a redemption may be released, by the rule both sweeps share: no order
 * holds it, or the one that would is a claim whose order was never created and
 * whose hold has lapsed. Nothing will ever expire such a claim — no order exists to
 * list — and the order it would become is past its hold, which expiry would free
 * the coupon of; the sweep stands in for that expiry. A claim still inside its hold
 * is judged later.
 */
export function redemptionIsOrphaned(holder: RedemptionHolder | null, nowIso: string): boolean {
	if (holder === null) return true;
	return !holder.durable && holder.order.holdExpiresAt <= nowIso;
}

/**
 * Crash-recovery coupon release sweep (Phase 6 §5, mirrors Phase 3's reservation
 * sweep). Scans `coupon_redemptions` older than the grace window and releases any
 * whose order never became a durable `orders` row — the process died between
 * `redeem()` and the order becoming durable. A redemption whose order DOES exist
 * (by id, or by key having applied its coupon — see {@link orderHoldingRedemption})
 * is left alone (redeemed for real); see {@link redemptionIsOrphaned} for a key
 * whose order was claimed but never created. Returns the number released. Idempotent:
 * re-running releases nothing new (releasing a released id is a no-op).
 */
export async function reconcileCouponRedemptions(
	deps: ReconcileCouponsDeps,
	options: ReconcileCouponsOptions = {},
): Promise<number> {
	const graceMs = options.graceMs ?? DEFAULT_COUPON_GRACE_MS;
	const cutoff = new Date(deps.clock.now().getTime() - graceMs).toISOString();
	const nowIso = deps.clock.now().toISOString();
	const stale = await deps.couponStore.listRedemptionsCreatedBefore(cutoff);
	let released = 0;
	for (const redemption of stale) {
		const holder = await orderHoldingRedemption(deps, redemption);
		if (redemptionIsOrphaned(holder, nowIso)) {
			// No order holds it — free the redemption.
			await deps.couponStore.release(redemption.id);
			released++;
		}
	}
	return released;
}
