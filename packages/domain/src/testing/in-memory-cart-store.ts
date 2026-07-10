import type { Currency } from "../money/cents.js";
import type { IdempotencyKey } from "../money/ids.js";
import {
	type AdjustLineInput,
	type Cart,
	type CartLine,
	type CartMutationKind,
	type CartState,
	type CartStore,
	type ClaimMutationInput,
	type ClaimMutationResult,
	type ExpiredHold,
	HoldExpiredError,
	type RecordedCartMutation,
	type ReservationLifecycle,
	type UpsertLineInput,
} from "../ports/cart-store.js";
import type { IdGen } from "../ports/id-gen.js";

interface CartRow {
	id: string;
	currency: Currency;
	state: CartState;
}

interface LineRow {
	id: string;
	cartId: string;
	sku: string;
	productId: string | null;
	qty: number;
	reservationId: string | null;
	expiresAt: string | null;
}

/** Hold deadline the cart stamped on a reservation (mirrors the real store's
 *  `reservations.expires_at`), keyed by reservation id. Raw (non-cart) reserves
 *  never appear here — the sweep scoping the real store gets from its
 *  `cart_mutations` ledger JOIN. */
interface HoldRow {
	reservationId: string;
	sku: string;
	expiresAt: string;
}

interface LedgerRow {
	key: string;
	cartId: string;
	kind: CartMutationKind;
	lineId: string | null;
	resultingQty: number | null;
	completed: boolean;
}

export interface InMemoryCartStoreOptions {
	idGen: IdGen;
	/**
	 * Live reservation state lookup (the real adapter JOINs `reservations`). Wired
	 * to the `InMemoryInventoryStore` in tests so the cart fence and expiry see the
	 * same reservation lifecycle the inventory authority does.
	 */
	reservationState: (reservationId: string) => ReservationLifecycle | undefined;
	/**
	 * Return an expired hold's stock (the real adapter increments `on_hand` inside
	 * the same guarded-flip transaction). Wired to the inventory fake's `release`.
	 */
	releaseHold: (reservationId: string) => void;
}

/**
 * IO-free `CartStore` fake — the first adapter to pass `cartStoreContract`
 * (§7 B2/B3). It models the real adapter's behavior: one line per `(cartId,
 * sku)`, the claim/complete `cart_mutations` idempotency ledger (ledger-first
 * replay), per-reservation hold deadlines, and the guarded,
 * deadline-re-checking `expireHold` flip. Deterministic and synchronous so the
 * contract's replay/expiry/fence cases run here before any DB.
 */
export class InMemoryCartStore implements CartStore {
	#idGen: IdGen;
	#reservationState: (reservationId: string) => ReservationLifecycle | undefined;
	#releaseHold: (reservationId: string) => void;

	#carts = new Map<string, CartRow>();
	#lines = new Map<string, LineRow>();
	#holds = new Map<string, HoldRow>();
	/** `cart_mutations` ledger: idempotencyKey → claim/completion record. */
	#ledger = new Map<string, LedgerRow>();

	constructor(options: InMemoryCartStoreOptions) {
		this.#idGen = options.idGen;
		this.#reservationState = options.reservationState;
		this.#releaseHold = options.releaseHold;
	}

	async create(currency: Currency): Promise<string> {
		const id = this.#idGen.newId();
		this.#carts.set(id, { id, currency, state: "active" });
		return id;
	}

	async get(cartId: string): Promise<Cart | null> {
		const cart = this.#carts.get(cartId);
		if (cart === undefined) return null;
		const lines: CartLine[] = [];
		for (const row of this.#lines.values()) {
			if (row.cartId === cartId) lines.push(this.#toLine(row));
		}
		lines.sort((a, b) => a.lineId.localeCompare(b.lineId));
		return { cartId: cart.id, state: cart.state, currency: cart.currency, lines };
	}

	async recordedMutation(key: IdempotencyKey): Promise<RecordedCartMutation | null> {
		const row = this.#ledger.get(key);
		return row === undefined ? null : this.#toRecorded(row);
	}

	async claimMutation(input: ClaimMutationInput): Promise<ClaimMutationResult> {
		const existing = this.#ledger.get(input.key);
		if (existing !== undefined) {
			return { claimed: false, recorded: this.#toRecorded(existing) };
		}
		this.#ledger.set(input.key, {
			key: input.key,
			cartId: input.cartId,
			kind: input.kind,
			lineId: input.lineId ?? null,
			resultingQty: null,
			completed: false,
		});
		return { claimed: true };
	}

