import type { CustomerId, IdempotencyKey } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	CouponListFilter,
	CouponListPage,
	CouponListResult,
	CouponRecord,
	CouponRedemption,
	CouponStore,
	CouponSummary,
	CreateCouponInput,
	DeleteCouponResult,
	RedeemCouponInput,
	RedeemResult,
	UpdateCouponInput,
	UpdateCouponResult,
} from "../ports/coupon-store.js";
import type { CouponType } from "../pricing/types.js";

interface RedemptionRow {
	id: string;
	couponId: string;
	orderId: string;
	customerId: CustomerId | null;
	idempotencyKey: IdempotencyKey;
	createdAt: string;
}

/** Internal storage row — `CouponRecord` plus the admin-list ordering column
 *  (NOT part of the public `CouponRecord`; `createdAt` is exposed only via
 *  `CouponSummary` / `listCoupons`, mirroring how `ProductCommerce` carries
 *  fields `ProductSummary` alone projects). */
interface StoredCoupon extends CouponRecord {
	createdAt: Date;
}

/** Test-only seed shape for the admin-list contract — a direct coupon row (no
 *  `create()`/clock dance), so a case can pin an EXACT `createdAt` per row
 *  (mirrors `SeedProductSummaryRow`: distinct clocks for ordering, identical
 *  clocks for the tie-break). Mirrors the columns `KyselyCouponStore.
 *  listCoupons` reads, so the fake and the SQL agree byte-for-byte. */
export interface SeedCouponSummaryRow {
	id: string;
	code: string;
	type?: CouponType;
	amountCents?: number | null;
	rateBps?: number | null;
	capCents?: number | null;
	currency?: string | null;
	minSubtotalCents?: number | null;
	startsAt?: string | null;
	expiresAt?: string | null;
	maxUses?: number | null;
	maxUsesPerCustomer?: number | null;
	usesCount?: number;
	createdAt: string;
}

/** Descending code-unit string comparison (`>` first) — the SAME plain
 *  code-unit ordering `ProductCommerceStore`'s/`OrderStore`'s admin-list fakes
 *  use, so every admin list fake stays internally consistent (never
 *  `localeCompare`). */
