import type { Currency } from "../money/cents.js";
import type { IdempotencyKey, OrderId } from "../money/ids.js";

/**
 * The `CartStore` port (Phase 3 §6). Cart truth lives in the commerce service DB
 * (tier ③) — a cart line is a claim on stock, so it must be consistent with the
 * inventory authority. The port expresses **intent, never SQL**; the Kysely
 * adapter co-locates cart-line, reservation-deadline, and idempotency-ledger
 * writes on one connection, while the in-memory fake models the same behavior.
 *
 * Money is intentionally absent: a cart line snapshots **no price** — that is an
 * *order* invariant (Phase 4). The live price is read from `product_commerce`
 * (Phase 1) at display/checkout, not stored here.
 */
export interface CartStore {
	/**
	 * Mint a fresh 128-bit-unguessable cart, `state='active'`, in `currency`.
	 *
	 * With a `key` the create is IDEMPOTENT: every call with the same key — however
	 * many race — answers the same cart (created by whichever call won). The id is
	 * still minted, never derived from the key.
	 *
	 * KEYS ARE SERVER-DERIVED, never caller-chosen: a key answers its cart's id. The
	 * only producer is `replaceSpentCart`, which derives `rotate:<spentCartId>` after
	 * checking the spent cart exists, is checked out and its order is finished — so
	 * the one thing a key reveals is the replacement of a cart the caller already
	 * holds the id of (cart ids are bearer secrets).
	 *
	 * The answer is the cart the key minted, IN WHATEVER STATE IT IS NOW: a keyed
	 * create asked again after its cart has itself been checked out returns that
	 * checked-out cart. A caller adding to it gets CART_CHECKED_OUT, and the next
	 * replacement — keyed on THAT cart — is fresh, so it heals on the next rotation.
	 * Absent ⇒ every call mints a new cart, as before.
	 */
	create(currency: Currency, key?: IdempotencyKey): Promise<string>;
	/** Read a cart with its lines (each carrying its live reservation state), or null. */
	get(cartId: string): Promise<Cart | null>;
	/**
	 * The cart's state and the sum of its lines' quantities, or null for an unknown
	 * cart — from the cart's OWN record only: no reservation state, no hold expiry,
	 * no write. For a reader that only counts (the storefront header, on every
	 * page), where `get`'s per-line reservation reads would be the whole cost.
	 */
	units(cartId: string): Promise<{ state: Cart["state"]; units: number } | null>;
	/**
	 * Read the `cart_mutations` ledger entry for `key`, or null. The use-cases
	 * consult this BEFORE any inventory movement (ledger-first): a `completed`
	 * entry short-circuits the whole mutation to its recorded result, so a stale
	 * replay after intervening mutations can never re-apply a delta.
	 */
	recordedMutation(key: IdempotencyKey): Promise<RecordedCartMutation | null>;
	/**
	 * Claim `key` in the ledger (atomic `INSERT … ON CONFLICT DO NOTHING`),
	 * `completed: false`, BEFORE the inventory movement runs. Losing the claim
	 * returns the existing entry: completed ⇒ replay (the caller returns the
	 * recorded result); incomplete ⇒ a crashed/in-flight peer — the caller resumes
	 * the choreography, whose every step is itself idempotent. The pre-movement
	 * claim also marks the reservation's key as cart-originated, which is what
	 * scopes the sweep's dangling-hold fallback to cart holds (never raw reserves).
	 */
	claimMutation(input: ClaimMutationInput): Promise<ClaimMutationResult>;
	/**
	 * Retire an `add` claim whose reserve was DECIDED with no reservation
	 * (`OUT_OF_STOCK`), so it stops being outstanding work for the sweep.
	 *
	 * The claim exists so a crash between it and the line write leaves a marker
	 * the sweep can follow to a dangling hold. A decided-out-of-stock reserve has
	 * no hold and never will — the reserve key is once-only, so every replay reads
	 * back the same refusal — yet the claim stayed outstanding for good, and an
	 * adapter that indexes outstanding claims for its sweep (the document store's
	 * `holdExpiresAt`) kept that cart listed and re-read it on every tick.
	 *
	 * The record is RETIRED, never completed and never deleted: it reads back
	 * `completed: false, abandoned: true`, so a same-key replay resumes, re-reads
	 * the reserve's refusal and answers `OUT_OF_STOCK` again. An adapter may bound
	 * how many retired records it keeps; once one is evicted, a very late replay of
	 * its key finds no record and runs as a fresh add — which, if the cart has
	 * since gained a line for that sku, is an increment of that line answered with
	 * current truth, exactly the residual an evicted COMPLETED record already has.
	 * Idempotent; a no-op for an absent key, an unknown cart, or a record that is
	 * completed or already retired. The caller must only retire a claim whose
	 * reserve answered not-ok: retiring one that may still own a hold would hide
	 * that hold from the sweep.
	 */
	abandonClaim(cartId: string, key: IdempotencyKey): Promise<void>;
	/**
	 * Write/replace the line for `input.sku` and mark the `input.key` ledger
	 * entry completed (recording the resulting line). Also stamps the
	 * reservation's `expires_at` so an abandoned hold is reaped by the sweep —
	 * and that stamp doubles as the attach guard: it is scoped to
	 * `state='held'`, and a reservation that is no longer held (the sweep reaped
	 * a crashed hold before this late replay arrived) throws `HoldExpiredError`
	 * instead of resurrecting a visible line over dead stock ("visible line ⟺
	 * live hold"). Idempotent: an already-completed entry returns the line
	 * without re-applying.
	 */
	upsertLine(input: UpsertLineInput): Promise<CartLine>;
	/**
	 * Set the line qty, reset its hold `expires_at`, and mark the ledger entry
	 * completed. The stored line qty is written from the reservation's own qty
	 * when one exists (the inventory authority's truth), so racing different-key
	 * adjusts converge instead of last-writer desync. Idempotent on a completed
	 * entry.
	 */
	adjustLine(input: AdjustLineInput): Promise<CartLine>;
	/** Delete the line and mark the removal completed in the ledger; double-remove is a no-op. */
	removeLine(cartId: string, lineId: string, key: IdempotencyKey): Promise<void>;
	/**
	 * Secondary cart-state fence (Phase 4 §5): the guarded flip
	 * `UPDATE carts SET state='checked_out', order_id=:orderId
	 * WHERE id=:cartId AND state='active' RETURNING id`. Order creation calls
	 * this once all lines are adopted, so a post-checkout cart mutation is
	 * rejected `CART_CHECKED_OUT` before it can reach an adopted reservation.
	 * `checked_out` is terminal — nothing flips a cart back to `active`
	 * (reactivation would re-open the adopted-hold fence).
	 *
	 * **One statement, two columns** — the state and the order id are set by the
	 * same conditional UPDATE and are never observable apart. That also makes the
	 * existing `state='active'` predicate the CAS that gives `order_id` its
	 * write-once behavior for free: the second writer matches 0 rows, so there is
	 * no separate constraint and no `WHERE order_id IS NULL`.
	 *
	 * Idempotent: a replay finds the cart already `checked_out` (0 rows) and
	 * returns `false` (treated as success for the same order). `false` therefore
	 * now means TWO things at once: the cart was already terminal, **and this
	 * call did not record its order id**.
	 *
	 * **The converse does NOT hold**: `orderId === null` does not mean no order
	 * exists for this cart. The stamp is written only after every hold is
	 * adopted. A crash between `orderStore.createFromCart` and this flip leaves a
	 * real `pending` order behind an `active`, NULL cart until the same key is
	 * replayed (the replay of a `pending` order re-runs adoption and this flip);
	 * a `RESERVATION_LOST` abort leaves it that way permanently — no replay of
	 * that key ever flips it.
	 * The column answers "which order did this cart *successfully* hand off to",
	 * never "does an order exist for this cart". `orders.cart_id` remains the
	 * only complete answer to the latter and is not maintained here.
	 *
	 * `orderId` is BRANDED (unlike `Cart.orderId` below, and unlike
	 * `InventoryStore.adoptMany`'s plain `orderId`, which takes the very same
	 * `order.id` two statements earlier — the repo is genuinely mixed per port).
	 * It is branded here because it is a **command input**: branding makes
	 * passing a cart id, a line id, or any other bare string in this position a
	 * type error, exactly as `OrderStore.getById(orderId: OrderId)` does.
	 */
	checkout(cartId: string, orderId: OrderId): Promise<boolean>;
	/**
	 * Held reservations whose hold has lapsed: `expires_at <= now`, or — for a
	 * CART-ORIGINATED hold whose cart-line write never landed (crash window) —
	 * `expires_at IS NULL AND created_at <= cutoff` with the reservation's key
	 * present in the `cart_mutations` ledger. A raw (non-cart) reserve is never
	 * listed. Drives both lazy-on-read and the scheduled sweep.
	 *
	 * A hold that can no longer be expired (its reservation released or committed
	 * behind the cart's back) is never listed. A store that keeps a DERIVED
	 * candidate index (the document store's `holdExpiresAt`) may rewrite that index
	 * while listing, so such a cart stops matching — and that is the ONLY write a
	 * listing may make: it never touches stock, holds, lines or the mutation ledger.
	 * A store with no derived index (the in-memory fake, which filters live holds
	 * directly on every call) has nothing to heal.
	 */
	listExpired(now: string, cutoff: string, options?: ExpiryListOptions): Promise<ExpiredHold[]>;
	/**
	 * Atomically expire one hold: the guarded flip `held → released` RE-CHECKS
	 * the deadline inside the same conditional statement (`expires_at <= now`, or
	 * the ledger-scoped NULL/`created_at <= cutoff` fallback), and only the flip
	 * winner returns the stock and drops the cart line(s). Returns false — never
	 * throws — on 0 rows: the hold was TTL-reset by a concurrent mutation, already
	 * released, or adopted. A lazy read racing the sweep (or a checkout) can
	 * therefore never double-return or reap an active shopper's hold.
	 */
	expireHold(reservationId: string, now: string, cutoff: string): Promise<boolean>;
}

