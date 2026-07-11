import type { CustomerId, IdempotencyKey } from "../money/ids.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	CouponRecord,
	CouponRedemption,
	CouponStore,
	CreateCouponInput,
	RedeemCouponInput,
	RedeemResult,
} from "../ports/coupon-store.js";

interface RedemptionRow {
	id: string;
	couponId: string;
	orderId: string;
	customerId: CustomerId | null;
	idempotencyKey: IdempotencyKey;
	createdAt: string;
}

/**
 * IO-free `CouponStore` fake (first adapter to pass `couponStoreContract`).
 *
 * Models the real redeem choreography: a `(coupon_id, idempotency_key)` claim
 * (replay ⇒ recorded redemption, no second decrement) coupled with the guarded
 * `uses_count < max_uses` increment as one synchronous block — all-or-nothing,
 * so at `maxUses` no row is written and nothing is decremented. Release is the
 * mirror: delete the row + decrement (guarded `> 0`), idempotent.
 *
 * Being single-process it cannot exercise a real race; that's the
 * Postgres-required contract (`coupon-no-over-redeem.pg.test.ts`). Here it proves
 * the SQL SHAPE — replay, exhaustion, per-customer, release — is correct.
 */
export class InMemoryCouponStore implements CouponStore {
	#idGen: IdGen;
	#coupons = new Map<string, CouponRecord>();
	#byCode = new Map<string, string>();
	#redemptions = new Map<string, RedemptionRow>();

	constructor(options: { idGen: IdGen }) {
		this.#idGen = options.idGen;
	}

	async create(input: CreateCouponInput): Promise<CouponRecord> {
		const record: CouponRecord = {
			id: input.id,
			code: input.code,
			type: input.type,
			amountCents: input.amountCents,
			rateBps: input.rateBps,
			capCents: input.capCents,
			currency: input.currency,
			minSubtotalCents: input.minSubtotalCents,
			startsAt: input.startsAt,
			expiresAt: input.expiresAt,
			maxUses: input.maxUses,
			maxUsesPerCustomer: input.maxUsesPerCustomer,
			usesCount: 0,
		};
		this.#coupons.set(record.id, record);
		this.#byCode.set(record.code, record.id);
		return { ...record };
	}

	async findByCode(code: string): Promise<CouponRecord | null> {
		const id = this.#byCode.get(code);
		if (id === undefined) return null;
		const c = this.#coupons.get(id);
		return c === undefined ? null : { ...c };
	}

	async findById(couponId: string): Promise<CouponRecord | null> {
		const c = this.#coupons.get(couponId);
		return c === undefined ? null : { ...c };
	}

	async redeem(input: RedeemCouponInput): Promise<RedeemResult> {
		const coupon = this.#coupons.get(input.couponId);
		if (coupon === undefined) throw new Error(`unknown coupon: ${input.couponId}`);

		// Replay-by-claim: an existing (coupon, key) redemption short-circuits — no
		// second decrement (idempotency, mirrors INSERT … ON CONFLICT DO NOTHING).
		for (const r of this.#redemptions.values()) {
			if (r.couponId === input.couponId && r.idempotencyKey === input.idempotencyKey) {
				return { ok: true, redemptionId: r.id, replayed: true };
			}
		}

		// Per-customer cap (soft Phase-5 dependency): only enforced with a customerId.
		if (coupon.maxUsesPerCustomer !== null && input.customerId !== undefined) {
			let mine = 0;
			for (const r of this.#redemptions.values()) {
				if (r.couponId === input.couponId && r.customerId === input.customerId) mine++;
			}
			if (mine >= coupon.maxUsesPerCustomer) {
				return { ok: false, reason: "COUPON_MAX_PER_CUSTOMER" };
			}
		}

		// Guarded global max-uses — the atomic gate. At the boundary, roll back
		// (write no row) and report exhaustion.
		if (coupon.maxUses !== null && coupon.usesCount >= coupon.maxUses) {
			return { ok: false, reason: "COUPON_EXHAUSTED" };
		}

		// Claim + increment as one block.
		coupon.usesCount += 1;
		const id = this.#idGen.newId();
		this.#redemptions.set(id, {
			id,
			couponId: input.couponId,
			orderId: input.orderId,
			customerId: input.customerId ?? null,
			idempotencyKey: input.idempotencyKey,
			createdAt: input.createdAt,
		});
		return { ok: true, redemptionId: id, replayed: false };
	}

	async release(redemptionId: string): Promise<void> {
		const row = this.#redemptions.get(redemptionId);
		if (row === undefined) return; // already released / never redeemed: no-op
		this.#redemptions.delete(redemptionId);
		const coupon = this.#coupons.get(row.couponId);
		if (coupon !== undefined && coupon.usesCount > 0) coupon.usesCount -= 1;
	}

	async listRedemptionsCreatedBefore(cutoff: string): Promise<CouponRedemption[]> {
		return [...this.#redemptions.values()]
			.filter((r) => r.createdAt < cutoff)
			.map((r) => ({
				id: r.id,
				couponId: r.couponId,
				orderId: r.orderId as CouponRedemption["orderId"],
				customerId: r.customerId,
				idempotencyKey: r.idempotencyKey,
				createdAt: r.createdAt,
			}));
	}

	// -- test surface ---------------------------------------------------------

	/** Current uses_count for a coupon (contract assertions). */
	usesCount(couponId: string): number {
		return this.#coupons.get(couponId)?.usesCount ?? 0;
	}

	/** Number of live redemption rows for a coupon. */
	redemptionCount(couponId: string): number {
		let n = 0;
		for (const r of this.#redemptions.values()) if (r.couponId === couponId) n++;
		return n;
	}
}
