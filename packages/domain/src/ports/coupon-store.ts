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
	 * Edit a coupon's economics + window (admin-UX Increment 3 — the missing
	 * UPDATE capability). `code` and `type` are the coupon's IMMUTABLE identity/kind
	 * (a merchant supersedes a live promotion with a NEW code, never re-defines an
	 * issued one), so only the amount/rate/cap/min-subtotal/window/max-uses fields
	 * are editable.
	 *
	 * DELIBERATELY LAST-WRITER-WINS, not CAS — the documented exception to "prefer
	 * CAS for money-bearing fields" (with the reasoning recorded so it is a
	 * decision, not an oversight): a coupon's economics are effectively FIXED at
	 * issue (edits are rare and typically administrative — extend `expiresAt`, bump
	 * `maxUses` — not price re-cuts), a coupon has NO single non-null money scalar
	 * to CAS on cleanly (amount/rate/cap are each null for the other `type`), and
	 * two admins editing the SAME coupon concurrently is implausible for a
	 * single-merchant console. The fields are set-values, not deltas, so a replay
	 * is idempotent; `uses_count` (the ONE field under real concurrency, moved by
	 * `redeem`/`release`) is NEVER touched by this admin edit, so an edit and a
	 * concurrent redemption cannot corrupt each other. Unknown `couponId` →
	 * `not_found` (an edit is not a create; no row minted).
	 */
	update(couponId: string, input: UpdateCouponInput): Promise<UpdateCouponResult>;

	/**
	 * Delete a coupon with a FORBID-IF-REDEEMED referential guard: a coupon with
	 * ≥1 `coupon_redemption` cannot be deleted (`in_use_by_redemptions`) — an
	 * ATOMIC guard (the DELETE is conditioned on no redemption row) so a concurrent
	 * `redeem` can never orphan a redemption onto a just-deleted coupon, and the
	 * `coupon_redemptions.coupon_id` foreign key stays satisfied. This also
	 * preserves the reconciliation/audit trail (`releaseByOrder`,
	 * `listRedemptionsCreatedBefore` rely on redemptions resolving to their
	 * coupon). SNAPSHOT INVARIANT: an order's discount is snapshotted into
	 * `order_totals.discount_cents` + `applied_coupon_code` at creation, so
	 * deleting an UNREDEEMED coupon never rewrites an existing order; an in-flight
	 * cart that had quoted the coupon recomputes on next quote/checkout and finds
	 * it gone (`findByCode` → null ⇒ no discount). Idempotent: unknown id →
	 * `not_found` no-op.
	 */
	delete(couponId: string): Promise<DeleteCouponResult>;

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
	 * Order-scoped release (§5, review round I2 — mirrors
	 * `InventoryStore.releaseAdopted`): delete the order's redemption(s) and
	 * decrement `uses_count`, guarded + idempotent (0 rows ⇒ silent no-op, never
	 * a double-release). Called by `expireOrders` and the payment-failure path so
	 * a coupon consumed by an abandoned-then-expired (or failed) checkout is freed
	 * exactly like its inventory hold. Returns the number of redemptions released.
	 * A paid/completed order never calls this, so its coupon stays consumed.
	 */
	releaseByOrder(orderId: OrderId): Promise<number>;

	/**
	 * Reconciliation read (§5): redemptions created strictly before `cutoff` —
	 * the crash-recovery sweep pairs these with `OrderStore.getById` to release any
	 * whose order never became durable. Mirrors `OrderStore.listExpirable`.
	 */
	listRedemptionsCreatedBefore(cutoff: string): Promise<CouponRedemption[]>;

	/**
	 * Admin Coupons console: view-only list (admin-UX Increment 3, "coupon
	 * enumerate + coupon list" — the missing atomic primitive this slice adds,
	 * mirroring `ProductCommerceStore.listProducts`'s proven keyset shape 1:1).
	 *
	 * Ordered `created_at DESC, id DESC` (newest-first, `id` the stable
	 * tie-break — the primary key, exactly like `ProductSummary.productId`).
	 * `created_at` is a NEW column (coupons had none before this slice); `create`
	 * now stamps it from the injected `Clock`. Pagination is forward-only
	 * keyset: the caller passes back the previous page's `nextCursor` position;
	 * the adapter fetches `limit + 1` rows to decide whether a next page exists
	 * and emits `nextCursor` from the LAST RETURNED row (null when the page is
	 * the last).
	 *
	 * Returns the FULL `CouponSummary` projection — unlike `ProductSummary`
	 * (which deliberately trims heavy/detail-only fields off `ProductCommerce`),
	 * `coupons` is a small, header-only table with nothing expensive to trim, so
	 * the summary carries every economics/window field `CouponRecord` does, plus
	 * `createdAt`. `usesCount` (already a plain column, no join) doubles as the
	 * cheap "has this been redeemed" indicator the admin list needs — no
	 * correlated `EXISTS` on `coupon_redemptions`, no N+1.
	 *
	 * `filter.search` is a case-insensitive EXACT match on `code` — a
	 * structured identifier a merchant looks up precisely, and the strictest
	 * `search` in the product: NEITHER `ProductListFilter.search`'s
	 * title-substring half NOR `OrderListFilter.search`'s id-PREFIX /
	 * buyer_ref-SUBSTRING widening applies here. A coupon has no free-text field
	 * to partially remember, and a code is short, chosen and quoted whole — it
	 * never renders as a truncated prefix the way an order uuid does, which is
	 * what earned orders their prefix match. No other filter axis ships this
	 * slice (coupons have
	 * no soft-delete/publish-gate/kind axis to mirror `deleted`/`active`/
	 * `productKind`) — deliberately minimal, not "filterable where cheap".
	 */
	listCoupons(filter: CouponListFilter, page: CouponListPage): Promise<CouponListResult>;

	/**
	 * Count the coupons matching a filter (INC-23: the admin list's exact
	 * "N coupons" caption). Shares the EXACT predicate with `listCoupons` — the
	 * same case-insensitive EXACT-match `search` semantics — so a count can
	 * never disagree with the list it captions (one predicate builder in every
	 * adapter; mirrors `OrderStore.countOrders` / `ProductCommerceStore
	 * .countProducts` 1:1). No ordering, no cursor: a count is one scalar.
	 */
	countCoupons(filter: CouponListFilter): Promise<number>;
}

