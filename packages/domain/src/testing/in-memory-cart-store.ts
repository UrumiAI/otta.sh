import type { Currency } from "../money/cents.js";
import type {
	AdjustLineInput,
	Cart,
	CartLine,
	CartState,
	CartStore,
	ExpiredHold,
	ReservationLifecycle,
	UpsertLineInput,
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

/** Ledger-free hold deadline the cart stamped on a reservation (mirrors the
 *  real store's `reservations.expires_at`), keyed by reservation id. */
interface HoldRow {
	reservationId: string;
	sku: string;
	expiresAt: string;
}

export interface InMemoryCartStoreOptions {
	idGen: IdGen;
	/**
	 * Live reservation state lookup (the real adapter JOINs `reservations`). Wired
	 * to the `InMemoryInventoryStore` in tests so the cart fence and expiry see the
	 * same reservation lifecycle the inventory authority does.
	 */
	reservationState: (reservationId: string) => ReservationLifecycle | undefined;
}

/**
 * IO-free `CartStore` fake — the first adapter to pass `cartStoreContract`
 * (§7 B2/B3). It models the real adapter's behavior: one line per `(cartId,
 * sku)`, a `cart_mutations` idempotency ledger, per-reservation hold deadlines,
 * and lifecycle-aware expiry. Deterministic and synchronous so the contract's
 * replay/expiry/fence cases run here before any DB.
 */
export class InMemoryCartStore implements CartStore {
	#idGen: IdGen;
	#reservationState: (reservationId: string) => ReservationLifecycle | undefined;

	#carts = new Map<string, CartRow>();
	#lines = new Map<string, LineRow>();
	#holds = new Map<string, HoldRow>();
	/** `cart_mutations` ledger: idempotencyKey → recorded outcome. */
	#ledger = new Map<string, { lineId: string | null }>();

	constructor(options: InMemoryCartStoreOptions) {
		this.#idGen = options.idGen;
		this.#reservationState = options.reservationState;
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

	async upsertLine(input: UpsertLineInput): Promise<CartLine> {
		const recorded = this.#ledger.get(input.key);
		if (recorded !== undefined && recorded.lineId !== null) {
			return this.#toLine(this.#mustLine(recorded.lineId));
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
		this.#ledger.set(input.key, { lineId: row.id });
		return this.#toLine(row);
	}

	async adjustLine(input: AdjustLineInput): Promise<CartLine> {
		const recorded = this.#ledger.get(input.key);
		if (recorded !== undefined) {
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
		this.#ledger.set(input.key, { lineId: row.id });
		return this.#toLine(row);
	}

	async removeLine(cartId: string, lineId: string, key: string): Promise<void> {
		if (this.#ledger.has(key)) return; // replay: already removed
		const row = this.#lines.get(lineId);
		this.#ledger.set(key, { lineId: null });
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

	async releaseExpired(reservationId: string): Promise<void> {
		this.#holds.delete(reservationId);
		for (const [id, row] of this.#lines) {
			if (row.reservationId === reservationId) this.#lines.delete(id);
		}
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
