import type { Cents, Currency } from "../money/cents.js";
import type {
	CustomerId,
	IdempotencyKey,
	OrderId,
	ProductId,
	ReservationId,
	Sku,
} from "../money/ids.js";
import type { FulfillmentKind, Order, OrderState, PaymentMethod } from "../orders/model.js";

/**
 * The `OrderStore` port (Phase 4 §4/§7). Intent, never SQL: the Kysely adapter
 * co-locates the `orders` + `order_items` + `order_totals` writes on one
 * connection; the in-memory fake models the same behavior. Every state change is
 * a **guarded flip** (0 rows ⇒ someone else won), mirroring the reservation
 * discipline. `payments` recording is folded in here (§7 "or fold events into
 * OrderStore").
 */
export interface OrderStore {
	/**
	 * Insert a `pending` order with its line snapshots + `order_totals` stub,
	 * guarded by `orders.idempotency_key` UNIQUE. The **order row is durably
	 * inserted before any reservation is adopted** (§5 ordering), so a partial
	 * adoption abort leaves a real pending order the sweep can heal. A replay with
	 * the same key returns the existing order (`created:false`) — no re-snapshot.
	 */
	createFromCart(input: CreateOrderInput): Promise<CreateOrderResult>;
	/** Read an order with lines + totals, or null. */
	getById(orderId: OrderId): Promise<Order | null>;
	/**
	 * Read the order a creation `idempotency_key` already minted, or null. Lets
	 * `createOrderFromCart` distinguish a same-key REPLAY (honored — the cart is
	 * legitimately `checked_out` by this very order) from a distinct-key second
	 * checkout of a checked-out cart (rejected `CART_CHECKED_OUT`, review G2).
	 */
	getByIdempotencyKey(key: IdempotencyKey): Promise<Order | null>;
	/** Guarded `pending → paid` flip. 0 rows (not pending) ⇒ false. */
	markPaid(orderId: OrderId): Promise<boolean>;
	/** Guarded `pending → failed` flip. 0 rows ⇒ false. */
	markFailed(orderId: OrderId): Promise<boolean>;
	/**
	 * Order-level guarded expiry (§5): `UPDATE orders SET state='expired' WHERE
	 * id=:id AND state='pending' AND hold_expires_at<=:now RETURNING id`. Re-checks
	 * the deadline inside the flip so a double-sweep race expires exactly once.
	 * 0 rows ⇒ someone else won (paid/failed/expired, or not yet due) ⇒ false.
	 */
	expire(orderId: OrderId, now: string): Promise<boolean>;
	/** Unpaid past-TTL orders: `state='pending' AND hold_expires_at<=:now`. */
	listExpirable(now: string): Promise<OrderId[]>;
	/** Record the settled `payments` row (idempotent on `provider_ref`). */
	recordPayment(input: RecordPaymentInput): Promise<void>;
	/** Flag an order for manual reconciliation (§5 loud anomaly); idempotent. */
	flagReconciliation(orderId: OrderId, detail: string): Promise<void>;

	// -- Phase 5 (§5/§7): order state machine + email outbox ------------------

	/**
	 * The unified guarded transition primitive (Phase 5 §5). Runs the guarded
	 * `UPDATE … WHERE id=:orderId AND state=:fromState RETURNING id` **and**, when
	 * `enqueueEmail`, the outbox `INSERT … ON CONFLICT (order_id, to_state) DO
	 * NOTHING` in a **single transaction on one connection** — so no reachable
	 * state has the order transitioned but no outbox row (or vice versa). A guard
	 * that matches 0 rows (already transitioned / raced) is a no-op:
	 * `transitioned:false`, no outbox write. `markPaid`/`markFailed`/`expire`
	 * route through the same primitive so the Phase-4 transitions also enqueue.
	 */
	transition(input: OrderTransitionInput): Promise<OrderTransitionResult>;

	/** Every order owned by a customer (Phase 5 §7). The identity is derived
	 *  server-side from the session — the customer id is never client-supplied —
	 *  which is the actual mechanism behind "sees only own orders" (§4). */
	listForCustomer(customerId: CustomerId): Promise<Order[]>;