/**
 * Filter for the admin Coupons list. Optional — an empty filter lists every
 * coupon. See `CouponStore.listCoupons`'s doc for why `search` is the only
 * axis this slice ships.
 */
export interface CouponListFilter {
	/** Case-insensitive EXACT match on `code` (never a substring — see the
	 *  port doc). A row with no match on this axis simply is not listed. */
	search?: string;
}

/** A keyset cursor POSITION — the `(createdAt, id)` of the last row of the
 *  previous page. Deliberately opaque-free in the domain (NO base64), like
 *  `ProductListCursor` — the service layer wraps this into an opaque token.
 *  Ordering is `created_at DESC, id DESC`, so the next page is every row
 *  strictly "after" this position under that order. */
export interface CouponListCursor {
	createdAt: string;
	couponId: string;
}

/** One page request: an optional starting cursor (null/absent ⇒ first page)
 *  and a page size. */
export interface CouponListPage {
	cursor?: CouponListCursor | null;
	limit: number;
}

/**
 * The admin list row — mirrors `CouponRecord` exactly (a small, header-only
 * table has nothing expensive to trim off the list projection, unlike
 * `ProductSummary`) plus the new `createdAt` ordering column. Money stays
 * branded (`Cents`/`Currency`), never a bare number.
 */
export interface CouponSummary {
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
	usesCount: number;
	createdAt: string;
}

export interface CouponListResult {
	coupons: CouponSummary[];
	/** The position to pass back for the next page, or null when this is the
	 *  last page (fewer than `limit + 1` rows matched). */
	nextCursor: CouponListCursor | null;
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

/** The coupon fields a merchant may EDIT (admin-UX Increment 3). A strict subset
 *  of `CreateCouponInput`: `id`/`code`/`type` are excluded (immutable identity +
 *  kind), and `usesCount` is store-owned (moved only by redeem/release). Money
 *  stays branded `Cents`; a `number` in a money field is a compile error. */
export interface UpdateCouponInput {
	amountCents: Cents | null;
	rateBps: number | null;
	capCents: Cents | null;
	minSubtotalCents: Cents | null;
	startsAt: string | null;
	expiresAt: string | null;
	maxUses: number | null;
	maxUsesPerCustomer: number | null;
}

/** Outcome of `CouponStore.update` — LWW (no `stale`, see the method doc). */
export type UpdateCouponResult =
	| { ok: true; coupon: CouponRecord }
	| { ok: false; reason: "not_found" };

/** Outcome of `CouponStore.delete` — a referential guard on live redemptions. */
export type DeleteCouponResult =
	| { ok: true }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "in_use_by_redemptions" };

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
