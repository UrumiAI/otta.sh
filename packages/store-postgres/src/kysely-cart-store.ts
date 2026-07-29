import {
	type AdjustLineInput,
	type Cart,
	type CartLine,
	type CartStore,
	type ClaimMutationInput,
	type ClaimMutationResult,
	type Clock,
	type Currency,
	type ExpiredHold,
	HoldExpiredError,
	type IdempotencyKey,
	type IdGen,
	type OrderId,
	type RecordedCartMutation,
	type ReservationLifecycle,
	type UpsertLineInput,
} from "@urumi/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { CartMutationsTable, Database } from "./schema.js";

export interface KyselyCartStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	clock: Clock;
}

/**
 * `CartStore` over Kysely (§4/§6), dialect-agnostic across better-sqlite3 and pg.
 *
 * The `cart_mutations` ledger is claim/complete: the use-cases claim a key
 * (`INSERT … ON CONFLICT DO NOTHING`, `completed=0`) BEFORE any inventory
 * movement, and each mutation write here marks it `completed=1` in the same
 * short transaction as the cart-line write and the reservation-deadline stamp —
 * the adapter-level co-location §6 permits (the domain never assumes it).
 * Cross-store atomicity with `reserve`/`adjust` is healed by resuming an
 * incomplete claim + the TTL sweep. Expiry is the guarded `expireHold` flip:
 * the `held → released` transition re-checks the deadline in the same
 * conditional statement, and only the winner returns stock and drops lines.
 *
 * LOCK ORDER (deadlock freedom): every multi-table transaction here and in
 * `KyselyInventoryStore` acquires row locks in the fixed order
 * `reservations → inventory → cart_lines` — `upsertLine`/`adjustLine` stamp the
 * reservation BEFORE touching the line, matching `expireHold`
 * (flip → return → drop) and `adjust` (CAS → movement), so a shopper's
 * mutation racing the sweep on one hold cannot AB-BA deadlock.
 */
export class KyselyCartStore implements CartStore {
	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;

	constructor(options: KyselyCartStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async create(currency: Currency): Promise<string> {
		const id = this.#idGen.newId();
		const now = this.#clock.now().toISOString();
		await this.#db
			.insertInto("carts")
			.values({
				id,
				customer_id: null,
				state: "active",
				currency,
				created_at: now,
				updated_at: now,
			})
			.execute();
		return id;
	}

	async get(cartId: string): Promise<Cart | null> {
		const cart = await this.#db
			.selectFrom("carts")
			.select(["id", "state", "order_id", "currency"])
			.where("id", "=", cartId)
			.executeTakeFirst();
		if (cart === undefined) return null;

		const rows = await this.#db
			.selectFrom("cart_lines")
			.leftJoin("reservations", "reservations.id", "cart_lines.reservation_id")
			.select([
				"cart_lines.id as line_id",
				"cart_lines.cart_id as cart_id",
				"cart_lines.sku as sku",
				"cart_lines.product_id as product_id",
				"cart_lines.qty as qty",
				"cart_lines.reservation_id as reservation_id",
				"cart_lines.expires_at as expires_at",
				"reservations.state as reservation_state",
			])
			.where("cart_lines.cart_id", "=", cartId)
			.orderBy("cart_lines.id")
			.execute();

		return {
			cartId: cart.id,
			state: cart.state,
			orderId: cart.order_id,
			currency: cart.currency as Currency,
			lines: rows.map((r) => this.#toLine(r)),
		};
	}

	async recordedMutation(key: IdempotencyKey): Promise<RecordedCartMutation | null> {
		const row = await this.#db
			.selectFrom("cart_mutations")
			.selectAll()
			.where("idempotency_key", "=", key)
			.executeTakeFirst();
		return row === undefined ? null : toRecorded(row);
	}

	async claimMutation(input: ClaimMutationInput): Promise<ClaimMutationResult> {
		const claimed = await this.#db
			.insertInto("cart_mutations")
			.values({
				idempotency_key: input.key,
				cart_id: input.cartId,
				line_id: input.lineId ?? null,
				kind: input.kind,
				resulting_qty: null,
				completed: 0,
				created_at: this.#clock.now().toISOString(),
			})
			.onConflict((oc) => oc.column("idempotency_key").doNothing())
			.returning("idempotency_key")
			.executeTakeFirst();
		if (claimed !== undefined) return { claimed: true };

		const existing = await this.#db
			.selectFrom("cart_mutations")
			.selectAll()
			.where("idempotency_key", "=", input.key)
			.executeTakeFirstOrThrow();
		return { claimed: false, recorded: toRecorded(existing) };
	}

	async upsertLine(input: UpsertLineInput): Promise<CartLine> {
		return this.#db.transaction().execute(async (trx) => {
			const recorded = await trx
				.selectFrom("cart_mutations")
				.select(["line_id", "completed"])
				.where("idempotency_key", "=", input.key)
				.executeTakeFirst();
			if (recorded !== undefined && recorded.completed === 1 && recorded.line_id !== null) {
				return this.#lineById(trx, recorded.line_id);
			}

			const now = this.#clock.now().toISOString();

			// Reservation FIRST (lock order), and the deadline stamp doubles as the
			// attach guard: scoped to `state='held'`, so a reservation the sweep
			// already reaped (a crashed hold whose add is replayed late) matches 0
			// rows and the line is NOT resurrected over dead stock. A digital line
			// (Phase 4 §6) carries NO reservation — nothing to stamp or guard.
			if (input.reservationId !== null) {
				const stamped = await trx
					.updateTable("reservations")
					.set({ expires_at: input.expiresAt })
					.where("id", "=", input.reservationId)
					.where("state", "=", "held")
					.returning("id")
					.executeTakeFirst();
				if (stamped === undefined) throw new HoldExpiredError(input.reservationId);
			}

			const upserted = await trx
				.insertInto("cart_lines")
				.values({
					id: this.#idGen.newId(),
					cart_id: input.cartId,
					product_id: input.productId,
					sku: input.sku,
					qty: input.qty,
					reservation_id: input.reservationId,
					expires_at: input.expiresAt,
					created_at: now,
					updated_at: now,
				})
				.onConflict((oc) =>
					oc.columns(["cart_id", "sku"]).doUpdateSet({
						product_id: input.productId,
						qty: input.qty,
						reservation_id: input.reservationId,
						expires_at: input.expiresAt,
						updated_at: now,
					}),
				)
				.returning("id")
				.executeTakeFirstOrThrow();

			await this.#complete(trx, input.key, input.cartId, "add", upserted.id, input.qty);
			return this.#lineById(trx, upserted.id);
		});
	}