export type CartMutationKind = "add" | "adjust" | "remove";

/** A `cart_mutations` ledger entry — the uniform replay record (§4). */
export interface RecordedCartMutation {
	key: IdempotencyKey;
	cartId: string;
	kind: CartMutationKind;
	lineId: string | null;
	resultingQty: number | null;
	/** False until the mutation's final write landed; a replay of an incomplete
	 *  entry RESUMES the choreography instead of short-circuiting. */
	completed: boolean;
	/** True once `abandonClaim` (or the sweep) retired an incomplete claim: it is
	 *  no longer outstanding work. Informational — a replay still resumes on
	 *  `completed: false`. Absent on every other record. */
	abandoned?: boolean;
}

export interface ClaimMutationInput {
	key: IdempotencyKey;
	cartId: string;
	kind: CartMutationKind;
	lineId?: string | null;
}

export type ClaimMutationResult =
	| { claimed: true }
	| { claimed: false; recorded: RecordedCartMutation };

/**
 * Thrown by `CartStore.upsertLine` when the reservation to attach is no longer
 * `held` — e.g. the sweep reaped a crashed dangling hold before the original
 * add's late replay arrived. The add use-case maps it to the typed
 * `HOLD_EXPIRED` failure: the replay must NOT create a visible cart line over
 * stock the shopper no longer holds.
 */
