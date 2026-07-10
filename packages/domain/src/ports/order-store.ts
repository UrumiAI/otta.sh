import type { Cents, Currency } from "../money/cents.js";
import type { IdempotencyKey, OrderId, ProductId, ReservationId, Sku } from "../money/ids.js";
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
