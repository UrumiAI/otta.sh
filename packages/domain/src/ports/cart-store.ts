import type { Currency } from "../money/cents.js";
import type { IdempotencyKey } from "../money/ids.js";

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
	/** Mint a fresh 128-bit-unguessable cart, `state='active'`, in `currency`. */
	create(currency: Currency): Promise<string>;
	/** Read a cart with its lines (each carrying its live reservation state), or null. */
	get(cartId: string): Promise<Cart | null>;
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
	 * `UPDATE carts SET state='checked_out' WHERE id=:cartId AND state='active'
	 * RETURNING id`. Order creation calls this once all lines are adopted, so a
	 * post-checkout cart mutation is rejected `CART_CHECKED_OUT` before it can
	 * reach an adopted reservation. `checked_out` is terminal — nothing flips a
	 * cart back to `active` (reactivation would re-open the adopted-hold fence).
	 * Idempotent: a replay finds the cart already `checked_out` (0 rows) and
	 * returns `false` (treated as success for the same order).
	 */
	checkout(cartId: string): Promise<boolean>;
	/**
	 * Held reservations whose hold has lapsed: `expires_at <= now`, or — for a
	 * CART-ORIGINATED hold whose cart-line write never landed (crash window) —
	 * `expires_at IS NULL AND created_at <= cutoff` with the reservation's key
	 * present in the `cart_mutations` ledger. A raw (non-cart) reserve is never
	 * listed. Drives both lazy-on-read and the scheduled sweep.
	 */
	listExpired(now: string, cutoff: string): Promise<ExpiredHold[]>;
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
