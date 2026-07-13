import type { IdempotencyKey } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import {
	type AdoptInput,
	type AdoptManyInput,
	type AdoptManyResult,
	type AdoptResult,
	AdjustReservationMismatchError,
	type CommitManyResult,
	type InventoryStore,
	ReservationCommitLostError,
	ReservationNotHeldError,
	type ReserveResult,
} from "../ports/inventory-store.js";

export type ReservationState = "pending" | "held" | "committed" | "released" | "failed" | "adopted";

interface ReservationRow {
	id: string;
	sku: string;
	qty: number;
	state: ReservationState;
	idempotencyKey: string;
	createdAt: string;
	/** Phase 4: the owning order once adopted; null while cart-held or raw. */
	orderId: string | null;
	/** Phase 4: re-pointed to the order's hold deadline on adoption. */
	expiresAt: string | null;
}

export interface InMemoryInventoryStoreOptions {
	idGen: IdGen;
	clock: Clock;
	seed?: ReadonlyArray<{ sku: string; onHand: number }>;
}

/**
 * The IO-free fake — the first `InventoryStore` adapter (Phase 0 step 0.2c).
 *
 * It models the same reserve choreography as the real stores (idempotency
 * claim → finalize coupling the `pending → held` flip with the decrement),
 * so the contract suite's replay/crash-window cases run here first with
 * deterministic ordering. `hooks.beforeFinalize` lets tests suspend a caller
 * between its claim and its finalize to script same-key races; the awaited
 * finalize itself is a single synchronous block (flip + decrement commit
 * together), mirroring the store's finalize transaction.
 */
export class InMemoryInventoryStore implements InventoryStore {
	readonly hooks: {
		beforeFinalize?: (reservationId: string) => Promise<void> | void;
	} = {};

	#idGen: IdGen;
	#clock: Clock;
	#onHand = new Map<string, number>();
	#reservations = new Map<string, ReservationRow>();
	#byKey = new Map<string, string>();
	/** Per-mutation adjust ledger: key → the reservation it was recorded against
	 *  plus its terminal result (exactly-once; mis-keyed replays are rejected). */
	#adjustments = new Map<string, { reservationId: string; result: ReserveResult }>();

	constructor(options: InMemoryInventoryStoreOptions) {
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		for (const row of options.seed ?? []) {
			this.seed(row.sku, row.onHand);
		}
	}

