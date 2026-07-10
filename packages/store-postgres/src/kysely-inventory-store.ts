import type { Clock, IdGen, IdempotencyKey, InventoryStore, ReserveResult } from "@urumi/domain";
import { type Kysely, sql } from "kysely";
import type { Database, ReservationState } from "./schema.js";

/** Losing the guarded finalize flip: another caller owns this reservation. */
const LOST = Symbol("finalize-lost");
type FinalizeOutcome = ReserveResult | typeof LOST;

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
		const row = await this.#selectById(reservationId);
		if (row.state === "committed") return; // double-commit: no-op
		if (row.state !== "held") {
			throw new Error(`cannot commit reservation ${reservationId} in state ${row.state}`);
		}
		await this.#db
			.updateTable("reservations")
			.set({ state: "committed" })
			.where("id", "=", reservationId)
			.where("state", "=", "held")
			.execute();
	}

	async release(reservationId: string): Promise<void> {
		const row = await this.#selectById(reservationId);
		if (row.state === "released") return; // double-release: no-op
		if (row.state !== "held") {
			throw new Error(`cannot release reservation ${reservationId} in state ${row.state}`);
		}
		// Flip `held → released` and return the stock all-or-nothing; the state
		// guard makes exactly one caller increment (no double return).
		await this.#db.transaction().execute(async (trx) => {
			const flipped = await trx
				.updateTable("reservations")
				.set({ state: "released" })
				.where("id", "=", reservationId)
				.where("state", "=", "held")
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
				// `held` (and its post-commit/release terminals) is proof the stock
				// was durably removed together with the flip.
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
