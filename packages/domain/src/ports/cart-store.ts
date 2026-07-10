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
	 * Write/replace the line for `input.sku` and record the add in the
	 * `cart_mutations` ledger under `input.key` (once-only). Also stamps the
	 * reservation's `expires_at` so an abandoned hold is reaped by the sweep. A
	 * replay (same key) returns the already-recorded line without re-applying.
	 */
	upsertLine(input: UpsertLineInput): Promise<CartLine>;
	/**
	 * Set the line to `input.newQty` (absolute) and reset its hold `expires_at`,
	 * recorded once in the ledger under `input.key`. A replay returns the recorded
	 * line — the load-bearing "a retried +1 must not become +2" guard.
	 */
	adjustLine(input: AdjustLineInput): Promise<CartLine>;
	/** Delete the line and record the removal in the ledger; double-remove is a no-op. */
	removeLine(cartId: string, lineId: string, key: IdempotencyKey): Promise<void>;
	/**
	 * Held reservations whose hold has lapsed: `expires_at <= now`, or — for a hold
	 * whose cart-line write never landed (crash window) — `expires_at IS NULL AND
	 * created_at <= cutoff`. Drives both lazy-on-read and the scheduled sweep.
	 */
	listExpired(now: string, cutoff: string): Promise<ExpiredHold[]>;
	/**
	 * Drop the cart line(s) for an expired reservation. Ledger-free (expiry is not
	 * a client mutation) and idempotent (0 rows if already reaped). The stock
	 * return is the caller's guarded `InventoryStore.release`.
	 */
	releaseExpired(reservationId: string): Promise<void>;
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
	reservationId: string;
	expiresAt: string;
	key: IdempotencyKey;
}

export interface AdjustLineInput {
	cartId: string;
	lineId: string;
	newQty: number;
	expiresAt: string;
	key: IdempotencyKey;
}
