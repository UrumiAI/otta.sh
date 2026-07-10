import type { IdempotencyKey } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type { InventoryStore, ReserveResult } from "../ports/inventory-store.js";

export type ReservationState = "pending" | "held" | "committed" | "released" | "failed";

interface ReservationRow {
	id: string;
	sku: string;
	qty: number;
	state: ReservationState;
	idempotencyKey: string;
	createdAt: string;
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

	async commit(reservationId: string): Promise<void> {
		const row = this.#mustGet(reservationId);
		if (row.state === "committed") return; // double-commit: no-op
		if (row.state !== "held") {
			throw new Error(`cannot commit reservation ${reservationId} in state ${row.state}`);
		}
		row.state = "committed";
	}

	async release(reservationId: string): Promise<void> {
		const row = this.#mustGet(reservationId);
		if (row.state === "released") return; // double-release: no-op
		if (row.state !== "held") {
			throw new Error(`cannot release reservation ${reservationId} in state ${row.state}`);
		}
		row.state = "released";
		this.#onHand.set(row.sku, (this.#onHand.get(row.sku) ?? 0) + row.qty);
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
