import type { Cents, Currency } from "../money/cents.js";
import type { CustomerId, IdempotencyKey, OrderId } from "../money/ids.js";
import type { CouponType } from "../pricing/types.js";

/**
 * `CouponStore` (Phase 6 §5/§6). Redemption is the atomic op — a single guarded
 * `UPDATE coupons SET uses_count = uses_count + 1 WHERE uses_count < max_uses`,
 * coupled with an idempotency-guarded `coupon_redemptions` insert, EXACTLY
 * mirroring `InventoryStore.reserve` (no over-redeem under concurrency, replay is
 * a no-op re-read). Release is the mirror of `release`: decrement + delete the
 * redemption, idempotent (releasing a released/absent id is a no-op).
 */
export interface CouponStore {
	create(input: CreateCouponInput): Promise<CouponRecord>;
	/** The full record for validation (dates, min-subtotal, exhaustion), or null. */
	findByCode(code: string): Promise<CouponRecord | null>;
	findById(couponId: string): Promise<CouponRecord | null>;

	/**
	 * Redeem atomically: claim `(couponId, idempotencyKey)` and, only when the
	 * claim is fresh, run the guarded max-uses increment in the same transaction.
	 * A replay (same key) returns the recorded redemption with `replayed: true`
	 * and never decrements twice. At `maxUses` the whole transaction rolls back
	 * and `COUPON_EXHAUSTED` is returned — no redemption row, no increment.
	 */
	redeem(input: RedeemCouponInput): Promise<RedeemResult>;

	/**
	 * Release a redemption: `DELETE` the row and decrement `uses_count` (guarded
	 * `uses_count > 0`), all-or-nothing. Releasing an already-released or
	 * never-redeemed id is a no-op, not an error.
	 */
	release(redemptionId: string): Promise<void>;

	/**
	 * Reconciliation read (§5): redemptions created strictly before `cutoff` —
	 * the crash-recovery sweep pairs these with `OrderStore.getById` to release any
	 * whose order never became durable. Mirrors `OrderStore.listExpirable`.
	 */
	listRedemptionsCreatedBefore(cutoff: string): Promise<CouponRedemption[]>;
}

export interface CouponRecord {
	id: string;
	code: string;
	type: CouponType;
	/** fixed_amount only. */
	amountCents: Cents | null;
	/** percentage only — integer basis points. */
	rateBps: number | null;
	/** percentage only — optional cap. */
	capCents: Cents | null;
	/** fixed_amount only — the coupon's denominated currency. */
	currency: Currency | null;
	minSubtotalCents: Cents | null;
	startsAt: string | null;
	expiresAt: string | null;
	maxUses: number | null;
	maxUsesPerCustomer: number | null;
	usesCount: number;
}

export interface CreateCouponInput {
	id: string;
	code: string;
	type: CouponType;
	amountCents: Cents | null;
	rateBps: number | null;
	capCents: Cents | null;
	currency: Currency | null;
	minSubtotalCents: Cents | null;
	startsAt: string | null;
	expiresAt: string | null;
	maxUses: number | null;
	maxUsesPerCustomer: number | null;
}

export interface RedeemCouponInput {
	couponId: string;
	orderId: OrderId;
	idempotencyKey: IdempotencyKey;
	/** Present only for a logged-in checkout (Phase 5 soft dependency). When
	 *  absent, `maxUsesPerCustomer` degrades to global-`maxUses`-only. */
	customerId?: CustomerId;
	createdAt: string;
}

export type RedeemResult =
	| { ok: true; redemptionId: string; replayed: boolean }
	| { ok: false; reason: "COUPON_EXHAUSTED" | "COUPON_MAX_PER_CUSTOMER" };

export interface CouponRedemption {
	id: string;
	couponId: string;
	orderId: OrderId;
	customerId: CustomerId | null;
	idempotencyKey: IdempotencyKey;
	createdAt: string;
}
