import type { Cents, Currency } from "../money/cents.js";
import type {
	CustomerId,
	IdempotencyKey,
	OrderId,
	ProductId,
	ReservationId,
	Sku,
} from "../money/ids.js";
import type {
	FulfillmentKind,
	Order,
	OrderState,
	PaymentMethod,
	ReconciliationOutcome,
} from "../orders/model.js";

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
	/**
	 * Resolve an open reconciliation flag (admin-UX Increment 1). A **guarded
	 * flip**, following `transition`'s fromState-EQUALITY precedent: `UPDATE
	 * orders SET reconciliation_flag = NULL, reconciliation_outcome = :outcome,
	 * reconciliation_reason = :reason, reconciliation_resolved_by = :resolvedBy,
	 * reconciliation_resolved_at = :now, updated_at = :now WHERE id = :orderId AND
	 * reconciliation_flag = :expectedFlag RETURNING id`. The **equality** guard
	 * (not a bare `IS NOT NULL`) is what defends a stale read: if a NEW settle
	 * anomaly re-flagged the order after the admin loaded the page, the expected
	 * (displayed) flag no longer matches and the flip is a 0-row no-op — a resolve
	 * never clears an anomaly nobody reviewed. 0 rows ⇒ `resolved:false` (already
	 * resolved, re-flagged with a different detail, or never flagged — the
	 * use-case disambiguates on a fresh read). NEVER touches `order_items`/
	 * `order_totals` (the snapshot invariant) or `orders.state` — only the mutable
	 * reconciliation envelope. Exactly one caller wins the flip and writes the
	 * resolution once.
	 */
	resolveReconciliation(
		input: ResolveReconciliationInput,
	): Promise<ResolveReconciliationStoreResult>;

	/**
	 * Record shipping fulfillment on an order AND transition it `processing →
	 * shipped`, atomically (admin-UX Increment 1). Recording fulfillment IS the act
	 * of shipping: a **guarded flip** on `state` (the `transition` precedent) writes
	 * the fulfillment columns, flips `processing → shipped`, and — when
	 * `enqueueEmail` — enqueues the `shipped` outbox row (`ON CONFLICT (order_id,
	 * to_state) DO NOTHING`) all in a SINGLE transaction on one connection. So no
	 * reachable state is "shipped with no fulfillment recorded" (via this path) or
	 * "fulfilled but not shipped", and the shipped email that drains carries the
	 * tracking the buyer needs — never an empty notification.
	 *
	 * The guard is `WHERE id = :orderId AND state = 'processing'`: it makes the
	 * record once-only under concurrency (exactly one caller ships + records) and
	 * composes with the state machine — an order that a concurrent cancel already
	 * moved out of `processing` is a 0-row miss (`recorded:false`), never shipped
	 * behind the cancel's back. NEVER touches `order_items`/`order_totals` (the
	 * snapshot invariant) — only the mutable fulfillment envelope + the guarded
	 * state flip. `shippedAt` null ⇒ the store stamps its own clock; `recordedAt`
	 * is ALWAYS the store clock. `idempotencyKey` is retained for command-shape
	 * consistency; dedup is structural via the guard (mirrors `transition`, H4).
	 */
	recordFulfillment(input: RecordFulfillmentInput): Promise<RecordFulfillmentStoreResult>;

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
	 * Admin Orders console list (view-only). Returns a keyset-paginated page of
	 * lightweight `OrderSummary` PROJECTIONS (never full `Order`s — the list must
	 * not N+1 into `order_items`/`order_totals` per row; the adapter joins
	 * `orders → order_totals` 1:1 in a single SELECT). Ordered `created_at DESC,
	 * id DESC` (newest first, `id` the stable tie-break). Pagination is forward-only
	 * keyset: the caller passes back the previous page's `nextCursor` position; the
	 * adapter fetches `limit + 1` rows to decide whether a next page exists and
	 * emits `nextCursor` from the LAST RETURNED row (null when the page is the last).
	 *
	 * The date window is HALF-OPEN `[from, to)` — `from` inclusive, `to`
	 * EXCLUSIVE. This deliberately DIFFERS from `ReportingStore`'s inclusive/
	 * inclusive `BETWEEN` window (MOD-7): the list is a browsing surface where an
	 * exclusive upper bound composes cleanly for "up to but not including
	 * midnight" day boundaries; the divergence is documented at every call site.
	 */
	listOrders(filter: OrderListFilter, page: OrderListPage): Promise<OrderListResult>;

	/**
	 * Count the orders matching a filter (admin-UX Increment 1: "N orders total"
	 * for the customer-context panel). Shares the EXACT predicate with
	 * `listOrders` — same states/window/search semantics and the same union
	 * `customer` dimension — so a count can never disagree with the list it
	 * captions (one predicate builder in every adapter, MOD-5 in the fake).
	 */
	countOrders(filter: OrderListFilter): Promise<number>;

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