	async upsertLine(input: UpsertLineInput): Promise<CartLine> {
		const recorded = this.#ledger.get(input.key);
		if (recorded !== undefined && recorded.completed && recorded.lineId !== null) {
			return this.#toLine(this.#mustLine(recorded.lineId));
		}

		// Attach guard (mirrors the real store's `state='held'`-scoped deadline
		// stamp): never attach a visible line to a reservation that is no longer
		// held — e.g. the sweep reaped a crashed hold before this late replay.
		if (this.#reservationState(input.reservationId) !== "held") {
			throw new HoldExpiredError(input.reservationId);
		}

		const existing = this.#findLine(input.cartId, input.sku);
		const row: LineRow = existing ?? {
			id: this.#idGen.newId(),
			cartId: input.cartId,
			sku: input.sku,
			productId: input.productId,
			qty: input.qty,
			reservationId: input.reservationId,
			expiresAt: input.expiresAt,
		};
		row.qty = input.qty;
		row.productId = input.productId;
		row.reservationId = input.reservationId;
		row.expiresAt = input.expiresAt;
		this.#lines.set(row.id, row);
		this.#holds.set(input.reservationId, {
			reservationId: input.reservationId,
			sku: input.sku,
			expiresAt: input.expiresAt,
		});
		this.#complete(input.key, input.cartId, "add", row.id, input.qty);
		return this.#toLine(row);
	}

	async adjustLine(input: AdjustLineInput): Promise<CartLine> {
		const recorded = this.#ledger.get(input.key);
		if (recorded !== undefined && recorded.completed) {
			return this.#toLine(this.#mustLine(input.lineId));
		}

		const row = this.#mustLine(input.lineId);
		row.qty = input.newQty;
		row.expiresAt = input.expiresAt;
		if (row.reservationId !== null) {
			this.#holds.set(row.reservationId, {
				reservationId: row.reservationId,
				sku: row.sku,
				expiresAt: input.expiresAt,
			});
		}
		this.#complete(input.key, input.cartId, "adjust", row.id, input.newQty);
		return this.#toLine(row);
	}

	async removeLine(cartId: string, lineId: string, key: IdempotencyKey): Promise<void> {
		const recorded = this.#ledger.get(key);
		if (recorded !== undefined && recorded.completed) return; // replay: already removed
		this.#complete(key, cartId, "remove", lineId, null);
		const row = this.#lines.get(lineId);
		if (row === undefined) return; // double-remove: no-op
		this.#lines.delete(lineId);
		if (row.reservationId !== null) this.#holds.delete(row.reservationId);
	}

	async listExpired(now: string, _cutoff: string): Promise<ExpiredHold[]> {
		const out: ExpiredHold[] = [];
		for (const hold of this.#holds.values()) {
			if (this.#reservationState(hold.reservationId) === "held" && hold.expiresAt <= now) {
				out.push({ reservationId: hold.reservationId });
			}
		}
		return out;
	}

	async expireHold(reservationId: string, now: string, _cutoff: string): Promise<boolean> {
		// The guarded flip, atomically re-checking the deadline (synchronous, so
		// check + release + drop are one block like the real store's transaction):
		// 0 rows — unknown, TTL-reset, or no longer `held` — is a quiet false.
		const hold = this.#holds.get(reservationId);
		if (hold === undefined) return false;
		if (hold.expiresAt > now) return false; // TTL was reset: an active shopper
		if (this.#reservationState(reservationId) !== "held") return false;

		this.#releaseHold(reservationId); // the flip winner returns the stock…
		this.#holds.delete(reservationId);
		for (const [id, row] of this.#lines) {
			if (row.reservationId === reservationId) this.#lines.delete(id); // …and drops the line
		}
		return true;
	}

	// -- test surface ---------------------------------------------------------

	/** Flip a cart to `checked_out` (Phase 4 does this at order creation). */
	checkout(cartId: string): void {
		const cart = this.#carts.get(cartId);
		if (cart === undefined) throw new Error(`unknown cart: ${cartId}`);
		cart.state = "checked_out";
	}

	/**
	 * Simulate the reserve↔cart-line crash window: a hold that finalized (`held`)
	 * but whose cart-line write never landed, so it is tracked only by its
	 * deadline. The sweep must reclaim it once its TTL passes (B5).
	 */
	seedDanglingHold(reservationId: string, sku: string, expiresAt: string): void {
		this.#holds.set(reservationId, { reservationId, sku, expiresAt });
	}

	// -- internals ------------------------------------------------------------

	#complete(
		key: string,
		cartId: string,
		kind: CartMutationKind,
		lineId: string | null,
		resultingQty: number | null,
	): void {
		this.#ledger.set(key, { key, cartId, kind, lineId, resultingQty, completed: true });
	}

	#toRecorded(row: LedgerRow): RecordedCartMutation {
		return {
			key: row.key as IdempotencyKey,
			cartId: row.cartId,
			kind: row.kind,
			lineId: row.lineId,
			resultingQty: row.resultingQty,
			completed: row.completed,
		};
	}

	#toLine(row: LineRow): CartLine {
		return {
			lineId: row.id,
			cartId: row.cartId,
			sku: row.sku,
			productId: row.productId,
			qty: row.qty,
			reservationId: row.reservationId,
			reservationState:
				row.reservationId === null ? null : (this.#reservationState(row.reservationId) ?? null),
			expiresAt: row.expiresAt,
		};
	}

	#findLine(cartId: string, sku: string): LineRow | undefined {
		for (const row of this.#lines.values()) {
			if (row.cartId === cartId && row.sku === sku) return row;
		}
		return undefined;
	}

	#mustLine(lineId: string): LineRow {
		const row = this.#lines.get(lineId);
		if (row === undefined) throw new Error(`unknown cart line: ${lineId}`);
		return row;
	}
}