function codeUnitDesc(a: string, b: string): number {
	return a > b ? -1 : a < b ? 1 : 0;
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
	#clock: Clock;
	#coupons = new Map<string, StoredCoupon>();
	#byCode = new Map<string, string>();
	#redemptions = new Map<string, RedemptionRow>();

	constructor(options: { idGen: IdGen; clock: Clock }) {
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async create(input: CreateCouponInput): Promise<CouponRecord> {
		const record: StoredCoupon = {
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
			createdAt: this.#clock.now(),
		};
		this.#coupons.set(record.id, record);
		this.#byCode.set(record.code, record.id);
		return { ...toRecord(record) };
	}

	async findByCode(code: string): Promise<CouponRecord | null> {
		const id = this.#byCode.get(code);
		if (id === undefined) return null;
		const c = this.#coupons.get(id);
		return c === undefined ? null : toRecord(c);
	}

	async findById(couponId: string): Promise<CouponRecord | null> {
		const c = this.#coupons.get(couponId);
		return c === undefined ? null : toRecord(c);
	}

	/** LWW edit of a coupon's economics/window (port doc). `code`/`type`/
	 *  `usesCount`/`createdAt` are untouched (immutable identity + store-owned
	 *  counter + ordering column). */
	async update(couponId: string, input: UpdateCouponInput): Promise<UpdateCouponResult> {
		const coupon = this.#coupons.get(couponId);
		if (coupon === undefined) return { ok: false, reason: "not_found" };
		coupon.amountCents = input.amountCents;
		coupon.rateBps = input.rateBps;
		coupon.capCents = input.capCents;
		coupon.minSubtotalCents = input.minSubtotalCents;
		coupon.startsAt = input.startsAt;
		coupon.expiresAt = input.expiresAt;
		coupon.maxUses = input.maxUses;
		coupon.maxUsesPerCustomer = input.maxUsesPerCustomer;
		return { ok: true, coupon: toRecord(coupon) };
	}

	/** Forbid-if-redeemed: a coupon with ≥1 redemption cannot be deleted (port
	 *  doc). Idempotent no-op for an unknown id. */
	async delete(couponId: string): Promise<DeleteCouponResult> {
		if (!this.#coupons.has(couponId)) return { ok: false, reason: "not_found" };
		for (const r of this.#redemptions.values()) {
			if (r.couponId === couponId) return { ok: false, reason: "in_use_by_redemptions" };
		}
		const coupon = this.#coupons.get(couponId);
		if (coupon !== undefined) this.#byCode.delete(coupon.code);
		this.#coupons.delete(couponId);
		return { ok: true };
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

	async releaseByOrder(orderId: string): Promise<number> {
		let released = 0;
		for (const [id, row] of this.#redemptions) {
			if (row.orderId !== orderId) continue;
			this.#redemptions.delete(id);
			const coupon = this.#coupons.get(row.couponId);
			if (coupon !== undefined && coupon.usesCount > 0) coupon.usesCount -= 1;
			released++;
		}
		return released;
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

	// -- Admin Coupons console: view-only keyset list (admin-UX Increment 3) --

	/** The ONE `CouponListFilter` predicate (mirrors `InMemoryProductCommerceStore
	 *  .#matchesFilter` / the Kysely adapter's shared predicate builder). */
	#matchesFilter(row: StoredCoupon, filter: CouponListFilter): boolean {
		if (filter.search !== undefined && row.code.toLowerCase() !== filter.search.toLowerCase()) {
			return false;
		}
		return true;
	}

	async listCoupons(filter: CouponListFilter, page: CouponListPage): Promise<CouponListResult> {
		// EXACT parity with `KyselyCouponStore.listCoupons` (mirrors
		// `InMemoryProductCommerceStore.listProducts`): same filter, same
		// `created_at DESC, id DESC` order, same `limit + 1` next-page detection.
		const cursor = page.cursor ?? null;

		const matched = [...this.#coupons.values()]
			.filter((row) => {
				if (!this.#matchesFilter(row, filter)) return false;
				if (cursor !== null) {
					const createdAt = row.createdAt.toISOString();
					if (createdAt > cursor.createdAt) return false;
					if (createdAt === cursor.createdAt && row.id >= cursor.couponId) return false;
				}
				return true;
			})
			.toSorted((a, b) => {
				const aCreated = a.createdAt.toISOString();
				const bCreated = b.createdAt.toISOString();
				return aCreated === bCreated
					? codeUnitDesc(a.id, b.id) // id DESC
					: codeUnitDesc(aCreated, bCreated); // created_at DESC
			});

		const window = matched.slice(0, page.limit + 1);
		const hasMore = window.length > page.limit;
		const rows = hasMore ? window.slice(0, page.limit) : window;
		const last = rows.at(-1);
		const nextCursor =
			hasMore && last !== undefined
				? { createdAt: last.createdAt.toISOString(), couponId: last.id }
				: null;
		return { coupons: rows.map((row) => toSummary(row)), nextCursor };
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

	/** TEST-ONLY: directly seed a coupon row for the admin-list contract with an
	 *  EXACT `createdAt` (mirrors `InMemoryProductCommerceStore.seedProductRow`).
	 *  Not part of `CouponStore`. */
	seedCouponRow(row: SeedCouponSummaryRow): void {
		const record: StoredCoupon = {
			id: row.id,
			code: row.code,
			type: row.type ?? "fixed_amount",
			amountCents: (row.amountCents ?? null) as CouponRecord["amountCents"],
			rateBps: row.rateBps ?? null,
			capCents: (row.capCents ?? null) as CouponRecord["capCents"],
			currency: (row.currency ?? null) as CouponRecord["currency"],
			minSubtotalCents: (row.minSubtotalCents ?? null) as CouponRecord["minSubtotalCents"],
			startsAt: row.startsAt ?? null,
			expiresAt: row.expiresAt ?? null,
			maxUses: row.maxUses ?? null,
			maxUsesPerCustomer: row.maxUsesPerCustomer ?? null,
			usesCount: row.usesCount ?? 0,
			createdAt: new Date(row.createdAt),
		};
		this.#coupons.set(record.id, record);
		this.#byCode.set(record.code, record.id);
	}
}

/** Project a `StoredCoupon` down to the public `CouponRecord` (drops the
 *  admin-list-only `createdAt`). */
function toRecord(row: StoredCoupon): CouponRecord {
	return {
		id: row.id,
		code: row.code,
		type: row.type,
		amountCents: row.amountCents,
		rateBps: row.rateBps,
		capCents: row.capCents,
		currency: row.currency,
		minSubtotalCents: row.minSubtotalCents,
		startsAt: row.startsAt,
		expiresAt: row.expiresAt,
		maxUses: row.maxUses,
		maxUsesPerCustomer: row.maxUsesPerCustomer,
		usesCount: row.usesCount,
	};
}

/** Project a `StoredCoupon` to the admin-list `CouponSummary` (adds
 *  `createdAt` as ISO-8601 text, mirroring `ProductSummary`'s wire-adjacent
 *  text timestamp). */
function toSummary(row: StoredCoupon): CouponSummary {
	return { ...toRecord(row), createdAt: row.createdAt.toISOString() };
}
