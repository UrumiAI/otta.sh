import {
	type AdoptInput,
	type AdoptManyInput,
	type AdoptManyResult,
	type AdoptResult,
	AdjustReservationMismatchError,
	type Clock,
	type CommitManyResult,
	type IdGen,
	type IdempotencyKey,
	type InventoryStore,
	ReservationCommitLostError,
	ReservationNotHeldError,
	type ReserveResult,
} from "@urumi/domain";
import { type Kysely, sql } from "kysely";
import type { Database, ReservationState } from "./schema.js";

/** Losing the guarded finalize flip: another caller owns this reservation. */
const LOST = Symbol("finalize-lost");
type FinalizeOutcome = ReserveResult | typeof LOST;

/** Internal: aborts the adjust tx (rolling back its claim) when the guarded CAS
 *  matches 0 rows — a different-key adjust or a checkout raced the hold. */
class LostCasError extends Error {
	constructor() {
		super("adjust lost the guarded reservation CAS");
	}
}

export interface KyselyInventoryStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	clock: Clock;
	/** Bounded re-read loop while awaiting a peer's finalize (replay `pending` branch). */
	await?: { maxAttempts?: number; delayMs?: number };
}

/**
 * `InventoryStore` over Kysely (§0.4/§0.5), dialect-agnostic across
 * better-sqlite3 and pg.
 *
 * `reserve` is the finalize choreography from §0.5:
 *   1. idempotency claim — `INSERT … ON CONFLICT (idempotency_key) DO NOTHING
 *      RETURNING id` (single statement, autocommit).
 *   2. finalize — a SHORT transaction on one connection coupling the
 *      state-guarded `pending → held` flip with the conditional decrement so
 *      `held ⟺ a durable decrement`. On a 0-row decrement the same tx sets
 *      `failed` and returns OUT_OF_STOCK; on losing the guarded flip it falls
 *      to a bounded re-read of `state` until terminal.
 * A replay (no row from the claim) resolves the reservation's stored `state`
 * (held ⇒ ok, failed ⇒ OUT_OF_STOCK, pending ⇒ finalize-or-await) — never a
 * blind ok.
 */
export class KyselyInventoryStore implements InventoryStore {
	/** Test hook: invoked inside the finalize tx after the `held` flip, before
	 *  the decrement — used to inject the W2 fault or force an ordering. */
	readonly hooks: { beforeDecrement?: (reservationId: string) => Promise<void> | void } = {};

	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #maxAttempts: number;
	readonly #delayMs: number;

	constructor(options: KyselyInventoryStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#maxAttempts = options.await?.maxAttempts ?? 200;
		this.#delayMs = options.await?.delayMs ?? 5;
	}

	async reserve(sku: string, qty: number, key: IdempotencyKey): Promise<ReserveResult> {
		if (!Number.isSafeInteger(qty) || qty <= 0) {
			throw new RangeError(`reserve() requires a positive integer qty, got ${String(qty)}`);
		}

		// 1. Idempotency claim. The `reservations.sku → inventory.sku` FK means an
		// unknown/unseeded sku raises an FK violation here (no inventory row to
		// reference), which maps to OUT_OF_STOCK below.
		let claim: { id: string } | undefined;
		try {
			claim = await this.#db
				.insertInto("reservations")
				.values({
					id: this.#idGen.newId(),
					sku,
					qty,
					state: "pending",
					idempotency_key: key,
					created_at: this.#clock.now().toISOString(),
				})
				.onConflict((oc) => oc.column("idempotency_key").doNothing())
				.returning("id")
				.executeTakeFirst();
		} catch (err) {
			// Unknown-sku FK abort: no reservation row is written, so the key is NOT
			// consumed — a pre-claim rejection OUTSIDE R2's idempotency scope ("no
			// product row ⇒ no idempotency scope"). A later replay of the same key
			// against a now-seeded sku is therefore a fresh reserve. This is distinct
			// from a genuine OUT_OF_STOCK on a known sku, which stays `failed` and
			// keeps the key consumed (R2).
			if (isForeignKeyViolation(err)) return { ok: false, reason: "OUT_OF_STOCK" };
			throw err;
		}

		if (claim !== undefined) {
			// Freshly claimed by this caller — finalize as the claimant.
			return this.#finalizeOrAwait(claim.id, sku, qty);
		}

		// 2. Key already claimed — resolve from the stored state (replay-by-state).
		const existing = await this.#selectByKey(key);
		return this.#resolveState(existing.id, existing.state, existing.sku, existing.qty);
	}