	async reserve(sku: string, qty: number, key: IdempotencyKey): Promise<ReserveResult> {
		if (!Number.isSafeInteger(qty) || qty <= 0) {
			throw new RangeError(`reserve() requires a positive integer qty, got ${String(qty)}`);
		}

		// Unknown/unseeded sku: pre-claim rejection, OUTSIDE R2's idempotency scope
		// ("no product row ⇒ no idempotency scope"). No reservation row is written
		// and the key is NOT consumed — mirroring the real store, whose
		// `reservations.sku → inventory.sku` FK aborts the claim. This is distinct
		// from a genuine OUT_OF_STOCK on a *known* sku (insufficient/zero stock),
		// which DOES consume the key and stays `failed` per R2 (see #finalize).
		if (!this.#onHand.has(sku)) {
			return { ok: false, reason: "OUT_OF_STOCK" };
		}

		// Idempotency claim (mirrors INSERT … ON CONFLICT DO NOTHING).
		const existingId = this.#byKey.get(key);
		let id: string;
		if (existingId === undefined) {
			id = this.#idGen.newId();
			this.#byKey.set(key, id);
			this.#reservations.set(id, {
				id,
				sku,
				qty,
				state: "pending",
				idempotencyKey: key,
				createdAt: this.#clock.now().toISOString(),
				orderId: null,
				expiresAt: null,
			});
		} else {
			// Key already claimed: resolve from the stored state, never a blind ok.
			id = existingId;
			const row = this.#mustGet(id);
			if (row.state === "failed") return { ok: false, reason: "OUT_OF_STOCK" };
			if (row.state !== "pending") return { ok: true, reservationId: id };
			// pending: the original call is in flight or crashed before finalize —
			// this caller races to finalize it (replay-by-state choreography).
		}

		return this.#finalize(id);
	}

	async adjust(reservationId: string, newQty: number, key: IdempotencyKey): Promise<ReserveResult> {
		if (!Number.isSafeInteger(newQty) || newQty <= 0) {
			throw new RangeError(`adjust() requires a positive integer newQty, got ${String(newQty)}`);
		}

		// Ledger-first (exactly-once): a replayed key — even a stale one arriving
		// after later same-reservation adjusts — returns the RECORDED result and
		// moves no stock. Only the claim winner ever moves inventory. A key
		// recorded against a DIFFERENT reservation is a mis-keyed caller: typed
		// rejection, never ok for the wrong hold.
		const recorded = this.#adjustments.get(key);
		if (recorded !== undefined) {
			if (recorded.reservationId !== reservationId) {
				throw new AdjustReservationMismatchError(key, recorded.reservationId, reservationId);
			}
			return { ...recorded.result };
		}

		const row = this.#mustGet(reservationId);
		// Guard-first: only a `held` (cart-owned) hold may move.
		if (row.state !== "held") {
			throw new ReservationNotHeldError(reservationId, row.state);
		}

		const delta = newQty - row.qty;
		// The claim, qty change, and inventory movement are applied as one
		// synchronous block — never a state where the reservation qty moved
		// without the stock, or the claim without its outcome.
		if (delta > 0) {
			// Increase: oversell-critical conditional decrement of the delta.
			const onHand = this.#onHand.get(row.sku) ?? 0;
			if (onHand < delta) {
				const failed: ReserveResult = { ok: false, reason: "OUT_OF_STOCK" };
				this.#adjustments.set(key, { reservationId, result: failed }); // R2: key consumed
				return { ...failed };
			}
			this.#onHand.set(row.sku, onHand - delta);
			row.qty = newQty;
		} else if (delta < 0) {
			// Decrease: unconditional partial release, always succeeds.
			this.#onHand.set(row.sku, (this.#onHand.get(row.sku) ?? 0) + -delta);
			row.qty = newQty;
		}
		const ok: ReserveResult = { ok: true, reservationId };
		this.#adjustments.set(key, { reservationId, result: ok });
		return { ...ok };
	}

	async commit(reservationId: string): Promise<void> {
		const row = this.#mustGet(reservationId);
		if (row.state === "committed") return; // double-commit / idempotent replay: no-op
		// Widened to accept `adopted` (Phase 4) as well as `held` (Phase 0).
		if (row.state !== "held" && row.state !== "adopted") {
			// released / failed / … ⇒ the adopted hold was lost: the loud anomaly (§5).
			throw new ReservationCommitLostError(reservationId, row.state);
		}
		row.state = "committed";
	}

	async release(reservationId: string): Promise<void> {
		const row = this.#mustGet(reservationId);
		if (row.state === "released") return; // double-release: no-op
		// Widened to accept `adopted` (Phase 4) as well as `held` (Phase 0).
		if (row.state !== "held" && row.state !== "adopted") {
			throw new Error(`cannot release reservation ${reservationId} in state ${row.state}`);
		}
		row.state = "released";
		this.#onHand.set(row.sku, (this.#onHand.get(row.sku) ?? 0) + row.qty);
	}

	/**
	 * Order-scoped release (review G2): the guarded `adopted → released` flip
	 * scoped to the OWNING order. Anything else — unknown id, released/committed,
	 * adopted by another order, still cart-`held` — is a silent no-op, never a
	 * throw: a stale order must not free (or crash the sweep on) a hold it never
	 * adopted.
	 */
	async releaseAdopted(reservationId: string, orderId: string): Promise<void> {
		const row = this.#reservations.get(reservationId);
		if (row === undefined) return;
		if (row.state !== "adopted" || row.orderId !== orderId) return;
		row.state = "released";
		this.#onHand.set(row.sku, (this.#onHand.get(row.sku) ?? 0) + row.qty);
	}

	/**
	 * The guarded `held → adopted` flip (Phase 4 §5): hands a cart's live
	 * reservation to an order, setting `orderId` and re-pointing `expiresAt` to the
	 * order's hold deadline, scoped `state='held' AND expiresAt > now`. An
	 * already-`adopted` row for THIS order resolves to `ok` (idempotent replay);
	 * anything else (swept/committed/held-past-deadline) is `RESERVATION_LOST`.
	 */
	async adopt(input: AdoptInput): Promise<AdoptResult> {
		const row = this.#mustGet(input.reservationId);
		if (row.state === "adopted" && row.orderId === input.orderId) {
			return { ok: true }; // idempotent replay of createOrderFromCart
		}
		if (row.state !== "held") return { ok: false, reason: "RESERVATION_LOST" };
		if (row.expiresAt !== null && row.expiresAt <= input.now) {
			return { ok: false, reason: "RESERVATION_LOST" }; // about to be swept
		}
		row.state = "adopted";
		row.orderId = input.orderId;
		row.expiresAt = input.holdExpiresAt;
		return { ok: true };
	}

	/**
	 * Batched `adopt` (PR B): the CONTRACT ORACLE for `adoptMany`. An accumulating
	 * loop over the singular `adopt` logic — `{ ok: false }` ⇒ `lost`, `ok` ⇒
	 * `adopted` — that NEVER breaks early, so every id is classified exactly as the
	 * store's single guarded statement + classification does. Unlike singular
	 * `adopt` (whose `#mustGet` throws on a truly-unknown id), the batch classifies
	 * an unknown id as `lost` — folding it in exactly like the Kysely store's
	 * `WHERE id IN (:ids)` (an absent row never matches, so it lands in `lost`),
	 * honoring `adoptMany`'s port JSDoc.
	 */
	async adoptMany(input: AdoptManyInput): Promise<AdoptManyResult> {
		const adopted: string[] = [];
		const lost: string[] = [];
		for (const reservationId of input.reservationIds) {
			if (!this.#reservations.has(reservationId)) {
				lost.push(reservationId); // unknown id ⇒ lost (matches Kysely + JSDoc)
				continue;
			}
			const result = await this.adopt({
				reservationId,
				orderId: input.orderId,
				holdExpiresAt: input.holdExpiresAt,
				now: input.now,
			});
			if (result.ok) adopted.push(reservationId);
			else lost.push(reservationId);
		}
		return { adopted, lost };
	}

	/**
	 * Batched `commit` (PR B): the CONTRACT ORACLE for `commitMany`. Singular
	 * `commit` THROWS `ReservationCommitLostError` on a lost hold, so a bare loop
	 * would short-circuit and diverge from the SQL batch — this MUST catch that
	 * per id, push to `lost`, and CONTINUE. A benign already-`committed` hold is a
	 * silent success (absent from `lost`). A truly-unknown id raises the bare
	 * `#mustGet` Error, which PROPAGATES (matching the Kysely store's throw).
	 */
	async commitMany(reservationIds: string[]): Promise<CommitManyResult> {
		const lost: string[] = [];
		for (const reservationId of reservationIds) {
			try {
				await this.commit(reservationId);
			} catch (err) {
				if (err instanceof ReservationCommitLostError) {
					lost.push(reservationId);
					continue;
				}
				throw err; // unknown-id bare Error propagates
			}
		}
		return { lost };
	}

	/**
	 * Additive (Phase 1 §8 Risk 4): create-if-absent initial stock write.
	 * Mirrors `INSERT … ON CONFLICT (sku) DO NOTHING` — a no-op when the sku
	 * already has an `on_hand` row, so it can never clobber a concurrent
	 * `reserve`/`release`/future `adjust`.
	 */
	async seedOnHand(sku: string, qty: number): Promise<void> {
		if (!Number.isSafeInteger(qty) || qty < 0) {
			throw new RangeError(`seedOnHand() requires a non-negative integer, got ${String(qty)}`);
		}
		if (this.#onHand.has(sku)) return; // create-if-absent: never overwrite a live on_hand.
		this.#onHand.set(sku, qty);
	}

	// -- test surface ---------------------------------------------------------

	seed(sku: string, onHand: number): void {
		if (!Number.isSafeInteger(onHand) || onHand < 0) {
			throw new RangeError(`seed() requires a non-negative integer, got ${String(onHand)}`);
		}
		this.#onHand.set(sku, onHand);
	}

	onHand(sku: string): number {
		return this.#onHand.get(sku) ?? 0;
	}

	reservationState(reservationId: string): ReservationState {
		return this.#mustGet(reservationId).state;
	}

	/**
	 * Stamp a held reservation's hold deadline (`expiresAt`) — the cart-flow
	 * precondition `adopt`/`adoptMany` require (a bare `reserve` leaves it null).
	 * Test surface only, mirroring the cart store's `expires_at` stamp.
	 */
	setHoldExpiry(reservationId: string, expiresAt: string): void {
		this.#mustGet(reservationId).expiresAt = expiresAt;
	}

	/**
	 * Simulates crash window W1: claims the key and leaves the reservation
	 * `pending` with the finalize never run (no decrement). A later same-key
	 * `reserve` must heal it to the correct terminal state.
	 */
	abandonPending(sku: string, qty: number, key: IdempotencyKey): string {
		if (this.#byKey.has(key)) {
			throw new Error(`idempotency key ${key} is already claimed`);
		}
		const id = this.#idGen.newId();
		this.#byKey.set(key, id);
		this.#reservations.set(id, {
			id,
			sku,
			qty,
			state: "pending",
			idempotencyKey: key,
			createdAt: this.#clock.now().toISOString(),
			orderId: null,
			expiresAt: null,
		});
		return id;
	}

	// -- internals ------------------------------------------------------------

	async #finalize(id: string): Promise<ReserveResult> {
		await this.hooks.beforeFinalize?.(id);

		const row = this.#mustGet(id);
		if (row.state !== "pending") {
			// Lost the finalize race while suspended: re-read the terminal state.
			if (row.state === "failed") return { ok: false, reason: "OUT_OF_STOCK" };
			return { ok: true, reservationId: id };
		}

		// The finalize pair — `pending → held` flip + conditional decrement —
		// executes as one synchronous block: all-or-nothing, like the store's
		// finalize transaction (`held ⟺ durable decrement`).
		const onHand = this.#onHand.get(row.sku) ?? 0;
		if (onHand >= row.qty) {
			row.state = "held";
			this.#onHand.set(row.sku, onHand - row.qty);
			return { ok: true, reservationId: id };
		}
		row.state = "failed";
		return { ok: false, reason: "OUT_OF_STOCK" };
	}

	#mustGet(id: string): ReservationRow {
		const row = this.#reservations.get(id);
		if (row === undefined) {
			throw new Error(`unknown reservation: ${id}`);
		}
		return row;
	}
}