	async adjustLine(input: AdjustLineInput): Promise<CartLine> {
		return this.#db.transaction().execute(async (trx) => {
			const recorded = await trx
				.selectFrom("cart_mutations")
				.select(["line_id", "completed"])
				.where("idempotency_key", "=", input.key)
				.executeTakeFirst();
			if (recorded !== undefined && recorded.completed === 1) {
				return this.#lineById(trx, input.lineId);
			}

			const now = this.#clock.now().toISOString();
			const line = await trx
				.selectFrom("cart_lines")
				.select("reservation_id")
				.where("id", "=", input.lineId)
				.executeTakeFirstOrThrow();

			// Reservation FIRST (lock order: reservations → cart_lines, matching
			// expireHold), then the line — whose qty mirrors the reservation's own
			// qty (the inventory authority's serialized truth) when a hold exists,
			// so racing different-key adjusts converge instead of last-writer desync.
			if (line.reservation_id !== null) {
				await trx
					.updateTable("reservations")
					.set({ expires_at: input.expiresAt })
					.where("id", "=", line.reservation_id)
					.execute();
			}

			await trx
				.updateTable("cart_lines")
				.set({
					qty:
						line.reservation_id === null
							? input.newQty
							: (eb) =>
									eb
										.selectFrom("reservations")
										.select("reservations.qty")
										.whereRef("reservations.id", "=", "cart_lines.reservation_id"),
					expires_at: input.expiresAt,
					updated_at: now,
				})
				.where("id", "=", input.lineId)
				.execute();

			await this.#complete(trx, input.key, input.cartId, "adjust", input.lineId, input.newQty);
			return this.#lineById(trx, input.lineId);
		});
	}

	async removeLine(cartId: string, lineId: string, key: IdempotencyKey): Promise<void> {
		await this.#db.transaction().execute(async (trx) => {
			const recorded = await trx
				.selectFrom("cart_mutations")
				.select("completed")
				.where("idempotency_key", "=", key)
				.executeTakeFirst();
			if (recorded !== undefined && recorded.completed === 1) return; // replay

			await this.#complete(trx, key, cartId, "remove", lineId, null);
			await trx
				.deleteFrom("cart_lines")
				.where("id", "=", lineId)
				.where("cart_id", "=", cartId)
				.execute();
		});
	}

	async checkout(cartId: string, orderId: OrderId): Promise<boolean> {
		// Secondary cart-state fence (§5): guarded `active → checked_out`, which
		// also stamps the order the cart handed off to (issue #132). Idempotent
		// — a replay finds the cart already `checked_out` (0 rows) → false (success
		// for the same order). `checked_out` is terminal (nothing re-opens it).
		//
		// ONE statement sets BOTH columns, so state and order id are never
		// observable apart — and the UNCHANGED `state = 'active'` predicate IS the
		// CAS that makes the stamp write-once: a second checkout matches 0 rows and
		// writes neither column. No extra `order_id IS NULL` guard, no constraint.
		const flipped = await this.#db
			.updateTable("carts")
			.set({
				state: "checked_out",
				order_id: orderId,
				updated_at: this.#clock.now().toISOString(),
			})
			.where("id", "=", cartId)
			.where("state", "=", "active")
			.returning("id")
			.executeTakeFirst();
		return flipped !== undefined;
	}

	async listExpired(now: string, cutoff: string): Promise<ExpiredHold[]> {
		// Lapsed held holds: those the cart stamped (`expires_at` passed) plus a
		// CART-ORIGINATED crashed hold whose line write never landed (`expires_at
		// IS NULL`, reaped via `created_at` + TTL, scoped by its claim in the
		// `cart_mutations` ledger). A raw Phase-0 reserve — held, unstamped, no
		// ledger claim — is deliberately never listed: it awaits an explicit
		// commit/release, not the cart sweep.
		const rows = await this.#db
			.selectFrom("reservations")
			.select("id")
			.where("state", "=", "held")
			.where((eb) =>
				eb.or([
					eb.and([eb("expires_at", "is not", null), eb("expires_at", "<=", now)]),
					eb.and([
						eb("expires_at", "is", null),
						eb("created_at", "<=", cutoff),
						eb.exists(
							eb
								.selectFrom("cart_mutations")
								.select("cart_mutations.idempotency_key")
								.whereRef("cart_mutations.idempotency_key", "=", "reservations.idempotency_key"),
						),
					]),
				]),
			)
			.execute();
		return rows.map((r) => ({ reservationId: r.id }));
	}

	async expireHold(reservationId: string, now: string, cutoff: string): Promise<boolean> {
		return this.#db.transaction().execute(async (trx) => {
			// The guarded flip re-checks the deadline ATOMICALLY with the state
			// transition (plan §5): a hold whose TTL was reset between listing and
			// this statement no longer matches, and one that left `held` (adopted /
			// released) matches nothing either. 0 rows ⇒ quietly lose (never throw):
			// a lazy read racing the sweep, a TTL reset, or a checkout is normal.
			const flipped = await trx
				.updateTable("reservations")
				.set({ state: "released" })
				.where("id", "=", reservationId)
				.where("state", "=", "held")
				.where((eb) =>
					eb.or([
						eb.and([eb("expires_at", "is not", null), eb("expires_at", "<=", now)]),
						eb.and([
							eb("expires_at", "is", null),
							eb("created_at", "<=", cutoff),
							eb.exists(
								eb
									.selectFrom("cart_mutations")
									.select("cart_mutations.idempotency_key")
									.whereRef("cart_mutations.idempotency_key", "=", "reservations.idempotency_key"),
							),
						]),
					]),
				)
				.returning(["qty", "sku"])
				.executeTakeFirst();
			if (flipped === undefined) return false;

			// Only the flip winner returns the stock and drops the line(s) — all in
			// this same transaction, so the return happens exactly once.
			await trx
				.updateTable("inventory")
				.set({ on_hand: sql<number>`on_hand + ${flipped.qty}` })
				.where("sku", "=", flipped.sku)
				.execute();
			await trx.deleteFrom("cart_lines").where("reservation_id", "=", reservationId).execute();
			return true;
		});
	}

	// -- internals ------------------------------------------------------------

	/** Mark the ledger entry completed (insert-or-update: the claim may or may
	 *  not pre-exist, e.g. legacy callers or a peer's rolled-back claim). */
	async #complete(
		trx: Transaction<Database>,
		key: string,
		cartId: string,
		kind: "add" | "adjust" | "remove",
		lineId: string | null,
		resultingQty: number | null,
	): Promise<void> {
		await trx
			.insertInto("cart_mutations")
			.values({
				idempotency_key: key,
				cart_id: cartId,
				line_id: lineId,
				kind,
				resulting_qty: resultingQty,
				completed: 1,
				created_at: this.#clock.now().toISOString(),
			})
			.onConflict((oc) =>
				oc.column("idempotency_key").doUpdateSet({
					line_id: lineId,
					resulting_qty: resultingQty,
					completed: 1,
				}),
			)
			.execute();
	}

	async #lineById(trx: Transaction<Database>, lineId: string): Promise<CartLine> {
		const row = await trx
			.selectFrom("cart_lines")
			.leftJoin("reservations", "reservations.id", "cart_lines.reservation_id")
			.select([
				"cart_lines.id as line_id",
				"cart_lines.cart_id as cart_id",
				"cart_lines.sku as sku",
				"cart_lines.product_id as product_id",
				"cart_lines.qty as qty",
				"cart_lines.reservation_id as reservation_id",
				"cart_lines.expires_at as expires_at",
				"reservations.state as reservation_state",
			])
			.where("cart_lines.id", "=", lineId)
			.executeTakeFirstOrThrow();
		return this.#toLine(row);
	}

	#toLine(row: {
		line_id: string;
		cart_id: string;
		sku: string;
		product_id: string | null;
		qty: number;
		reservation_id: string | null;
		expires_at: string | null;
		reservation_state: string | null;
	}): CartLine {
		return {
			lineId: row.line_id,
			cartId: row.cart_id,
			sku: row.sku,
			productId: row.product_id,
			qty: row.qty,
			reservationId: row.reservation_id,
			reservationState:
				row.reservation_state === null ? null : (row.reservation_state as ReservationLifecycle),
			expiresAt: row.expires_at,
		};
	}
}

function toRecorded(row: CartMutationsTable): RecordedCartMutation {
	return {
		key: row.idempotency_key as IdempotencyKey,
		cartId: row.cart_id,
		kind: row.kind,
		lineId: row.line_id,
		resultingQty: row.resulting_qty,
		completed: row.completed === 1,
	};
}
