import type { IdempotencyKey } from "../money/ids.js";

export interface InventoryStore {
	// Atomic: decrement iff on_hand >= qty. Never oversell.
	// `reserve` is a multi-statement choreography: an idempotency claim (single
	// `INSERT … ON CONFLICT`), then a FINALIZE that couples the conditional inventory
	// decrement with the `pending → held` flip so both commit all-or-nothing — see §0.5.
	// The oversell-critical decrement is a single conditional statement; coupling it with the
	// `held` flip is what guarantees the invariant `held ⟺ a durable decrement` (so `held` is
	// never observable before stock was actually removed). On pg/sqlite the finalize is one
	// short transaction on one connection; a future D1/`EmdashStore` must supply equivalent
	// all-or-nothing semantics (CAS/batch) for that pair. A replay MUST resolve the
	// reservation's *state* (held ⇒ ok, failed ⇒ OUT_OF_STOCK, pending ⇒ finalize-or-await),
	// never assume the original call completed — see §0.5's replay choreography and the
	// concurrent-same-key / crash-window contract cases it requires.
	reserve(sku: string, qty: number, key: IdempotencyKey): Promise<ReserveResult>;
	// `commit`/`release` are the Phase-0 guarded flips with their source state
	// widened (additively) to include Phase-4's `adopted`: `held` still works, so
	// Phase-0's own contract is unaffected. A double-commit / double-release stays
	// a benign no-op. A `commit` against a reservation that is neither
	// `held`/`adopted` nor already `committed` (it was `released`/lost) throws the
	// typed `ReservationCommitLostError` — settle turns that into the loud
	// 0-row-commit anomaly (§5), never a silent no-op.
	commit(reservationId: string): Promise<void>;
	release(reservationId: string): Promise<void>;
	// Additive (Phase 4 §5): the single guarded `held → adopted` flip that hands a
	// cart's live reservation to an order. Sets `order_id` and re-points
	// `expires_at` to the order's hold deadline, scoped `WHERE state='held' AND
	// expires_at > :now` so it can never adopt a hold the Phase-3 sweep is about to
	// reap. 0 rows ⇒ the hold was swept/committed → typed `RESERVATION_LOST`,
	// EXCEPT an already-`adopted` row for THIS `orderId` (idempotent replay of
	// createOrderFromCart), which resolves to `ok`. `adopted` is a new additive
	// reservation state, structurally invisible to Phase-3's `held`-scoped sweep.
	adopt(input: AdoptInput): Promise<AdoptResult>;

	// Additive (Phase 1 §7/§8 Risk 4) — a dedicated create-if-absent initial
	// stock write, NOT part of the reserve/commit/release authority path.
	// `INSERT … ON CONFLICT (sku) DO NOTHING` shape: seeding a new sku creates
	// it; re-seeding an existing sku (including one already decremented by a
	// `reserve`) is a no-op that never clobbers the current `on_hand`. Its
	// natural key is `sku` — deliberately no `idempotencyKey` (the
	// create-if-absent guard IS the idempotency; see Phase 1 plan §8 Risk 4).
	seedOnHand(sku: string, qty: number): Promise<void>;
	// Additive (Phase 3): atomically move a *held* reservation to `newQty` and
	// couple the change with the matching durable inventory movement, so the
	// invariant "reservation qty changed ⟺ a durable inventory movement" holds
	// (the same crash-window discipline as `reserve`). An *increase* is the
	// oversell-critical single conditional decrement of the delta (may return
	// OUT_OF_STOCK, reservation unchanged); a *decrease* is an unconditional
	// increment (always ok).
	//
	// Exactly-once, ledger-first: every call claims `key` in a per-mutation
	// idempotency ledger BEFORE any inventory movement (mirroring `reserve`'s
	// `INSERT … ON CONFLICT` claim discipline). A replay — even a stale one
	// arriving after later same-reservation adjusts — returns the RECORDED
	// result (ok or OUT_OF_STOCK) and moves no stock; only the claim winner
	// moves inventory. The qty change is a guarded CAS scoped to `state='held'`
	// executed before the movement in the same short transaction (guard-first):
	// a hold that left `held` (adopted/committed/released) throws
	// `ReservationNotHeldError`, never a silent movement. Leaves
	// `reserve/commit/release` byte-for-byte (Phase-0 contract untouched).
	adjust(reservationId: string, newQty: number, key: IdempotencyKey): Promise<ReserveResult>;
}

export type ReserveResult =
	| { ok: true; reservationId: string }
	| { ok: false; reason: "OUT_OF_STOCK" };

export interface AdoptInput {
	reservationId: string;
	orderId: string;
	/** The order's hold deadline (ISO-8601 UTC) the reservation is re-pointed to. */
	holdExpiresAt: string;
	/** Clock-driven `:now` (ISO-8601 UTC); the flip requires `expires_at > now`. */
	now: string;
}

export type AdoptResult = { ok: true } | { ok: false; reason: "RESERVATION_LOST" };

/**
 * Thrown by `commit` when the reservation is neither adoptable (`held`/`adopted`)
 * nor already `committed` — it was `released`/lost, so stock was resold under a
 * paid order. Settle records this as the loud 0-row-commit anomaly (§5) and flags
 * the order for manual reconciliation; it is never swallowed.
 */
export class ReservationCommitLostError extends Error {
	constructor(reservationId: string, state: string) {
		super(`cannot commit reservation ${reservationId}: it is ${state}, not held/adopted/committed`);
		this.name = "ReservationCommitLostError";
	}
}

/**
 * Thrown by `adjust` when the reservation is not (or no longer) `held` — the
 * hold has been adopted/committed/released and is no longer the caller's to
 * move. The cart layer maps this to its typed `LINE_CHECKED_OUT` failure.
 */
export class ReservationNotHeldError extends Error {
	constructor(reservationId: string, state: string) {
		super(`cannot adjust reservation ${reservationId} in state ${state}`);
		this.name = "ReservationNotHeldError";
	}
}

/**
 * Thrown by `adjust` when a key's recorded ledger entry belongs to a DIFFERENT
 * reservation — a mis-keyed caller must never receive `ok` for the wrong hold.
 */
export class AdjustReservationMismatchError extends Error {
	constructor(key: string, expected: string, actual: string) {
		super(
			`adjust key ${key} was recorded against reservation ${expected}, not ${actual} — ` +
				"an idempotency key must not be reused across reservations",
		);
		this.name = "AdjustReservationMismatchError";
	}
}