export class HoldExpiredError extends Error {
	constructor(reservationId: string) {
		super(`reservation ${reservationId} is no longer held; the hold expired or was reaped`);
		this.name = "HoldExpiredError";
	}
}

export type CartState = "active" | "checked_out";

/**
 * A reservation's lifecycle as seen by the cart. `adopted` is Phase 4's
 * post-checkout state (declared here for forward-compat): the cart fence treats
 * anything other than `held` as no longer cart-owned.
 */
export type ReservationLifecycle =
	| "pending"
	| "held"
	| "committed"
	| "released"
	| "failed"
	| "adopted";

export interface Cart {
	cartId: string;
	state: CartState;
	/**
	 * The order this cart successfully handed off to, stamped by `checkout` in
	 * the same statement as `state` (issue #132); null on every `active` cart.
	 *
	 * PLAIN `string | null`, not branded — an aggregate's own id is branded, a
	 * CROSS-AGGREGATE reference is not. This is the exact mirror of
	 * `Order.cartId: string | null` sitting beside `Order.id: OrderId` in
	 * `orders/model.ts`, and of the "branding at the use-case boundary" note in
	 * `orders/create-order-from-cart.ts` ("the cart line carries a plain
	 * `string | null` reservation id"). The branding happens where the id is
	 * *minted* and where it is *commanded* (`checkout`'s parameter), not where a
	 * neighbouring aggregate merely reports it.
	 *
	 * NOT a proof of payment, and NOT a complete answer to "does an order exist
	 * for this cart" — see `CartStore.checkout`.
	 */
	orderId: string | null;
	currency: Currency;
	lines: CartLine[];
}

