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
	// 0-row-commit anomaly (§5), never a silent no-op. `commit`/`release` against
	// an id that does not exist throw `ReservationNotFoundError`; an id that
	// exists but is not committable stays `ReservationCommitLostError` (the loud
	// anomaly). KNOWN ASYMMETRY: `adjust` shares the same choke point
	// (`#selectById`/`#mustGet`) as `commit`/`release`, so it throws the same typed
	// `ReservationNotFoundError` for an unknown id, but nothing at the HTTP
	// boundary maps it — a cart `PATCH /carts/:id/lines/:lineId` against a
	// vanished reservation still surfaces as a **500**. Deliberate and out of
	// scope: the cart failure taxonomy (`CartFailure`) has no "reservation
	// vanished" member, and adding one is a domain-model change with its own PR.
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
	// `commit`, whose `#selectById` THROWS `ReservationNotFoundError` for an
	// absent row, so a truly-unknown id PROPAGATES (never folded into `lost`).
	// Empty `reservationIds`
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
	//
	// THAT NATURAL KEY IS WHY A SKU RENAME IS NOT A STRING SWAP. `seedOnHand` is
	// attempted after EVERY product save with a known sku, and it is
	// create-if-absent, so on its own it answers a rename by minting a fresh
	// ZERO row under the new sku and leaving the old row holding the units,
	// referenced by nothing. The carry-forward that prevents that is NOT here: it
	// belongs to whichever write changed the sku, because it has to commit with
	// the product row — see THE SKU-RENAME RULE on `ProductCommerceStore`. This
	// call stays exactly what it is: UNCONDITIONAL on every save (the heal path
	// for a product whose row never landed) and a pure no-op once the row exists,
	// including the row a rename just carried. Do NOT make it conditional on "the
	// sku changed", and do NOT teach it to move stock — a create-if-absent write
	// that sometimes moves units is neither.
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
	// commerce-complete rows only).
	//
	// A sku with NO inventory row reads as `0` here — never a throw, never
	// null-as-logic — the same "no row ⇒ out of stock" collapse
	// `listCommerceByIds`'s coarse `inStock` boolean makes.
	//
	// ⚠ DELIBERATE DIVERGENCE from `ProductCommerceStore.listProducts`. That
	// projection reports a missing inventory row as `onHand: null` —
	// "unknown" — and treats `0` as the DIFFERENT fact "known sku, out of
	// stock", because the list renders a per-row stock cell where inventing a
	// zero would invent an out-of-stock claim for every never-synced product.
	// This method cannot make that distinction: its return type is `number`,
	// so `0` is overloaded and the two cases are indistinguishable to a
	// caller. Do NOT "harmonize" the two by making the list coerce `null → 0`
	// — that erases a fact the list is specifically there to show. Widening
	// THIS signature to `number | null` is the direction that preserves
	// information, and is a separate change with its own callers to audit.
	//
	// Deliberately NOT a batch/list method: it is a single-row read for the
	// ONE product a detail view opens. The admin list no longer needs it — it
	// carries `onHand` via a single LEFT JOIN inside `listProducts`'s own
	// statement (one round trip per page, measured against an N+1 of these
	// calls and 6x faster at page size 25), so per-row calls into this method
	// from a list path remain the anti-pattern they always were.
	getOnHand(sku: string): Promise<number>;

	// Additive (INC-23, admin product detail): the SAME single-row read as
	// `getOnHand` with the one distinction that method's return type cannot
	// carry — a sku with NO inventory row reads `null` ("unknown"), and `0`
	// means a known sku that is out of stock.
	//
	// WHY A SECOND METHOD RATHER THAN A WIDENED `getOnHand`. The warning above
	// says widening is "the direction that preserves information, and is a
	// separate change with its own callers to audit". That audit was done and
	// came back: `getOnHand`'s `0`-for-missing is PINNED by the contract suite
	// ("mirrors the LEFT JOIN miss") and relied on by tests that assert a
	// concrete count; changing it would rewrite a shipped contract statement to
	// close a rendering defect. So the information is added ALONGSIDE it, and
	// `getOnHand` stays byte-for-byte what it was.
	//
	// This is what the admin DETAIL leaf reads. It exists because the same
	// product read `—` in the products list (which sources `onHand` from
	// `listProducts`'s LEFT JOIN and reports a miss as `null`) and `0` on its own
	// detail page — one fact, two answers, one click apart. A detail view is the
	// screen with the MOST context, so it is the last place that should be the
	// one guessing.
	//
	// Still deliberately NOT a batch/list method, for the same reason as
	// `getOnHand`: a list carries stock through its own join (port doc), and
	// per-row calls into either of these from a list path remain the anti-pattern
	// they always were.
	findOnHand(sku: string): Promise<number | null>;

	// Additive (admin-UX Increment 2, merchant restock): ADD `qty` units to an
	// existing sku's on-hand — the merchant's "we received more stock" path.
	// Distinct from `seedOnHand` (create-if-absent, natural key = sku, no delta)
	// and from `adjust` (reservation-scoped): this is a bare, ADDITIVE stock
	// movement on the raw `on_hand` count with its OWN per-mutation idempotency
	// ledger (`qty > 0`).
	//
	// RACE-SAFETY: a restock is a single unconditional `on_hand = on_hand + qty`
	// — commutative with every concurrent `reserve`/`removeStock` (each a guarded
	// `on_hand >= n` decrement). Adding units can NEVER cause an oversell: it only
	// ever raises the available count, so no concurrent reservation is invalidated
	// and the final `on_hand` is order-independent. No guard is needed (unlike a
	// decrement); the movement is the single statement, exactly like `reserve`'s
	// decrement but with the sign flipped and no `WHERE on_hand >= …` predicate.
	//
	// Exactly-once, ledger-first: every call claims `key` in the shared
	// `inventory_stock_movements` ledger BEFORE the movement (mirroring `adjust`'s
	// claim discipline), so a double-clicked restock adds `qty` ONCE and a replay
	// (even a stale one) returns the recorded result and moves nothing. A key
	// recorded against a DIFFERENT (sku, direction, qty) is a mis-keyed caller:
	// typed `StockMovementMismatchError`, never a wrong-movement `ok`.
	//
	// UNKNOWN SKU: a sku with no inventory row is a clean `UNKNOWN_SKU` failure
	// that does NOT consume the key (the claim rolls back) — mirroring `reserve`'s
	// unknown-sku parity ("no inventory row ⇒ outside idempotency scope"). Restock
	// deliberately does NOT auto-create the row: `seedOnHand` is the sole create
	// path, so a typo'd sku can never conjure phantom inventory.
	//
	// KEY SCOPING: idempotency keys are scoped PER LEDGER. `reserve` claims in the
	// reservations table, `adjust` in its adjustments ledger, and
	// `restock`/`removeStock` share the stock-movements ledger. The same key value
	// appearing across DIFFERENT ledgers is NOT a collision (each ledger's
	// uniqueness is independent); reuse is only rejected WITHIN a ledger — for the
	// stock-movements ledger, when the recorded (sku, direction, qty) differs
	// (`StockMovementMismatchError`).
	restock(sku: string, qty: number, key: IdempotencyKey): Promise<RestockResult>;

	// Additive (admin-UX Increment 2, merchant stock removal): REMOVE `qty` units
	// from an existing sku's on-hand — the merchant's "these units are damaged /
	// shrinkage" path. The oversell-critical DECREMENT counterpart of `restock`
	// (`qty > 0`).
	//
	// RACE-SAFETY: a removal is a SINGLE GUARDED `on_hand = on_hand - qty WHERE
	// on_hand >= qty` — the SAME guard shape as `reserve`'s decrement. It can
	// never drive `on_hand` below 0, and it competes for the exact same units a
	// concurrent `reserve` competes for: whichever guarded decrement the DB
	// serializes first wins, the loser sees `on_hand < qty` and fails cleanly
	// (`INSUFFICIENT_STOCK`). N concurrent removals + M reservations can therefore
	// never oversell — every successful decrement is backed by real units.
	//
	// Exactly-once, ledger-first: identical claim discipline to `restock`. An
	// `INSUFFICIENT_STOCK` on a KNOWN sku is a genuine terminal outcome that DOES
	// consume the key (stays recorded, replays deterministically — the R2
	// counterpart to `reserve`'s consumed OUT_OF_STOCK). An `UNKNOWN_SKU` does NOT
	// consume the key (claim rolls back), exactly as `restock`.
	removeStock(sku: string, qty: number, key: IdempotencyKey): Promise<StockRemovalResult>;
}