/** The store-level resolve command. `outcome`/`reason`/`resolvedBy` are already
 *  validated (enum + trimmed non-empty) by the use-case; the store persists them
 *  verbatim and stamps `resolved_at` from its own clock. */
export interface ResolveReconciliationInput {
	orderId: OrderId;
	/** The flag detail the ADMIN REVIEWED (as displayed). The guarded UPDATE
	 *  requires `reconciliation_flag = :expectedFlag` — a compare-and-clear, so a
	 *  re-flag between page load and submit is a 0-row miss, never a blind clear. */
	expectedFlag: string;
	outcome: ReconciliationOutcome;
	reason: string;
	resolvedBy: string;
	/** Every command carries one (CLAUDE.md). NOT the dedup mechanism here — dedup
	 *  is structural via the guarded `WHERE reconciliation_flag IS NOT NULL` flip
	 *  (mirrors `transition`, review round H4). Retained for command-shape
	 *  consistency; the adapter accepts but does not key off it. */
	idempotencyKey: IdempotencyKey;
}

/** `resolved:false` ⇒ the guarded flip matched 0 rows (already resolved / never
 *  flagged / lost race). `order` is the current row either way, or null if gone. */
export interface ResolveReconciliationStoreResult {
	resolved: boolean;
	order: Order | null;
}

/** The store-level record-fulfillment command. `carrier`/`trackingNumber`/
 *  `recordedBy` are already validated (trimmed non-empty) by the use-case;
 *  `trackingUrl` is normalized (trimmed → null); the store persists them verbatim
 *  and stamps `recorded_at` from its own clock (and `shipped_at` too when null). */
export interface RecordFulfillmentInput {
	orderId: OrderId;
	carrier: string;
	trackingNumber: string;
	trackingUrl: string | null;
	/** Admin-supplied ship time (ISO-8601 UTC), or null ⇒ the store stamps `now`. */
	shippedAt: string | null;
	recordedBy: string;
	/** Every command carries one (CLAUDE.md). NOT the dedup mechanism here — dedup
	 *  is structural via the guarded `WHERE state='processing'` flip plus the outbox
	 *  `UNIQUE(order_id, to_state)` (mirrors `transition`, H4). Adapters accept but
	 *  do not key off it. */
	idempotencyKey: IdempotencyKey;
	/** Enqueue the `shipped` outbox row in the same transaction. Passed by the
	 *  use-case (`emailTemplateForState('shipped') !== null`), for symmetry with
	 *  `OrderTransitionInput` — the shipped state always has a template. */
	enqueueEmail: boolean;
}

/** `recorded:false` ⇒ the guarded `processing → shipped` flip matched 0 rows
 *  (not in `processing` — already shipped, cancelled, or a lost race). `order` is
 *  the current row either way, or null if the order is gone. */
export interface RecordFulfillmentStoreResult {
	recorded: boolean;
	order: Order | null;
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
	/**
	 * The `order_totals` write. Phase 4 passed only `{ subtotal, total, currency }`
	 * (the stub); Phase 6 passes the full computed breakdown. The extra fields are
	 * additive + optional so Phase-4/5 callers are byte-for-byte: `discount`,
	 * `shipping`, `tax` default `0` and the snapshot columns default `null`,
	 * reproducing the stub. Written ONCE at creation, never rewritten (§6).
	 */
	totals: CreateOrderTotalsInput;
}

