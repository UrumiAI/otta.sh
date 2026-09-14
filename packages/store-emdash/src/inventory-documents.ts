/**
 * The inventory document model: one aggregate document per SKU, with the live
 * holds embedded in it, plus three per-key claim collections.
 *
 * **Why the holds live inside the inventory document.** An inventory decrement
 * is not idempotent unless the row records who applied it. A two-step "claim a
 * reservation, then decrement" cannot tell crash-before-decrement from
 * crash-after unless the inventory row names the reservation that moved the
 * units — so the holds map lives in the inventory document, and the guard
 * (`onHand >= qty`, computed in JS), the decrement and the hold record all commit
 * in ONE `compareAndSet`. No oversell and once-only are the same atom.
 *
 * **Reserve is still a two-step, and has exactly ONE crash window.** The durable
 * once-only guard is {@link ReservationKeyDoc} — `reservation_keys/{key}`,
 * claimed create-if-absent *before* the inventory write and carrying everything
 * needed to finish the job. The window is "claim written, inventory
 * `compareAndSet` not yet run"; any replayer completes it deterministically,
 * using the reservation id RECORDED in the claim rather than minting a new one,
 * and a sweeper reaps whatever is never replayed. What the embedded aggregate
 * removes is the *SQL* adapter's second window (a `pending` reservation flipped
 * to `held` separately from the decrement), not the claim window — which no
 * single-document primitive can remove, because the claim and the units live in
 * different documents by necessity.
 *
 * **Why `reservation_index` exists.** Six port methods take reservation ids with
 * no sku, and a hold embedded per SKU cannot be found from an id alone. The index
 * document is written before the hold, so an id absent from it is *provably*
 * unknown — which is what lets `commitMany` throw `ReservationNotFoundError` for
 * a truly unknown id while `adoptMany` folds one into `lost`.
 *
 * **Ledgers are bounded.** `adjust` / `restock` / `removeStock` keep their
 * per-key intent in `inventory_movements/{prefixedKey}` — one document per key,
 * updated to `applied` once the units moved — and the aggregate keeps only a
 * bounded ring of the last {@link APPLIED_MOVEMENT_RING_SIZE} applied keys, so no
 * map on the hot document grows without limit.
 *
 * Document ids are the once-only guard everywhere a claim is needed
 * (`_plugin_storage`'s primary key plus `compareAndSet(id, null, …)`'s
 * `INSERT … ON CONFLICT DO NOTHING`). No unique index is relied upon: the test
 * harness cannot materialize one, and the host's index sync degrades silently.
 */
import type { ReserveResult, StockRemovalResult } from "@otta-sh/domain";

/** Collection name: the per-SKU aggregate. Id is the sku; id lookup only. */
export const INVENTORY_COLLECTION = "inventory";
/** Collection name: reservation id → the sku and reserve key that own its hold. */
export const RESERVATION_INDEX_COLLECTION = "reservation_index";
/**
 * Collection name: reserve idempotency key → its durable claim, then its terminal
 * `ReserveResult`.
 *
 * Named for the key rather than for the outcome (it was `reservation_outcomes`
 * while it only carried terminal answers) because the claim it now carries is
 * written BEFORE the units move and is what makes `reserve` once-only at all.
 */
export const RESERVATION_KEYS_COLLECTION = "reservation_keys";
/** Collection name: the movement/adjust per-key intent claims and audit trail. */
export const INVENTORY_MOVEMENTS_COLLECTION = "inventory_movements";