/** Outcome of {@link InventoryStore.restock}. `onHand` is the resulting count
 *  AFTER the units were added (recorded in the ledger, so a replay echoes it). */
export type RestockResult = { ok: true; onHand: number } | { ok: false; reason: "UNKNOWN_SKU" };

/** Outcome of {@link InventoryStore.removeStock}. On success `onHand` is the
 *  count after removal; on `INSUFFICIENT_STOCK` it is the current count (fewer
 *  than `qty` units are available to remove). `UNKNOWN_SKU` carries no count. */
export type StockRemovalResult =
	| { ok: true; onHand: number }
	| { ok: false; reason: "INSUFFICIENT_STOCK"; onHand: number }
	| { ok: false; reason: "UNKNOWN_SKU" };

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
 * Thrown by `commit`/`release` (and `adjust`, which shares the same choke
 * point) when `reservationId` does not exist at all — never created, as
 * distinct from `ReservationCommitLostError`'s "existed but is not
 * committable". The HTTP boundary maps this to a 404; see the port docblock
 * above `commit` for the known `adjust` asymmetry.
 */
export class ReservationNotFoundError extends Error {
	constructor(reservationId: string) {
		super(`unknown reservation: ${reservationId}`);
		this.name = "ReservationNotFoundError";
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

/**
 * Thrown by `restock`/`removeStock` when a key's recorded stock-movement ledger
 * entry describes a DIFFERENT movement (sku, direction, or qty) than the caller
 * now asks for — a mis-keyed caller must never receive an `ok` echoing the wrong
 * stock movement. Direction is `"restock"` (add) or `"removal"` (remove).
 */
export class StockMovementMismatchError extends Error {
	constructor(key: string, expected: string, actual: string) {
		super(
			`stock-movement key ${key} was recorded for ${expected}, not ${actual} — ` +
				"an idempotency key must not be reused across distinct stock movements",
		);
		this.name = "StockMovementMismatchError";
	}
}
