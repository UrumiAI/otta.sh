import {
	cents,
	currency as toCurrency,
	customerId as toCustomerId,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	type Clock,
	type CouponListFilter,
	type CouponListPage,
	type CouponListResult,
	type CouponRecord,
	type CouponRedemption,
	type CouponStore,
	type CouponSummary,
	type CouponType,
	type CreateCouponInput,
	type DeleteCouponResult,
	type IdGen,
	type RedeemCouponInput,
	type RedeemResult,
	type UpdateCouponInput,
	type UpdateCouponResult,
} from "@urumi/domain";
import type { Expression, ExpressionBuilder, Kysely, Selectable, SqlBool } from "kysely";
import { expressionBuilder, sql } from "kysely";
import type { CouponsTable, Database } from "./schema.js";

/** Guarded max-uses lost: the coupon is at its cap. Rolls the redeem tx back. */
class CouponExhaustedError extends Error {
	constructor() {
		super("coupon exhausted");
		this.name = "CouponExhaustedError";
	}
}

/** Per-customer cap lost: this customer already redeemed maxUsesPerCustomer. */
class CouponPerCustomerError extends Error {
	constructor() {
		super("coupon per-customer cap");
		this.name = "CouponPerCustomerError";
	}
}

export interface KyselyCouponStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	/** Stamps `created_at` on `create()` — the admin-list (`listCoupons`)
	 *  keyset ordering column (Increment 3). */
	clock: Clock;
}

/**
 * `CouponStore` over Kysely (§5), dialect-agnostic across better-sqlite3 and pg.
 *
 * `redeem` mirrors `InventoryStore.reserve` exactly:
 *   1. Replay short-circuit — a recorded `(coupon_id, idempotency_key)` redemption
 *      resolves without a second decrement.
 *   2. One short transaction: claim the redemption (`INSERT … ON CONFLICT
 *      (coupon_id, idempotency_key) DO NOTHING`), then the GUARDED single-statement
 *      max-uses increment (`UPDATE … WHERE uses_count < max_uses`) — coupled
 *      all-or-nothing. 0 rows from the guard ⇒ roll the whole tx back (no
 *      redemption row, no increment) and return `COUPON_EXHAUSTED`. This is the
 *      oversell-analogue: no over-redeem under concurrency.
 *
 * `release` is the mirror: delete the redemption + decrement (guarded `> 0`),
 * idempotent (releasing a released/absent id is a no-op).
 */
export class KyselyCouponStore implements CouponStore {
	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;