	/**
	 * Claim guest orders for a just-authenticated customer (Phase 5 §9 Risk 3):
	 * `UPDATE orders SET customer_id=:customerId WHERE buyer_ref=:buyerRef AND
	 * customer_id IS NULL`. Safe because a magic-link login already proves the
	 * person owns that inbox. Returns the number of orders linked. Idempotent —
	 * a second login links nothing new.
	 */
	linkGuestOrders(customerId: CustomerId, buyerRef: string): Promise<number>;

	/**
	 * Claim the next dispatchable outbox row (Phase 5 §5 step 2 / §8 5.8) with an
	 * atomic conditional `UPDATE … SET status='sending', lease_until=:leaseUntil
	 * WHERE id=:id AND (status='pending' OR (status='sending' AND lease_until <=
	 * :now)) RETURNING *`. Only one dispatcher can win a claim, and a crashed
	 * run's row becomes claimable again once its lease expires. `null` ⇒ nothing
	 * to dispatch.
	 */
	claimNextEmail(now: string, leaseUntil: string): Promise<OutboxEmail | null>;
	/** Mark a claimed row delivered (`sent_at`), terminal. */
	markEmailSent(id: string, now: string): Promise<void>;
	/** Return a claimed row to `pending` for a later retry (`retryAt`), or mark it
	 *  `failed` (retries exhausted) when `retryAt` is null. */
	rescheduleEmail(id: string, retryAt: string | null): Promise<void>;
}

export interface OrderTransitionInput {
	orderId: OrderId;
	fromState: OrderState;
	toState: OrderState;
	/** Every command carries one (CLAUDE.md). NOT the dedup mechanism here — a
	 *  replay is already a structural no-op via the guarded `WHERE
	 *  state=:fromState` flip plus the outbox `UNIQUE(order_id, to_state)`
	 *  (review round H4). Adapters accept but do not key off this field; it's
	 *  retained for command-shape consistency across the domain. */
	idempotencyKey: IdempotencyKey;
	/** Enqueue an outbox row for `toState` in the same transaction. False for a
	 *  state with no template (`failed`) so no undeliverable row is ever written. */
	enqueueEmail: boolean;
}

export interface OrderTransitionResult {
	/** True iff this call won the guarded flip; false ⇒ already transitioned. */
	transitioned: boolean;
	/** The order after the attempt (current state either way), or null if gone. */
	order: Order | null;
}

/** A claimed outbox row the dispatcher renders + sends (Phase 5 §5). */
export interface OutboxEmail {
	id: string;
	orderId: OrderId;
	toState: OrderState;
	/** Delivery attempts so far (incremented on claim) — drives retry budgeting. */
	attempts: number;
}

/** A line to snapshot into `order_items` — price + title already resolved from
 *  `product_commerce` by the use-case (insert-once). */
export interface CreateOrderLineInput {
	productId: ProductId;
	sku: Sku;
	title: string;
	unitPrice: Cents;
	currency: Currency;
	quantity: number;
	fulfillmentKind: FulfillmentKind;
	/** The (to-be-adopted) Phase-3 reservation for physical lines; null digital. */
	reservationId: ReservationId | null;
}

export interface CreateOrderInput {
	orderId: OrderId;
	cartId: string | null;
	currency: Currency;
	idempotencyKey: IdempotencyKey;
	holdExpiresAt: string;
	buyerRef: string;
	paymentMethod: PaymentMethod | null;
	lines: CreateOrderLineInput[];
	/** The `order_totals` stub (§4): subtotal = total = Σ(unitPrice × quantity). */
	totals: { subtotal: Cents; total: Cents; currency: Currency };
}

export type CreateOrderResult = { created: boolean; order: Order };

export interface RecordPaymentInput {
	orderId: OrderId;
	gateway: PaymentMethod;
	providerRef: string;
	amount: Cents;
	currency: Currency;
	status: string;
}

export type { OrderState };