	async commit(reservationId: string): Promise<void> {
		// GUARD-FIRST (defense-in-depth, not SELECT-then-UPDATE): the conditional
		// flip itself is the authority — a hold that leaves `held|adopted` between
		// any read and this statement can never be silently "committed". Widened
		// (Phase 4 §5) to accept `adopted` alongside Phase-0's `held`.
		const flipped = await this.#db
			.updateTable("reservations")
			.set({ state: "committed" })
			.where("id", "=", reservationId)
			.where("state", "in", ["held", "adopted"])
			.returning("id")
			.executeTakeFirst();
		if (flipped !== undefined) return;

		// 0 rows: re-read to distinguish the benign idempotent replay (already
		// `committed`) from a LOST hold (released/failed/unknown) — the latter is
		// the loud anomaly (§5), never a silent no-op.
		const row = await this.#selectById(reservationId);
		if (row.state === "committed") return; // double-commit / idempotent replay: no-op
		throw new ReservationCommitLostError(reservationId, row.state);
	}

	async release(reservationId: string): Promise<void> {
		const row = await this.#selectById(reservationId);
		if (row.state === "released") return; // double-release: no-op
		// Widened (Phase 4 §5) to accept `adopted` alongside Phase-0's `held`.
		if (row.state !== "held" && row.state !== "adopted") {
			throw new Error(`cannot release reservation ${reservationId} in state ${row.state}`);
		}
		// Flip `held|adopted → released` and return the stock all-or-nothing; the
		// state guard makes exactly one caller increment (no double return).
		await this.#db.transaction().execute(async (trx) => {
			const flipped = await trx
				.updateTable("reservations")
				.set({ state: "released" })
				.where("id", "=", reservationId)
				.where("state", "in", ["held", "adopted"])
				.returning("id")
				.executeTakeFirst();
			if (flipped === undefined) return; // lost the race: peer already released
			await trx
				.updateTable("inventory")
				.set({ on_hand: sql<number>`on_hand + ${row.qty}` })
				.where("sku", "=", row.sku)
				.execute();
		});
	}

	/**
	 * Order-scoped release (review G2): the guarded `adopted → released` flip
	 * additionally scoped `WHERE order_id = :orderId`, so an order can only ever
	 * release a hold IT adopted. 0 rows is ALWAYS a silent no-op — already
	 * released/committed (benign replay), adopted by another order, or still
	 * cart-`held` (not this order's to touch). Never throws on state: an unscoped
	 * release here is how a stale order could free a live checkout's hold, or
	 * crash the expiry sweep forever on a committed one.
	 */
	async releaseAdopted(reservationId: string, orderId: string): Promise<void> {
		const row = await this.#db
			.selectFrom("reservations")
			.select(["sku", "qty"])
			.where("id", "=", reservationId)
			.executeTakeFirst();
		if (row === undefined) return; // unknown id: nothing to release
		await this.#db.transaction().execute(async (trx) => {
			const flipped = await trx
				.updateTable("reservations")
				.set({ state: "released" })
				.where("id", "=", reservationId)
				.where("state", "=", "adopted")
				.where("order_id", "=", orderId)
				.returning("id")
				.executeTakeFirst();
			if (flipped === undefined) return; // not this order's adopted hold: no-op
			await trx
				.updateTable("inventory")
				.set({ on_hand: sql<number>`on_hand + ${row.qty}` })
				.where("sku", "=", row.sku)
				.execute();
		});
	}

	/**
	 * The guarded `held → adopted` flip (Phase 4 §5): a single conditional
	 * statement, no interactive transaction. Scoped `state='held' AND expires_at >
	 * :now`, so it can never adopt a hold the Phase-3 sweep is about to reap. Sets
	 * `order_id` and re-points `expires_at` to the order's hold deadline, taking the
	 * hold out of the `held`-scoped sweep's reach. 0 rows ⇒ re-read: an already-
	 * `adopted` row for THIS order is an idempotent replay (ok); anything else is
	 * `RESERVATION_LOST`.
	 */
	async adopt(input: AdoptInput): Promise<AdoptResult> {
		const flipped = await this.#db
			.updateTable("reservations")
			.set({ state: "adopted", order_id: input.orderId, expires_at: input.holdExpiresAt })
			.where("id", "=", input.reservationId)
			.where("state", "=", "held")
			.where("expires_at", ">", input.now)
			.returning("id")
			.executeTakeFirst();
		if (flipped !== undefined) return { ok: true };

		const row = await this.#db
			.selectFrom("reservations")
			.select(["state", "order_id"])
			.where("id", "=", input.reservationId)
			.executeTakeFirst();
		if (row?.state === "adopted" && row.order_id === input.orderId) return { ok: true };
		return { ok: false, reason: "RESERVATION_LOST" };
	}

	/**
	 * Batched `adopt` (PR B): one order's physical `held → adopted` flips folded
	 * into a SINGLE guarded `UPDATE … WHERE id IN (:ids) AND state='held' AND
	 * expires_at > :now`, then ONE classification `SELECT` over the misses. Per-id
	 * semantics are `adopt`'s, byte-for-byte:
	 *  - a flipped row ⇒ `adopted`;
	 *  - a 0-row id that is already `adopted` for THIS order ⇒ idempotent replay,
	 *    folded into `adopted` — NO `expires_at` predicate on the classification
	 *    (singular `adopt`'s replay branch ignores it, so an adopted-for-this-order
	 *    hold past its deadline is still success, never lost);
	 *  - every other missing id — wrong state, another order, or UNKNOWN (no row) —
	 *    is `RESERVATION_LOST` (in `lost`), matching singular `adopt` (which returns
	 *    `RESERVATION_LOST`, not a throw, for an unknown id).
	 * Empty ids short-circuit (no DB round trip — `IN ()` is invalid SQL).
	 */
	async adoptMany(input: AdoptManyInput): Promise<AdoptManyResult> {
		const { reservationIds, orderId, holdExpiresAt, now } = input;
		if (reservationIds.length === 0) return { adopted: [], lost: [] };

		const flipped = await this.#db
			.updateTable("reservations")
			.set({ state: "adopted", order_id: orderId, expires_at: holdExpiresAt })
			.where("id", "in", reservationIds)
			.where("state", "=", "held")
			.where("expires_at", ">", now)
			.returning("id")
			.execute();
		const adopted = flipped.map((r) => r.id);

		const adoptedSet = new Set(adopted);
		const missing = reservationIds.filter((id) => !adoptedSet.has(id));
		if (missing.length === 0) return { adopted, lost: [] };

		const rows = await this.#db
			.selectFrom("reservations")
			.select(["id", "state", "order_id"])
			.where("id", "in", missing)
			.execute();
		const rowById = new Map(rows.map((r) => [r.id, r]));
		const lost: string[] = [];
		for (const id of missing) {
			const row = rowById.get(id);
			// Idempotent replay: adopted-for-THIS-order ⇒ success (no expires_at check,
			// matching singular adopt). Everything else (incl. unknown) ⇒ lost.
			if (row !== undefined && row.state === "adopted" && row.order_id === orderId) {
				adopted.push(id);
			} else {
				lost.push(id);
			}
		}
		return { adopted, lost };
	}

	/**
	 * Batched `commit` (PR B): a paid order's physical `held|adopted → committed`
	 * flips folded into a SINGLE guarded `UPDATE … WHERE id IN (:ids) AND state IN
	 * ('held','adopted')`, then ONE classification `SELECT` over the misses.
	 * Deliberately order-UNSCOPED, exactly like singular `commit`. Per-id semantics
	 * are `commit`'s, byte-for-byte:
	 *  - a flipped row ⇒ benign success (absent from `lost`);
	 *  - a 0-row id that is already `committed` ⇒ benign idempotent replay (dropped);
	 *  - a 0-row id in any OTHER existing state (released/failed/…) ⇒ LOST;
	 *  - a 0-row id with NO row (unknown) ⇒ THROW a bare Error, matching singular
	 *    `commit`'s `#selectById` — never folded into `lost`.
	 * Empty ids short-circuit (no DB round trip).
	 */
	async commitMany(reservationIds: string[]): Promise<CommitManyResult> {
		if (reservationIds.length === 0) return { lost: [] };

		const flipped = await this.#db
			.updateTable("reservations")
			.set({ state: "committed" })
			.where("id", "in", reservationIds)
			.where("state", "in", ["held", "adopted"])
			.returning("id")
			.execute();
		const committedSet = new Set(flipped.map((r) => r.id));
		const missing = reservationIds.filter((id) => !committedSet.has(id));
		if (missing.length === 0) return { lost: [] };

		const rows = await this.#db
			.selectFrom("reservations")
			.select(["id", "state"])
			.where("id", "in", missing)
			.execute();
		const stateById = new Map(rows.map((r) => [r.id, r.state]));
		const lost: string[] = [];
		for (const id of missing) {
			const state = stateById.get(id);
			if (state === undefined) {
				// Unknown id: match singular commit's #selectById, which throws a bare
				// Error — a truly-unknown id PROPAGATES, never folded into lost.
				throw new Error(`unknown reservation: ${id}`);
			}
			if (state === "committed") continue; // benign idempotent replay
			lost.push(id);
		}
		return { lost };
	}

	/**
	 * Additive (Phase 1 §8 Risk 4): create-if-absent initial stock write, a
	 * single portable statement — `INSERT … ON CONFLICT (sku) DO NOTHING` —
	 * NOT part of the reserve/commit/release finalize choreography. It can
	 * never clobber a concurrent reserve/release/adjust because a conflict
	 * leaves the existing row untouched.
	 */
	async seedOnHand(sku: string, qty: number): Promise<void> {
		if (!Number.isSafeInteger(qty) || qty < 0) {
			throw new RangeError(`seedOnHand() requires a non-negative integer, got ${String(qty)}`);
		}
		await this.#db
			.insertInto("inventory")
			.values({ sku, on_hand: qty })
			.onConflict((oc) => oc.column("sku").doNothing())
			.execute();
	}

	/** Additive (admin-UX Increment 2, product detail): a bare `SELECT on_hand
	 *  FROM inventory WHERE sku = :sku` — a single-row read, no join, no
	 *  idempotency key. A missing row reads as `0` (mirrors `listCommerceByIds`'s
	 *  LEFT JOIN "no row ⇒ out of stock" semantics). */
	async getOnHand(sku: string): Promise<number> {
		const row = await this.#db
			.selectFrom("inventory")
			.select("on_hand")
			.where("sku", "=", sku)
			.executeTakeFirst();
		return row?.on_hand ?? 0;
	}

	async adjust(reservationId: string, newQty: number, key: IdempotencyKey): Promise<ReserveResult> {
		if (!Number.isSafeInteger(newQty) || newQty <= 0) {
			throw new RangeError(`adjust() requires a positive integer newQty, got ${String(newQty)}`);
		}

		// Exactly-once choreography (mirrors reserve's claim discipline):
		//   1. ledger-first — a recorded `inventory_adjustments` row for `key`
		//      short-circuits to its outcome: a replay (even a stale one after
		//      later same-reservation adjusts) moves NOTHING.
		//   2. one short tx: claim the key (`INSERT … ON CONFLICT DO NOTHING`),
		//      then a guarded CAS on the reservation (`WHERE state='held' AND
		//      qty=:prev`) BEFORE the movement, then the conditional movement.
		//      Claim + CAS + movement commit all-or-nothing, so only the claim
		//      winner moves stock and `held` qty ⟺ the durable movement.
		//   3. a lost CAS (a different-key adjust or a checkout raced the row)
		//      rolls the tx back — claim included — and retries with fresh reads;
		//      a hold no longer `held` throws `ReservationNotHeldError` (typed,
		//      guard-first: no movement ever lands against a non-held hold).
		for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
			const recorded = await this.#db
				.selectFrom("inventory_adjustments")
				.select(["outcome", "reservation_id"])
				.where("idempotency_key", "=", key)
				.executeTakeFirst();
			if (recorded !== undefined) {
				// A key recorded against a DIFFERENT reservation is a mis-keyed
				// caller: typed rejection, never an ok echoed for the wrong hold.
				if (recorded.reservation_id !== reservationId) {
					throw new AdjustReservationMismatchError(key, recorded.reservation_id, reservationId);
				}
				return recorded.outcome === "ok"
					? { ok: true, reservationId }
					: { ok: false, reason: "OUT_OF_STOCK" };
			}

			const row = await this.#selectById(reservationId);
			if (row.state !== "held") {
				throw new ReservationNotHeldError(reservationId, row.state);
			}
			const prevQty = row.qty;
			const delta = newQty - prevQty;

			const outcome = await this.#db
				.transaction()
				.execute<ReserveResult | typeof LOST>(async (trx) => {
					// Claim: exactly one caller per key proceeds to move inventory. A
					// concurrent same-key peer blocks here until this tx resolves, then
					// falls to the recorded row (or retries if this tx aborted).
					const claim = await trx
						.insertInto("inventory_adjustments")
						.values({
							idempotency_key: key,
							reservation_id: reservationId,
							to_qty: newQty,
							outcome: "ok",
							created_at: this.#clock.now().toISOString(),
						})
						.onConflict((oc) => oc.column("idempotency_key").doNothing())
						.returning("idempotency_key")
						.executeTakeFirst();
					if (claim === undefined) return LOST; // peer holds the key: re-read

					if (delta === 0) return { ok: true, reservationId };

					// Guard-first CAS: move the reservation to `newQty` only if it is
					// still `held` at the qty we computed the delta from. This row lock
					// serializes every adjust/checkout on the hold; 0 rows ⇒ the state
					// or qty changed under us ⇒ roll everything back and re-read.
					const cas = await trx
						.updateTable("reservations")
						.set({ qty: newQty })
						.where("id", "=", reservationId)
						.where("state", "=", "held")
						.where("qty", "=", prevQty)
						.returning("id")
						.executeTakeFirst();
					if (cas === undefined) throw new LostCasError();

					if (delta > 0) {
						// Increase: oversell-critical single conditional decrement.
						const decremented = await trx
							.updateTable("inventory")
							.set({ on_hand: sql<number>`on_hand - ${delta}` })
							.where("sku", "=", row.sku)
							.where("on_hand", ">=", delta)
							.returning("on_hand")
							.executeTakeFirst();
						if (decremented === undefined) {
							// OUT_OF_STOCK: restore the reservation qty and record the failed
							// outcome in the SAME tx (key stays consumed, R2) — externally the
							// hold never moved.
							await trx
								.updateTable("reservations")
								.set({ qty: prevQty })
								.where("id", "=", reservationId)
								.execute();
							await trx
								.updateTable("inventory_adjustments")
								.set({ outcome: "out_of_stock" })
								.where("idempotency_key", "=", key)
								.execute();
							return { ok: false, reason: "OUT_OF_STOCK" };
						}
						return { ok: true, reservationId };
					}

					// Decrease: unconditional partial release, always succeeds.
					await trx
						.updateTable("inventory")
						.set({ on_hand: sql<number>`on_hand + ${-delta}` })
						.where("sku", "=", row.sku)
						.execute();
					return { ok: true, reservationId };
				})
				.catch((err: unknown): ReserveResult | typeof LOST => {
					if (err instanceof LostCasError) return LOST;
					throw err;
				});

			if (outcome !== LOST) return outcome;
			await delay(this.#delayMs);
		}
		throw new Error(`adjust of reservation ${reservationId} did not settle in time`);
	}

	// -- internals ------------------------------------------------------------

	async #resolveState(
		id: string,
		state: ReservationState,
		sku: string,
		qty: number,
	): Promise<ReserveResult> {
		switch (state) {
			case "held":
			case "committed":
			case "released":
			case "adopted":
				// `held` (and its post-commit/release/adopt terminals) is proof the
				// stock was durably removed together with the flip.
				return { ok: true, reservationId: id };
			case "failed":
				return { ok: false, reason: "OUT_OF_STOCK" };
			case "pending":
				// Claimed but never finalized (in-flight peer or a crash after the
				// claim). A `pending` row proves no decrement committed, so it is
				// safe to run the finalize ourselves, racing whoever else observes it.
				return this.#finalizeOrAwait(id, sku, qty);
		}
	}

	async #finalizeOrAwait(id: string, sku: string, qty: number): Promise<ReserveResult> {
		const outcome = await this.#finalize(id, sku, qty);
		if (outcome !== LOST) return outcome;
		return this.#awaitTerminal(id);
	}

	/** The finalize transaction (§0.5 step 2). */
	async #finalize(id: string, sku: string, qty: number): Promise<FinalizeOutcome> {
		return this.#db.transaction().execute<FinalizeOutcome>(async (trx) => {
			// Claim guard: exactly one caller flips a given reservation.
			const flipped = await trx
				.updateTable("reservations")
				.set({ state: "held" })
				.where("id", "=", id)
				.where("state", "=", "pending")
				.returning("id")
				.executeTakeFirst();
			if (flipped === undefined) return LOST; // peer finalized; rollback, re-read.

			await this.hooks.beforeDecrement?.(id);

			// Oversell-critical decrement: single conditional statement.
			const decremented = await trx
				.updateTable("inventory")
				.set({ on_hand: sql<number>`on_hand - ${qty}` })
				.where("sku", "=", sku)
				.where("on_hand", ">=", qty)
				.returning("on_hand")
				.executeTakeFirst();

			if (decremented !== undefined) {
				// `held` flip + decrement commit together.
				return { ok: true, reservationId: id };
			}

			// OUT_OF_STOCK: overwrite the transient `held` with `failed` in the
			// same tx (never externally visible); the key stays consumed.
			await trx.updateTable("reservations").set({ state: "failed" }).where("id", "=", id).execute();
			return { ok: false, reason: "OUT_OF_STOCK" };
		});
	}

	/** Bounded re-read until the reservation reaches a terminal state. */
	async #awaitTerminal(id: string): Promise<ReserveResult> {
		for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
			const row = await this.#selectById(id);
			if (row.state === "failed") return { ok: false, reason: "OUT_OF_STOCK" };
			if (row.state !== "pending") return { ok: true, reservationId: id };
			await delay(this.#delayMs);
		}
		throw new Error(`reservation ${id} did not reach a terminal state in time`);
	}

	async #selectByKey(
		key: string,
	): Promise<{ id: string; state: ReservationState; sku: string; qty: number }> {
		const row = await this.#db
			.selectFrom("reservations")
			.select(["id", "state", "sku", "qty"])
			.where("idempotency_key", "=", key)
			.executeTakeFirst();
		if (row === undefined) {
			throw new Error(`no reservation found for idempotency key ${key}`);
		}
		return row;
	}

	async #selectById(
		id: string,
	): Promise<{ id: string; state: ReservationState; sku: string; qty: number }> {
		const row = await this.#db
			.selectFrom("reservations")
			.select(["id", "state", "sku", "qty"])
			.where("id", "=", id)
			.executeTakeFirst();
		if (row === undefined) {
			throw new Error(`unknown reservation: ${id}`);
		}
		return row;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Portable FK-violation check: pg SQLSTATE `23503` / better-sqlite3 code. */
function isForeignKeyViolation(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: unknown }).code;
	return code === "23503" || code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}