export interface CartLine {
	lineId: string;
	cartId: string;
	sku: string;
	/** Forward hook for Phase 1's `product_commerce`; null until product lookup lands. */
	productId: string | null;
	qty: number;
	/** Null for a digital line (Phase 4) that carries no reservation. */
	reservationId: string | null;
	/** Live reservation state for the cart fence; null when there is no reservation. */
	reservationState: ReservationLifecycle | null;
	/** Per-line hold deadline (ISO-8601 UTC); null when there is no reservation. */
	expiresAt: string | null;
}

export interface ExpiredHold {
	reservationId: string;
}

export interface UpsertLineInput {
	cartId: string;
	sku: string;
	productId: string | null;
	qty: number;
	/** Null for a **digital** line (Phase 4 §6): it reserves nothing, so there is
	 *  no hold to attach/stamp and no attach guard. Physical lines carry the held
	 *  reservation as before. */
	reservationId: string | null;
	expiresAt: string | null;
	key: IdempotencyKey;
}

export interface AdjustLineInput {
	cartId: string;
	lineId: string;
	newQty: number;
	/** Null for a digital line (no hold to re-stamp, Phase 4 §6). */
	expiresAt: string | null;
	key: IdempotencyKey;
}

/**
 * Bounds an expiry LIST (`CartStore.listExpired`, `OrderStore.listExpirable`).
 *
 * The scheduled sweep runs in a host hook with a hard timeout, and an unbounded
 * list reads the whole backlog — every page, plus per-row reads — before the
 * sweep's own per-unit checks ever run. With a `limit` the store stops reading
 * once it holds that many candidates and returns at most that many; without one
 * it returns them all, as before. A positive integer; anything else is a
 * `RangeError`. Which candidates a limited call returns is unspecified: the
 * rest are still lapsed, and still listed, on the next call.
 */
export interface ExpiryListOptions {
	readonly limit?: number;
	/**
	 * Asked before each CANDIDATE the store would examine (a cart document, for a
	 * document store; a hold, for the fake); `false` ends the list with what it
	 * has. The bound on the list's own cost: a run of candidates that yield
	 * nothing, or carts with many lines, would otherwise be read in full before the
	 * caller's per-unit budget ever runs. Default: never stop.
	 */
	readonly shouldContinue?: () => boolean;
}