	constructor(options: KyselyCouponStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async create(input: CreateCouponInput): Promise<CouponRecord> {
		await this.#db
			.insertInto("coupons")
			.values({
				id: input.id,
				code: input.code,
				type: input.type,
				amount_cents: input.amountCents,
				rate_bps: input.rateBps,
				cap_cents: input.capCents,
				currency: input.currency,
				min_subtotal_cents: input.minSubtotalCents,
				starts_at: input.startsAt,
				expires_at: input.expiresAt,
				max_uses: input.maxUses,
				max_uses_per_customer: input.maxUsesPerCustomer,
				uses_count: 0,
				created_at: this.#clock.now().toISOString(),
			})
			.execute();
		return (await this.findById(input.id)) as CouponRecord;
	}

	async findByCode(code: string): Promise<CouponRecord | null> {
		const r = await this.#db
			.selectFrom("coupons")
			.selectAll()
			.where("code", "=", code)
			.executeTakeFirst();
		return r === undefined ? null : toRecord(r);
	}

	async findById(couponId: string): Promise<CouponRecord | null> {
		const r = await this.#db
			.selectFrom("coupons")
			.selectAll()
			.where("id", "=", couponId)
			.executeTakeFirst();
		return r === undefined ? null : toRecord(r);
	}

	/** LWW edit (port doc). `code`/`type`/`currency`/`uses_count` are untouched
	 *  (immutable identity/kind + store-owned counter). Zero rows ⇒ `not_found`. */
	async update(couponId: string, input: UpdateCouponInput): Promise<UpdateCouponResult> {
		const updated = await this.#db
			.updateTable("coupons")
			.set({
				amount_cents: input.amountCents,
				rate_bps: input.rateBps,
				cap_cents: input.capCents,
				min_subtotal_cents: input.minSubtotalCents,
				starts_at: input.startsAt,
				expires_at: input.expiresAt,
				max_uses: input.maxUses,
				max_uses_per_customer: input.maxUsesPerCustomer,
			})
			.where("id", "=", couponId)
			.returningAll()
			.executeTakeFirst();
		if (updated === undefined) return { ok: false, reason: "not_found" };
		return { ok: true, coupon: toRecord(updated) };
	}

	/**
	 * Forbid-if-redeemed delete (port doc): the DELETE is conditioned on NO
	 * `coupon_redemption` referencing the coupon, so a concurrent `redeem` can
	 * never orphan a redemption (the FK stays satisfied) and the reconciliation
	 * trail is preserved. Zero rows ⇒ classify unknown id vs still-redeemed.
	 */
	async delete(couponId: string): Promise<DeleteCouponResult> {
		const res = await this.#db
			.deleteFrom("coupons")
			.where("id", "=", couponId)
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("coupon_redemptions")
							.select("id")
							.whereRef("coupon_redemptions.coupon_id", "=", "coupons.id"),
					),
				),
			)
			.executeTakeFirst();
		if (Number(res.numDeletedRows) > 0) return { ok: true };
		const exists = await this.#db
			.selectFrom("coupons")
			.select("id")
			.where("id", "=", couponId)
			.executeTakeFirst();
		if (exists === undefined) return { ok: false, reason: "not_found" };
		return { ok: false, reason: "in_use_by_redemptions" };
	}

	async redeem(input: RedeemCouponInput): Promise<RedeemResult> {
		// 1. Replay short-circuit (mirrors reserve's replay-by-state).
		const existing = await this.#findRedemption(input.couponId, input.idempotencyKey);
		if (existing !== undefined) {
			return { ok: true, redemptionId: existing.id, replayed: true };
		}

		const redemptionId = this.#idGen.newId();
		try {
			return await this.#db.transaction().execute<RedeemResult>(async (trx) => {
				// 2a. Claim the redemption. A concurrent same-key peer makes this a
				//     no-op conflict (blocks until the peer commits) — re-read + replay.
				const claim = await trx
					.insertInto("coupon_redemptions")
					.values({
						id: redemptionId,
						coupon_id: input.couponId,
						order_id: input.orderId,
						customer_id: input.customerId ?? null,
						idempotency_key: input.idempotencyKey,
						created_at: input.createdAt,
					})
					.onConflict((oc) => oc.columns(["coupon_id", "idempotency_key"]).doNothing())
					.returning("id")
					.executeTakeFirst();
				if (claim === undefined) {
					const raced = await trx
						.selectFrom("coupon_redemptions")
						.select("id")
						.where("coupon_id", "=", input.couponId)
						.where("idempotency_key", "=", input.idempotencyKey)
						.executeTakeFirstOrThrow();
					return { ok: true, redemptionId: raced.id, replayed: true };
				}

				// 2b. Guarded global max-uses increment — the atomic oversell-analogue.
				//     This UPDATE takes a ROW LOCK on the coupon row, so EVERY concurrent
				//     redeem for this coupon serializes here (mirrors inventory reserve).
				const bumped = await trx
					.updateTable("coupons")
					.set({ uses_count: sql<number>`uses_count + 1` })
					.where("id", "=", input.couponId)
					.where((eb) =>
						eb.or([eb("max_uses", "is", null), eb("uses_count", "<", eb.ref("max_uses"))]),
					)
					.returning(["uses_count", "max_uses_per_customer"])
					.executeTakeFirst();
				if (bumped === undefined) throw new CouponExhaustedError();

				// 2c. Per-customer cap (review I3): checked AFTER the guarded UPDATE so it
				//     runs under the coupon-row lock acquired above. That lock serializes
				//     every same-coupon redeem, making this COUNT race-free under READ
				//     COMMITTED — a concurrent same-customer peer cannot reach here until we
				//     commit, and then it sees our committed redemption. The just-inserted
				//     own row is counted, so `> cap` means over the limit.
				if (input.customerId !== undefined && bumped.max_uses_per_customer !== null) {
					const { count } = await trx
						.selectFrom("coupon_redemptions")
						.select((eb) => eb.fn.countAll<number>().as("count"))
						.where("coupon_id", "=", input.couponId)
						.where("customer_id", "=", input.customerId)
						.executeTakeFirstOrThrow();
					if (Number(count) > bumped.max_uses_per_customer) throw new CouponPerCustomerError();
				}

				return { ok: true, redemptionId, replayed: false };
			});
		} catch (err) {
			if (err instanceof CouponExhaustedError) return { ok: false, reason: "COUPON_EXHAUSTED" };
			if (err instanceof CouponPerCustomerError)
				return { ok: false, reason: "COUPON_MAX_PER_CUSTOMER" };
			throw err;
		}
	}

	async release(redemptionId: string): Promise<void> {
		await this.#db.transaction().execute(async (trx) => {
			const deleted = await trx
				.deleteFrom("coupon_redemptions")
				.where("id", "=", redemptionId)
				.returning("coupon_id")
				.executeTakeFirst();
			if (deleted === undefined) return; // already released / never redeemed: no-op
			await trx
				.updateTable("coupons")
				.set({ uses_count: sql<number>`uses_count - 1` })
				.where("id", "=", deleted.coupon_id)
				.where("uses_count", ">", 0)
				.execute();
		});
	}

	async releaseByOrder(orderId: string): Promise<number> {
		return this.#db.transaction().execute(async (trx) => {
			const deleted = await trx
				.deleteFrom("coupon_redemptions")
				.where("order_id", "=", orderId)
				.returning("coupon_id")
				.execute();
			for (const row of deleted) {
				await trx
					.updateTable("coupons")
					.set({ uses_count: sql<number>`uses_count - 1` })
					.where("id", "=", row.coupon_id)
					.where("uses_count", ">", 0)
					.execute();
			}
			return deleted.length;
		});
	}

	async listRedemptionsCreatedBefore(cutoff: string): Promise<CouponRedemption[]> {
		const rows = await this.#db
			.selectFrom("coupon_redemptions")
			.selectAll()
			.where("created_at", "<", cutoff)
			.orderBy("created_at")
			.orderBy("id")
			.execute();
		return rows.map((r) => ({
			id: r.id,
			couponId: r.coupon_id,
			orderId: toOrderId(r.order_id),
			customerId: r.customer_id === null ? null : toCustomerId(r.customer_id),
			idempotencyKey: toIdempotencyKey(r.idempotency_key),
			createdAt: r.created_at,
		}));
	}

	/**
	 * Admin Coupons console list (view-only; admin-UX Increment 3 — the missing
	 * enumerate primitive, mirroring `listProducts`'s proven keyset shape 1:1).
	 * A single `coupons` SELECT — no join (the redeemed indicator is the
	 * already-stored `uses_count` column, not a correlated `EXISTS`). Ordered
	 * `created_at DESC, id DESC`; `search` is a case-insensitive EXACT match on
	 * `code` (port doc — deliberately NOT a substring, unlike `listProducts`'s
	 * title half). `limit + 1` next-page detection, exactly like `listProducts`.
	 */
	async listCoupons(filter: CouponListFilter, page: CouponListPage): Promise<CouponListResult> {
		let q = this.#db.selectFrom("coupons").selectAll();

		const conds = couponFilterConditions(filter);
		if (conds.length > 0) q = q.where((eb) => eb.and(conds));
		if (page.cursor !== undefined && page.cursor !== null) {
			const cursor = page.cursor;
			// (created_at < :c) OR (created_at = :c AND id < :cid) — everything
			// strictly "after" the cursor position under `created_at DESC, id DESC`.
			q = q.where((eb) =>
				eb.or([
					eb("coupons.created_at", "<", cursor.createdAt),
					eb.and([
						eb("coupons.created_at", "=", cursor.createdAt),
						eb("coupons.id", "<", cursor.couponId),
					]),
				]),
			);
		}

		const rows = await q
			.orderBy("coupons.created_at", "desc")
			.orderBy("coupons.id", "desc")
			.limit(page.limit + 1)
			.execute();

		const hasMore = rows.length > page.limit;
		const returned = hasMore ? rows.slice(0, page.limit) : rows;
		const last = returned.at(-1);
		const nextCursor =
			hasMore && last !== undefined ? { createdAt: last.created_at, couponId: last.id } : null;

		const coupons: CouponSummary[] = returned.map((r) => ({
			...toRecord(r),
			createdAt: r.created_at,
		}));
		return { coupons, nextCursor };
	}

	// -- internals ------------------------------------------------------------

	async #findRedemption(couponId: string, key: string): Promise<{ id: string } | undefined> {
		return this.#db
			.selectFrom("coupon_redemptions")
			.select("id")
			.where("coupon_id", "=", couponId)
			.where("idempotency_key", "=", key)
			.executeTakeFirst();
	}
}

