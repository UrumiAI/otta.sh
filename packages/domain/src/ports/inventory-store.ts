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

	// Additive (PR B — checkout-write batching): the BATCHED counterpart of
	// `adopt`, folding one order's physical `held → adopted` flips into a single
	// guarded `UPDATE … WHERE id IN (:ids) AND state='held' AND expires_at > :now`.
	// Its per-id semantics are `adopt`'s, byte-for-byte: a flipped row is
	// `adopted`; a 0-row id is re-classified — an already-`adopted` row for THIS
	// `orderId` is the idempotent replay of createOrderFromCart (folded into
	// `adopted`, and — like singular `adopt` — WITHOUT re-checking `expires_at`, so
	// a row adopted-for-this-order past its deadline is still success), every other
	// existing row (swept/committed/released/held-past-deadline/another order) is
	// `RESERVATION_LOST` (in `lost`). An unknown id is folded into `lost` — the
	// guarded `WHERE id IN (:ids)` never matches an absent row, so it classifies as
	// `RESERVATION_LOST`, never a throw (unlike singular `adopt`, whose absent-row
	// lookup throws — the batch method deliberately does not). An empty
	// `reservationIds` is a no-op (`{ adopted: [], lost: [] }`, no DB round trip).
	// Membership only — the returned arrays carry no order guarantee.
	adoptMany(input: AdoptManyInput): Promise<AdoptManyResult>;

	// Additive (PR B — checkout-write batching): the BATCHED counterpart of
	// `commit`, folding a paid order's physical `held|adopted → committed` flips
	// into a single guarded `UPDATE … WHERE id IN (:ids) AND state IN
	// ('held','adopted')`. Deliberately order-UNSCOPED, exactly like singular
	// `commit`. Its per-id semantics are `commit`'s, byte-for-byte: a flipped or
	// already-`committed` row is a benign success (absent from `lost`); a 0-row id
	// that is `released`/`failed`/etc. is a LOST hold (in `lost`) — settle turns
	// each into the loud `COMMIT_LOST` anomaly (§5). An UNKNOWN id matches singular
	// `commit`, whose `#selectById` THROWS a bare Error for an absent row, so a
	// truly-unknown id PROPAGATES (never folded into `lost`). Empty `reservationIds`
	// is a no-op (`{ lost: [] }`, no DB round trip). Membership only.
	commitMany(reservationIds: string[]): Promise<CommitManyResult>;

	// Additive (review G2): the ORDER-SCOPED release used by every order-driven
	// release path (`expireOrders`, settle's failed release). A single guarded
	// flip `adopted → released` scoped `WHERE order_id = :orderId`, then the
	// stock return — an order can only ever release a hold IT adopted. 0 rows is
	// ALWAYS a silent no-op: already released/committed (benign replay), or
	// owned by another order / still cart-`held` (not this order's to touch —
	// an unscoped release here is how a stale order could free a live checkout's
	// hold, or crash the sweep on a committed one). Never throws on state; the
	// loud lost-hold anomaly stays `commit`'s.
	releaseAdopted(reservationId: string, orderId: string): Promise<void>;

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

	// Additive (admin-UX Increment 2, product detail): a bare, read-only
	// `on_hand` lookup — a query, not a command (no idempotency key, mutates
	// nothing). Exists so a SINGLE product's admin detail view can show its raw
	// stock count without a store-side join (unlike `ProductCommerceStore.
	// listCommerceByIds`, whose `inStock` is a coarse boolean scoped to
	// commerce-complete rows only). A sku with NO inventory row reads as `0` —
	// the SAME "no row ⇒ out of stock" semantics `listCommerceByIds`'s LEFT JOIN
	// already establishes — never a throw, never null-as-logic. Deliberately NOT
	// a batch/list method: the admin list screen must not N+1 into inventory per
	// row (the list omits stock entirely, mirroring the port's `listCommerceByIds`
	// doc); this is a single-row read for the ONE product a detail view opens.
	getOnHand(sku: string): Promise<number>;
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

/** Batched `adopt` (PR B): every physical `held` reservation of ONE order. */
export interface AdoptManyInput {
	/** The order's physical reservation ids (the digital lines carry none). */
	reservationIds: string[];
	/** The owning order the flips set `order_id` to. */
	orderId: string;
	/** The order's hold deadline (ISO-8601 UTC) each reservation is re-pointed to. */
	holdExpiresAt: string;
	/** Clock-driven `:now` (ISO-8601 UTC); each flip requires `expires_at > now`. */
	now: string;
}

/**
 * The outcome of {@link InventoryStore.adoptMany}. `adopted` carries every id now
 * `adopted` for the order (freshly flipped OR an idempotent replay); `lost` carries
 * every id whose hold could not be adopted (a `RESERVATION_LOST` per singular
 * `adopt`). Both are membership sets — no order is guaranteed.
 */
export type AdoptManyResult = { adopted: string[]; lost: string[] };

/**
 * The outcome of {@link InventoryStore.commitMany}. `lost` carries every id whose
 * adopted hold was lost (released/failed/…) — each a `COMMIT_LOST` anomaly at
 * settle. A benign already-`committed` id is absent (not lost). Membership only.
 */
export type CommitManyResult = { lost: string[] };

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