export interface CreateOrderTotalsInput {
	subtotal: Cents;
	total: Cents;
	currency: Currency;
	discount?: Cents;
	shipping?: Cents;
	tax?: Cents;
	appliedCouponCode?: string | null;
	shippingMethodSnapshot?: unknown | null;
	taxBreakdown?: unknown | null;
}

export type CreateOrderResult = { created: boolean; order: Order };

// -- Admin Orders console: view-only list (keyset pagination) -----------------

/** Filters for the admin Orders list. All optional — an empty filter lists every
 *  order newest-first. `states` is an OR set (`state IN (...)`); `from`/`to` are a
 *  HALF-OPEN `[from, to)` window on `created_at`; `search` matches an EXACT order
 *  id OR a case-insensitive EXACT `buyer_ref` (never a substring — the fake and
 *  the SQL keep identical `lower(buyer_ref) = lower(:search)` semantics). */
export interface OrderListFilter {
	states?: readonly OrderState[];
	/** Inclusive lower bound (ISO-8601 UTC). */
	from?: string;
	/** EXCLUSIVE upper bound (ISO-8601 UTC) — half-open window (MOD-7). */
	to?: string;
	/** Exact order id OR case-insensitive exact buyer_ref. */
	search?: string;
	/** The customer dimension (admin-UX Increment 1) — see `OrderCustomerKey`.
	 *  ANDed with the other filters; UNION inside the key. */
	customer?: OrderCustomerKey;
}

/**
 * One person's orders, as a UNION key (admin-UX Increment 1). Orders are born
 * `customer_id = NULL` and only back-linked at the customer's NEXT magic-link
 * login (`linkGuestOrders`), so on the common path the same human owns both
 * linked rows (`customer_id` set) and not-yet-relinked rows (`customer_id`
 * NULL, matching `buyer_ref`). A `customer_id`-only predicate silently
 * undercounts; a `buyer_ref`-only one mislabels. The key therefore matches
 * `customer_id = :customerId OR lower(buyer_ref) = lower(:buyerRef)` — safe
 * because `linkGuestOrders` already treats a buyer_ref/email match as ownership
 * proof — and an order matching BOTH halves matches ONCE (it is one row; OR is
 * not additive). `buyerRef` folds case exactly like `search`'s buyer_ref match
 * (`lower() = lower()`, exact, never substring); it exists as its own key —
 * distinct from `search` — because `search` ALSO matches an exact order id.
 * At least one half should be set; an empty key matches nothing it constrains
 * (adapters ignore a key with neither half).
 */
export interface OrderCustomerKey {
	customerId?: string;
	buyerRef?: string;
}

/** A keyset cursor POSITION — the `(created_at, id)` of the last row of the
 *  previous page. Deliberately opaque-free in the domain (NO base64): the service
 *  layer is what wraps this position (plus the active filter) into an opaque
 *  base64url token for the wire. Ordering is `created_at DESC, id DESC`, so the
 *  next page is every row strictly "less than" this position under that order. */
export interface OrderListCursor {
	createdAt: string;
	id: OrderId;
}

/** One page request: an optional starting cursor (null/absent ⇒ first page) and a
 *  page size. */
export interface OrderListPage {
	cursor?: OrderListCursor | null;
	limit: number;
}

/** A lightweight order row for the admin list — a PROJECTION, not a full `Order`:
 *  only what the console table + status badge need, so the list is one join, no
 *  per-row line/totals fan-out. Money is branded `Cents`; `reconciliationFlag` is
 *  a boolean badge (the list never leaks the free-text reconciliation detail). */
export interface OrderSummary {
	id: OrderId;
	state: OrderState;
	currency: Currency;
	buyerRef: string;
	customerId: string | null;
	paymentMethod: PaymentMethod | null;
	createdAt: string;
	total: Cents;
	reconciliationFlag: boolean;
}

export interface OrderListResult {
	orders: OrderSummary[];
	/** The position to pass back for the next page, or null when this is the last
	 *  page (fewer than `limit + 1` rows matched). */
	nextCursor: OrderListCursor | null;
}

export interface RecordPaymentInput {
	orderId: OrderId;
	gateway: PaymentMethod;
	providerRef: string;
	amount: Cents;
	currency: Currency;
	status: string;
}

export type { OrderState };
