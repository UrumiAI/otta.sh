import type {
	AdjustLineInput,
	Cart,
	CartLine,
	CartStore,
	Clock,
	Currency,
	ExpiredHold,
	IdempotencyKey,
	IdGen,
	ReservationLifecycle,
	UpsertLineInput,
} from "@urumi/domain";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "./schema.js";

export interface KyselyCartStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	clock: Clock;
}

/**
 * `CartStore` over Kysely (§4/§6), dialect-agnostic across better-sqlite3 and pg.
 *
 * Each mutation is a SHORT transaction that co-locates the cart-line write, the
 * reservation-deadline stamp (`reservations.expires_at`), and the
 * `cart_mutations` idempotency-ledger entry on one connection — the adapter-level
 * optimization §6 permits (the domain never assumes it). Cross-store atomicity
 * with `reserve`/`adjust` is instead healed by idempotency + TTL. The oversell
 * invariant lives entirely in the inventory port; the cart adds no stock-moving
 * SQL of its own beyond stamping deadlines.
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
			.select(["id", "state", "currency"])
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
			currency: cart.currency as Currency,
			lines: rows.map((r) => this.#toLine(r)),
		};
	}

	async upsertLine(input: UpsertLineInput): Promise<CartLine> {
		return this.#db.transaction().execute(async (trx) => {
			const recorded = await trx
				.selectFrom("cart_mutations")
				.select("line_id")
				.where("idempotency_key", "=", input.key)
				.executeTakeFirst();
			if (recorded?.line_id != null) return this.#lineById(trx, recorded.line_id);

			const now = this.#clock.now().toISOString();
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

			// Co-locate: stamp the hold deadline so the sweep can reap an abandoned hold.
			await trx
				.updateTable("reservations")
				.set({ expires_at: input.expiresAt })
				.where("id", "=", input.reservationId)
				.execute();

			await trx
				.insertInto("cart_mutations")
				.values({
					idempotency_key: input.key,
					cart_id: input.cartId,
					line_id: upserted.id,
					kind: "add",
					resulting_qty: input.qty,
					created_at: now,
				})
				.onConflict((oc) => oc.column("idempotency_key").doNothing())
				.execute();

			return this.#lineById(trx, upserted.id);
		});
	}

	async adjustLine(input: AdjustLineInput): Promise<CartLine> {
		return this.#db.transaction().execute(async (trx) => {
			const recorded = await trx
				.selectFrom("cart_mutations")
				.select("line_id")
				.where("idempotency_key", "=", input.key)
				.executeTakeFirst();
			if (recorded !== undefined) return this.#lineById(trx, input.lineId);

			const now = this.#clock.now().toISOString();
			const line = await trx
				.selectFrom("cart_lines")
				.select("reservation_id")
				.where("id", "=", input.lineId)
				.executeTakeFirstOrThrow();

			await trx
				.updateTable("cart_lines")
				.set({ qty: input.newQty, expires_at: input.expiresAt, updated_at: now })
				.where("id", "=", input.lineId)
				.execute();

			if (line.reservation_id !== null) {
				await trx
					.updateTable("reservations")
					.set({ expires_at: input.expiresAt })
					.where("id", "=", line.reservation_id)
					.execute();
			}

			await trx
				.insertInto("cart_mutations")
				.values({
					idempotency_key: input.key,
					cart_id: input.cartId,
					line_id: input.lineId,
					kind: "adjust",
					resulting_qty: input.newQty,
					created_at: now,
				})
				.onConflict((oc) => oc.column("idempotency_key").doNothing())
				.execute();

			return this.#lineById(trx, input.lineId);
		});
	}

	async removeLine(cartId: string, lineId: string, key: IdempotencyKey): Promise<void> {
		await this.#db.transaction().execute(async (trx) => {
			const recorded = await trx
				.selectFrom("cart_mutations")
				.select("idempotency_key")
				.where("idempotency_key", "=", key)
				.executeTakeFirst();
			if (recorded !== undefined) return; // replay: already removed

			await trx
				.insertInto("cart_mutations")
				.values({
					idempotency_key: key,
					cart_id: cartId,
					line_id: lineId,
					kind: "remove",
					resulting_qty: null,
					created_at: this.#clock.now().toISOString(),
				})
				.onConflict((oc) => oc.column("idempotency_key").doNothing())
				.execute();

			await trx
				.deleteFrom("cart_lines")
				.where("id", "=", lineId)
				.where("cart_id", "=", cartId)
				.execute();
		});
	}

	async listExpired(now: string, cutoff: string): Promise<ExpiredHold[]> {
		// Every lapsed held reservation: those the cart stamped (`expires_at`
		// passed) plus a crashed hold whose cart-line write never landed
		// (`expires_at IS NULL`, reaped via `created_at` + TTL).
		const rows = await this.#db
			.selectFrom("reservations")
			.select("id")
			.where("state", "=", "held")
			.where((eb) =>
				eb.or([
					eb.and([eb("expires_at", "is not", null), eb("expires_at", "<=", now)]),
					eb.and([eb("expires_at", "is", null), eb("created_at", "<=", cutoff)]),
				]),
			)
			.execute();
		return rows.map((r) => ({ reservationId: r.id }));
	}

	async releaseExpired(reservationId: string): Promise<void> {
		// Ledger-free line drop; the guarded stock return is the caller's
		// `InventoryStore.release`.
		await this.#db.deleteFrom("cart_lines").where("reservation_id", "=", reservationId).execute();
	}

	// -- internals ------------------------------------------------------------

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