/** One collection as the plugin descriptor declares it. */
export interface CollectionIndexDeclaration {
	readonly indexes?: readonly string[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The four collections `EmdashInventoryStore` reads and writes, with the indexes
 * each must declare. A declared index is a **read contract**, not a performance
 * knob: `where`/`orderBy` on an undeclared field is a runtime
 * `StorageQueryError`, so this list and the descriptor's must not drift.
 *
 * Three of the four declare none, because every access is by document id. Only
 * `inventory_movements` is ever queried (by `sku` / `createdAt`, for the admin
 * stock-movement audit a later increment renders) — the store itself reaches even
 * that collection by id alone.
 */
export const INVENTORY_COLLECTIONS: Readonly<Record<string, CollectionIndexDeclaration>> = {
	[INVENTORY_COLLECTION]: {},
	[RESERVATION_INDEX_COLLECTION]: {},
	[RESERVATION_KEYS_COLLECTION]: {},
	[INVENTORY_MOVEMENTS_COLLECTION]: { indexes: ["sku", "createdAt"] },
};

/** A live hold's state. There is deliberately no `pending`: see the module doc. */
export type HoldState = "held" | "adopted";

/**
 * One live hold, keyed in {@link InventoryDoc.holds} by the **reserve
 * idempotency key** — the key is what makes the decrement replayable, so it is
 * the natural key of the record that proves the decrement happened.
 */
export interface HoldEntry {
	/** The id recorded in the reservation key's claim before this hold was written. */
	reservationId: string;
	/** Units held. Always a positive safe integer. */
	qty: number;
	state: HoldState;
	/** The cart or order hold deadline (ISO-8601 UTC); `null` until stamped. */
	expiresAt: string | null;
	/** The owning order once adopted; `null` while cart-held. */
	orderId: string | null;
	createdAt: string;
	/**
	 * The last `adjust` key whose movement this hold recorded. A hold-local witness
	 * that an adjust's `compareAndSet` landed, which survives eviction from
	 * {@link InventoryDoc.appliedMovements} for the most recent adjust — the
	 * realistic replay case. Pruned with the hold.
	 */
	lastMovementKey?: string;
}

/** `restock` adds, `removeStock` removes. Mirrors the port's ledger wording. */
export type StockDirection = "restock" | "removal";

/**
 * One entry in the aggregate's bounded applied-movement ring: the key whose
 * movement landed, and the answer it landed with.
 *
 * The result is carried here, not just the key, so a replay that finds its key
 * already applied can return the ORIGINAL answer (a post-move `onHand` count
 * cannot be reconstructed after the fact) without re-applying anything.
 */
export type AppliedMovement =
	| { key: string; kind: "adjust"; result: ReserveResult }
	| { key: string; kind: "stock"; result: StockRemovalResult };

/**
 * How many applied movement keys the aggregate remembers.
 *
 * The ring exists only to make the window between a movement's `compareAndSet`
 * and its claim document being marked `applied` idempotent — a window the width
 * of one round trip. The claim document is the durable record; the ring is the
 * short-horizon witness, bounded so the hot document cannot grow without limit
 * (the same device the sku-rename transfer ring uses).
 *
 * **The residual this bound leaves, stated exactly.** A replay delayed past this
 * many later movements on the SAME sku loses its witness and would apply a second
 * time (or, for an adjust whose hold has also been pruned, throw rather than
 * answer). It cannot be closed without a second atomic document, which these
 * primitives do not offer, so it is accepted as BOUNDED and handed to the sweeper
 * as a contract: a movement claim still in `claimed` state whose key is present in
 * the aggregate's ring, or on a hold, is marked `applied` by the sweeper BEFORE
 * eviction can occur. Reaching the residual therefore takes at least this many
 * movements on ONE sku between a crash and the next sweep.
 */
export const APPLIED_MOVEMENT_RING_SIZE = 256;

/**
 * The source document's **transfer intent** — the whole of a sku rename's
 * cross-document coupling, recorded in the same write that zeroes the source.
 *
 * A rename moves units between two documents, and no primitive here can write
 * two documents atomically. So the move is made *idempotently completable*
 * instead: one `compareAndSet` on the source sets `onHand → 0` **and** stamps
 * this intent; the target then adds `qty` iff its
 * {@link InventoryDoc.appliedTransfers} ring lacks `token`; then the source
 * clears the intent. Every step is a no-op when it has already happened, so any
 * replayer — the writer itself on retry, a later rename of the same sku, or a
 * sweeper — finishes a partial from the source document alone.
 *
 * **Units in flight are still accounted for.** While this field is present the
 * `qty` it names is out of `onHand` and not yet in the target, so a reader that
 * must not lose a unit reads `onHand + (transferOut?.qty ?? 0)` for the source.
 * Nothing on the hot reserve path does — a source mid-transfer is a sku no
 * product holds any more — but the conservation argument depends on it.
 */
export interface TransferOut {
	/**
	 * The once-only token. DERIVED from the product write's own idempotency key
	 * plus the two skus, never minted fresh, so a replay of the same rename
	 * computes the same token and applies nothing a second time.
	 */
	token: string;
	toSku: string;
	/** Units to add to the target. Always a positive safe integer. */
	qty: number;
}

/**
 * `inventory/{sku}` — the aggregate. Everything an inventory invariant spans
 * lives here, so every invariant is one document's read-modify-write.
 */
export interface InventoryDoc {
	sku: string;
	/** Integer units. Never a float; never driven below 0 by any guarded write. */
	onHand: number;
	/** Live holds by reserve idempotency key. Pruned only after the outcome copy. */
	holds: Record<string, HoldEntry>;
	/** The bounded ring of recently applied movement keys; see the constant. */
	appliedMovements?: AppliedMovement[];
	/**
	 * The sku-rename carry-forward's intent, present only between the write that
	 * zeroed this document and the write that clears it. See {@link TransferOut}.
	 */
	transferOut?: TransferOut;
	/**
	 * The bounded ring of transfer tokens already applied to this sku — what makes
	 * the target half of a carry idempotent. Same device and same bound as
	 * {@link InventoryDoc.appliedMovements}; see {@link APPLIED_TRANSFER_RING_SIZE}.
	 */
	appliedTransfers?: string[];
}

/** A reservation's terminal state, recorded once its hold is pruned. */
export type TerminalReservationState = "committed" | "released" | "failed";

/**
 * `reservation_index/{reservationId}` — the reverse lookup, written before the
 * hold.
 *
 * It also carries the reservation's TERMINAL state, because pruning the hold
 * would otherwise erase the difference between "never existed"
 * (`ReservationNotFoundError`) and "existed and was released"
 * (`ReservationCommitLostError`) — two answers the port keeps apart. Live state
 * (qty, orderId, expiresAt, held-vs-adopted) stays in the aggregate; only the
 * terminal fact lands here.
 */
export interface ReservationIndexDoc {
	sku: string;
	/** The reserve idempotency key this reservation's hold is filed under. */
	idempotencyKey: string;
	/** Absent while the reservation is live. */
	terminalState?: TerminalReservationState;
}

/**
 * `reservation_keys/{reserveIdempotencyKey}` — the durable once-only guard for
 * `reserve`, in two states.
 *
 * `claimed` is written create-if-absent BEFORE the inventory `compareAndSet` and
 * carries everything a replayer needs to finish the job — crucially the
 * reservation id, so a completion never mints a second one. `terminal` is the
 * recorded `ReserveResult`, and it **outlives the hold**: it is written before the
 * hold is pruned on commit/release, so a replay after a prune returns the original
 * answer instead of looking fresh and decrementing a second time.
 *
 * A terminal outcome with `reservationId: null` is an `OUT_OF_STOCK` that never
 * minted an id at all (the pre-read showed insufficient stock), which is why the
 * field is nullable rather than absent.
 */
export type ReservationKeyDoc =
	| {
			state: "claimed";
			sku: string;
			qty: number;
			/** Minted once, before the claim. A completion reuses it, never re-mints. */
			reservationId: string;
			claimedAt: string;
	  }
	| {
			state: "terminal";
			result: ReserveResult;
			/** `null` when the outcome was decided before any id was minted. */
			reservationId: string | null;
			recordedAt: string;
	  };

/** The per-key intent of a `restock`/`removeStock`, and its recorded answer. */
export interface StockMovementClaim {
	kind: "stock";
	sku: string;
	direction: StockDirection;
	qty: number;
	createdAt: string;
	/** Set once the aggregate write landed. Its presence IS "this key is done". */
	applied?: { result: StockRemovalResult; appliedAt: string };
}

/** The per-key intent of an `adjust`, and its recorded answer. */
export interface AdjustClaim {
	kind: "adjust";
	sku: string;
	reservationId: string;
	/** The owning reservation's reserve key — where its hold is filed. */
	reserveKey: string;
	/**
	 * The hold qty observed when this intent was recorded. **Audit, not a guard:**
	 * `adjust` takes an absolute target, and the SQL reference re-derives the
	 * previous qty on every retry (a lost qty CAS rolls its claim back with the
	 * transaction), so a completion here likewise re-reads the hold's CURRENT qty
	 * and applies `toQty` against that. Keeping the observed value makes a
	 * re-derived completion legible after the fact.
	 */
	fromQty: number;
	/** The absolute target qty. */
	toQty: number;
	createdAt: string;
	/** Set once the aggregate write landed. Its presence IS "this key is done". */
	applied?: { result: ReserveResult; appliedAt: string };
}

/**
 * `inventory_movements/{claimId}` — one document per movement key, carrying the
 * full intent and then the recorded answer.
 *
 * The intent is what makes a crashed movement completable by any replayer, and
 * the recorded answer is what makes a replay deterministic. The comparison the
 * port requires — a key reused for a DIFFERENT movement, or against a DIFFERENT
 * reservation, must be a typed rejection rather than a wrong-movement `ok` —
 * cannot live inside a single sku's document, which is why these claims are their
 * own collection.
 *
 * The two ledgers share the collection but never the id space: ids are prefixed
 * (`stock:` / `adjust:`), because the port scopes idempotency keys per ledger and
 * the same key value across ledgers is not a collision.
 */
export type MovementClaimDoc = StockMovementClaim | AdjustClaim;

/** Document id for a `restock`/`removeStock` claim. */
export function stockClaimId(key: string): string {
	return `stock:${key}`;
}

/** Document id for an `adjust` claim. */
export function adjustClaimId(key: string): string {
	return `adjust:${key}`;
}

/** A fresh aggregate for a sku that has none. */
export function newInventoryDoc(sku: string, onHand: number): InventoryDoc {
	return { sku, onHand, holds: {} };
}

/**
 * Normalize a stored aggregate so `holds` is always present. Documents written by
 * a seed path (or an earlier build) may lack it, and `noUncheckedIndexedAccess`
 * protects the element type, not the container.
 */
export function normalizeInventoryDoc(doc: InventoryDoc): InventoryDoc {
	return { ...doc, holds: doc.holds ?? {} };
}

/** The recorded answer for `key`, if the aggregate still remembers applying it. */
export function findAppliedMovement(
	ring: readonly AppliedMovement[] | undefined,
	key: string,
): AppliedMovement | undefined {
	return ring?.find((entry) => entry.key === key);
}

/** Append to the ring, evicting the oldest entries past the bound. */
export function pushAppliedMovement(
	ring: readonly AppliedMovement[] | undefined,
	entry: AppliedMovement,
): AppliedMovement[] {
	const next = [...(ring ?? []).filter((existing) => existing.key !== entry.key), entry];
	return next.length > APPLIED_MOVEMENT_RING_SIZE
		? next.slice(next.length - APPLIED_MOVEMENT_RING_SIZE)
		: next;
}

/**
 * How many carry tokens a target document remembers.
 *
 * The ring makes the window between the source's stamp and the source's clear
 * idempotent, and it is bounded for the same reason
 * {@link APPLIED_MOVEMENT_RING_SIZE} is: the hot document must not grow without
 * limit. The residual is the same shape too, and smaller in practice — reaching
 * it takes this many *renames onto one sku*, and a sku that has ever held stock
 * can never be renamed onto again at all (see the port's `SkuStockConflictError`),
 * so in the shipped rule a target accumulates exactly one token in its life. The
 * ring is sized against a future in which that rule relaxes, not against today.
 */
export const APPLIED_TRANSFER_RING_SIZE = 256;

/** Has this carry already been added to the target's count? */
export function hasAppliedTransfer(ring: readonly string[] | undefined, token: string): boolean {
	return ring?.includes(token) === true;
}

/** Append a carry token to the ring, evicting the oldest entries past the bound. */
export function pushAppliedTransfer(ring: readonly string[] | undefined, token: string): string[] {
	const next = [...(ring ?? []).filter((existing) => existing !== token), token];
	return next.length > APPLIED_TRANSFER_RING_SIZE
		? next.slice(next.length - APPLIED_TRANSFER_RING_SIZE)
		: next;
}

/** How many `held`/`adopted` reservations still reference this document's sku. */
export function liveHoldCount(doc: InventoryDoc): number {
	let live = 0;
	for (const hold of Object.values(doc.holds ?? {})) {
		if (hold.state === "held" || hold.state === "adopted") live++;
	}
	return live;
}
