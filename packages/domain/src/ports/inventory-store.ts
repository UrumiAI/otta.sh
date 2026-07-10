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
	commit(reservationId: string): Promise<void>;
	release(reservationId: string): Promise<void>;

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