/** The ONE `CouponListFilter` predicate `listCoupons` builds from (mirrors
 *  `productFilterConditions` — a single builder so semantics can never drift).
 *  Returns standalone expressions (a detached `expressionBuilder`) to AND onto
 *  the query. `search` is a case-insensitive EXACT match on `code` (port doc).
 *  Known, accepted divergence (PR #74 review, matches the existing search
 *  precedent in `productFilterConditions`): SQLite's built-in `lower()` folds
 *  ASCII only, while JS `toLowerCase()` is Unicode-aware — a non-ASCII coupon
 *  code (e.g. "ÉTÉ10") case-folds differently on sqlite than on pg/the fake. */
function couponFilterConditions(filter: CouponListFilter): Expression<SqlBool>[] {
	const eb: ExpressionBuilder<Database, "coupons"> = expressionBuilder();
	const conds: Expression<SqlBool>[] = [];
	if (filter.search !== undefined) {
		conds.push(eb(sql`lower(coupons.code)`, "=", filter.search.toLowerCase()));
	}
	return conds;
}

function toRecord(r: Selectable<CouponsTable>): CouponRecord {
	return {
		id: r.id,
		code: r.code,
		type: r.type as CouponType,
		amountCents: r.amount_cents === null ? null : cents(r.amount_cents),
		rateBps: r.rate_bps,
		capCents: r.cap_cents === null ? null : cents(r.cap_cents),
		currency: r.currency === null ? null : toCurrency(r.currency),
		minSubtotalCents: r.min_subtotal_cents === null ? null : cents(r.min_subtotal_cents),
		startsAt: r.starts_at,
		expiresAt: r.expires_at,
		maxUses: r.max_uses,
		maxUsesPerCustomer: r.max_uses_per_customer,
		usesCount: r.uses_count,
	};
}
