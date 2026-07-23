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
	CancellationReason,
	FulfillmentKind,
	Order,
	OrderAddress,
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

	// -- Refunds ledger (ADR-0008) --------------------------------------------

	/**
	 * The order's captured `payments` rows (ADR-0008) — the source of "how much
	 * money we actually hold". `settleOrder` writes one `succeeded` row per
	 * settlement; `refundOrder` sums the succeeded amounts for the refund ceiling
	 * (`Σ captured`) and reads a succeeded row's `providerRef` (the charge/PI id)
	 * as the target of a gateway refund. Scoped to the one order.
	 */
	getCapturedPayments(orderId: OrderId): Promise<CapturedPayment[]>;

	/**
	 * Every refund recorded against an order (ADR-0008), append-only, in
	 * chronological order (`created_at ASC, id ASC`). The ledger — not the order
	 * row — is the source of "how much came back"; the order snapshot
	 * (`order_totals`/`order_items`) is never touched. Scoped to the one order.
	 */
	listRefunds(orderId: OrderId): Promise<RefundRecord[]>;

	/**
	 * The refund already minted under an `idempotencyKey`, or null (ADR-0008). The
	 * `refundOrder` use-case reads this BEFORE calling the gateway so a replay
	 * re-issues nothing (no second provider call) — the structural dedupe on the
	 * `UNIQUE(idempotency_key)` in `recordRefund` is the final authority.
	 */
	getRefundByIdempotencyKey(key: IdempotencyKey): Promise<RefundRecord | null>;

	/**
	 * Record a refund in the append-only ledger with the ceiling enforced
	 * ATOMICALLY (ADR-0008), as a one-shot **finalized** (`status:"recorded"`)
	 * row — the MANUAL/record-only path, where no gateway leg exists (x402 /
	 * no-secret). The gateway path must NOT use this: it goes through the
	 * **reserve-before-issue** pair (`reserveRefund` → gateway → `finalizeRefund`)
	 * so ceiling arbitration always precedes issuance. The whole operation runs
	 * in ONE transaction that FIRST locks the `orders` row (a guarded touch — the
	 * serialization point, so N concurrent refunds on the same order can never
	 * both read a stale `Σ` and over-shoot the ceiling; sqlite serializes writes
	 * so the touch is a harmless no-op there). Under the lock it:
	 *  1. dedupes on `UNIQUE(idempotency_key)` — a replay records nothing and
	 *     returns the existing row (`outcome:"duplicate"`);
	 *  2. computes the ceiling `min(Σ captured payments, order_totals.total)` and
	 *     rejects if `Σ ACTIVE refunds + amount` would exceed it (ACTIVE = every
	 *     non-`voided` row: finalized rows AND held reservations/unverified rows
	 *     all consume ceiling capacity) — `outcome:"exceeds_ceiling"`, carrying
	 *     the authoritative in-transaction `capturedTotal`/`frozenTotal` so the
	 *     use-case picks `REFUND_EXCEEDS_CAPTURED` vs `REFUND_EXCEEDS_TOTAL`;
	 *  3. inserts the ledger row; and when the **finalized** `Σ` reaches the
	 *     ceiling (a FULL refund) drives the `→ refunded` transition through the
	 *     SAME `#flipAndEnqueue` choke point (guarded flip + `order-refunded`
	 *     email + state-change audit event), so the `refunded` state, the email,
	 *     and the ledger row commit together — no reachable "refunded but no
	 *     refund recorded" state. A held reservation NEVER drives the flip. A
	 *     partial refund records the row and does NOT transition (the derived
	 *     "partially refunded" badge lives in the read model). NEVER touches
	 *     `order_items`/`order_totals` (the snapshot invariant).
	 */
	recordRefund(input: RecordRefundInput): Promise<RecordRefundStoreResult>;

	/**
	 * RESERVE a refund's ledger slot BEFORE any gateway issuance (ADR-0008,
	 * reserve-before-issue). Identical atomic shape to `recordRefund` — same
	 * row lock, same dedupe, same ACTIVE-sum ceiling arbitration — but the row is
	 * inserted `status:"reserved"` and the `→ refunded` flip is NEVER driven (a
	 * reservation is not money moved). This is the arbitration point for the
	 * gateway path: a caller whose reservation is rejected (`exceeds_ceiling`)
	 * NEVER reaches the provider, so no interleaving can issue a refund the
	 * ledger then refuses to record — money cannot leave the provider without a
	 * ledger row already holding its capacity.
	 */
	reserveRefund(input: RecordRefundInput): Promise<RecordRefundStoreResult>;

	/**
	 * FINALIZE a reserved refund after the gateway confirmed issuance (ADR-0008):
	 * stamp the provider `refundRef`, flip the row `reserved|unverified →
	 * recorded`, and — when the FINALIZED `Σ` now reaches the ceiling — drive the
	 * `→ refunded` transition through `#flipAndEnqueue`, all in ONE transaction
	 * under the same `orders` row lock as the reserve. Finalize can never fail
	 * arbitration: the reservation already holds the capacity. The row UPDATE is
	 * STATUS-GUARDED (`reserved|unverified` only) — a stray finalize can never
	 * clobber a `voided` or `recorded` row. When the key's row is already
	 * `recorded` with the SAME `refundRef` (a concurrent same-key caller finalized
	 * first — the provider's native idempotency guarantees one refund), the result
	 * is a BENIGN duplicate (`found:true, alreadyFinalized:true`); a DIFFERENT
	 * `refundRef` stays `found:false` — the loud residual the use-case surfaces as
	 * a `REFUND_UNRECORDED` anomaly, never a silent drop of the provider ref.
	 */
	finalizeRefund(input: FinalizeRefundInput): Promise<FinalizeRefundStoreResult>;

	/**
	 * VOID a reservation whose gateway leg definitively did NOT issue (a
	 * pre-flight fail-closed, a terminal provider rejection, or a declared
	 * UNSUPPORTED): guarded `reserved → voided` flip. A voided row RELEASES its
	 * ceiling capacity (excluded from the ACTIVE sum) but stays in the ledger as
	 * an audit record of the attempt. False ⇒ no reserved row under the key.
	 */
	voidRefund(idempotencyKey: IdempotencyKey): Promise<boolean>;

	/**
	 * Mark a reservation UNVERIFIED after an ambiguous gateway outcome (the
	 * errored `refunds.create` whose fate is unknown, ADR-0008): guarded
	 * `reserved → unverified` flip. An unverified row KEEPS holding its ceiling
	 * capacity — the safe direction: if the provider did process it, the ledger
	 * already bounds it; the admin re-checks the provider before anything is
	 * retried or released. False ⇒ no reserved row under the key.
	 */
	markRefundUnverified(idempotencyKey: IdempotencyKey): Promise<boolean>;
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
	 * The guard is `WHERE id = :orderId AND state = :fromState` — the SAME
	 * fromState-equality guard as `transition` (the use-case passes the state it
	 * validated via `isLegalOrderTransition(state, "shipped")`, so the port never
	 * hardcodes a state list): it makes the record once-only under concurrency
	 * (exactly one caller ships + records) and composes with the state machine — an
	 * order that a concurrent cancel already moved out of the fulfillable state is
	 * a 0-row miss (`recorded:false`), never shipped
	 * behind the cancel's back. NEVER touches `order_items`/`order_totals` (the
	 * snapshot invariant) — only the mutable fulfillment envelope + the guarded
	 * state flip. `shippedAt` null ⇒ the store stamps its own clock; `recordedAt`
	 * is ALWAYS the store clock. `idempotencyKey` is retained for command-shape
	 * consistency; dedup is structural via the guard (mirrors `transition`, H4).
	 */
	recordFulfillment(input: RecordFulfillmentInput): Promise<RecordFulfillmentStoreResult>;

	/**
	 * Cancel an order WITH a structured reason, atomically (admin-UX Increment 1,
	 * "cancel with reason"). Routed through the SAME guarded-flip primitive as
	 * `transition`/`recordFulfillment` (`#flipAndEnqueue`'s `extraSet`, PR #63
	 * review precedent — one guarded-flip implementation, never a parallel copy
	 * that could drift): the cancellation columns ride the guarded `WHERE
	 * id=:orderId AND state=:fromState` UPDATE that also flips `state='cancelled'`,
	 * then — when `enqueueEmail` — the `cancelled` outbox row is inserted (`ON
	 * CONFLICT (order_id, to_state) DO NOTHING`), all in ONE transaction on one
	 * connection. So no reachable state is "cancelled with no reason recorded" via
	 * this path, and the cancelled email that drains can carry the reason.
	 *
	 * The guard is `WHERE id = :orderId AND state = :fromState` — the SAME
	 * fromState-equality guard as `transition`/`recordFulfillment` (the use-case
	 * passes the state it validated via `isLegalOrderTransition(state,
	 * "cancelled")`, so the port never hardcodes a state list): it makes the
	 * cancellation once-only under concurrency (exactly one caller cancels +
	 * records the reason) and composes with the state machine — an order a
	 * concurrent `recordFulfillment` (or any other transition) already moved out
	 * of `fromState` is a 0-row miss (`cancelled:false`), never cancelled behind a
	 * concurrent ship's back (and vice versa — see `recordFulfillment`'s doc).
	 * NEVER touches `order_items`/`order_totals` (the snapshot invariant) — only
	 * the mutable cancellation envelope + the guarded state flip.
	 * `idempotencyKey` is retained for command-shape consistency; dedup is
	 * structural via the guard (mirrors `transition`/`recordFulfillment`, H4).
	 */
	cancelOrder(input: CancelOrderInput): Promise<CancelOrderStoreResult>;

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
	 * Every durable state-change event recorded for an order (admin-UX Increment
	 * 1, timeline slice), in chronological order (`at ASC, id ASC` — the id is the
	 * stable tie-break when two events share a timestamp under a fixed clock).
	 * Append-only and scoped to the one order — another order's events never leak
	 * in. Events are captured ATOMICALLY inside the guarded-flip transaction that
	 * moves the order (the `#flipAndEnqueue` choke point), so a row exists iff the
	 * flip won: a replay / lost race is a 0-row flip and writes NO event. State
	 * transitions predating this slice's release have no events, so this returns
	 * only the events written from the release onward — the timeline read merges
	 * the order's derived artifacts to degrade gracefully for such orders. An order
	 * with no events returns `[]`.
	 */
	listEventsForOrder(orderId: OrderId): Promise<OrderEvent[]>;

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
	/** The guarded flip's from-state (the `transition` fromState precedent). The
	 *  use-case derives it from the state machine (`isLegalOrderTransition(state,
	 *  "shipped")`) — the adapter guards `WHERE state = :fromState` and never
	 *  hardcodes a state list of its own. */
	fromState: OrderState;
	carrier: string;
	trackingNumber: string;
	trackingUrl: string | null;
	/** Admin-supplied ship time (ISO-8601 UTC), or null ⇒ the store stamps `now`. */
	shippedAt: string | null;
	recordedBy: string;
	/** Every command carries one (CLAUDE.md). NOT the dedup mechanism here — dedup
	 *  is structural via the guarded `WHERE state=:fromState` flip plus the outbox
	 *  `UNIQUE(order_id, to_state)` (mirrors `transition`, H4). Adapters accept but
	 *  do not key off it. */
	idempotencyKey: IdempotencyKey;
	/** Enqueue the `shipped` outbox row in the same transaction. Passed by the
	 *  use-case (`emailTemplateForState('shipped') !== null`), for symmetry with
	 *  `OrderTransitionInput` — the shipped state always has a template. */
	enqueueEmail: boolean;
}

/** `recorded:false` ⇒ the guarded `fromState → shipped` flip matched 0 rows
 *  (no longer in `fromState` — already shipped, cancelled, or a lost race).
 *  `order` is the current row either way, or null if the order is gone. */
export interface RecordFulfillmentStoreResult {
	recorded: boolean;
	order: Order | null;
}

/** The store-level cancel command. `reason`/`detail`/`cancelledBy` are already
 *  validated (enum + trimmed) by the use-case; the store persists them verbatim
 *  and stamps `cancelled_at` from its own clock. */
export interface CancelOrderInput {
	orderId: OrderId;
	/** The guarded flip's from-state (the `transition`/`recordFulfillment`
	 *  fromState precedent). The use-case derives it from the state machine
	 *  (`isLegalOrderTransition(state, "cancelled")`) — the adapter guards `WHERE
	 *  state = :fromState` and never hardcodes a state list of its own. */
	fromState: OrderState;
	reason: CancellationReason;
	detail: string | null;
	cancelledBy: string;
	/** Every command carries one (CLAUDE.md). NOT the dedup mechanism here — dedup
	 *  is structural via the guarded `WHERE state=:fromState` flip plus the outbox
	 *  `UNIQUE(order_id, to_state)` (mirrors `transition`/`recordFulfillment`, H4).
	 *  Adapters accept but do not key off it. */
	idempotencyKey: IdempotencyKey;
	/** Enqueue the `cancelled` outbox row in the same transaction. Passed by the
	 *  use-case (`emailTemplateForState('cancelled') !== null`), for symmetry with
	 *  `OrderTransitionInput`/`RecordFulfillmentInput` — `cancelled` always has a
	 *  template. */
	enqueueEmail: boolean;
}

/** `cancelled:false` ⇒ the guarded `fromState → cancelled` flip matched 0 rows
 *  (no longer in `fromState` — already cancelled, shipped/refunded, or a lost
 *  race). `order` is the current row either way, or null if the order is gone. */
export interface CancelOrderStoreResult {
	cancelled: boolean;
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
	 * The immutable shipping-address snapshot to freeze onto the order (ADR-0009),
	 * already validated + normalized by the use-case. `null`/absent ⇒ no ship-to
	 * captured (a digital-only order, or a checkout that submitted none). Written
	 * ONCE into the 1:1 `order_shipping_address` alongside the order + totals, in
	 * the same guarded transaction — a replay (idempotency-key conflict) re-inserts
	 * nothing (the address, like the line snapshots, is carried exactly once).
	 */
	shippingAddress?: OrderAddress | null;
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

// -- Order timeline / audit (admin-UX Increment 1, timeline slice) -------------

/**
 * The kind of a durably-audited order event. Currently only state transitions
 * are written to `order_events`; the timeline read-model MERGES the other kinds
 * of history (notes, fulfillment, cancellation, reconciliation resolution) from
 * their EXISTING records at read time rather than double-writing them — so the
 * audit table stays the single home of the state-change spine and never
 * duplicates an artifact that already carries its own timestamp.
 */
export type OrderEventKind = "state_change";

/**
 * An append-only audit record of a durable state change to an order (admin-UX
 * Increment 1, timeline slice). Written ATOMICALLY inside the SAME guarded-flip
 * transaction as the state change it records (the `#flipAndEnqueue` choke
 * point), so an event row exists iff the flip won — a replayed/lost-race flip
 * matches 0 rows and writes no event (audit never double-counts a replay).
 */
export interface OrderEvent {
	id: string;
	orderId: OrderId;
	/** ISO-8601 UTC — the store clock at the moment of the flip. */
	at: string;
	kind: OrderEventKind;
	/** The state the order left (the flip's from-state); null if unknown. */
	fromState: OrderState | null;
	/** The state the order entered (the flip's to-state). */
	toState: OrderState | null;
	/** Who triggered it, when this domain readily knows (`recordFulfillment`'s
	 *  `recordedBy`, `cancelOrder`'s `cancelledBy`); null for transitions where no
	 *  actor is modeled (`markPaid`/`expire`/a bare `transition`). */
	actor: string | null;
}

export interface RecordPaymentInput {
	orderId: OrderId;
	gateway: PaymentMethod;
	providerRef: string;
	amount: Cents;
	currency: Currency;
	status: string;
}

// -- Refunds ledger (ADR-0008) ------------------------------------------------

/** A captured `payments` row surfaced for the refund ceiling + provider-ref
 *  lookup (ADR-0008). `status` is the recorded settlement status — `succeeded`
 *  rows count toward `Σ captured`. */
export interface CapturedPayment {
	gateway: PaymentMethod;
	providerRef: string;
	amount: Cents;
	currency: Currency;
	status: string;
}

/** A refund row (ADR-0008). `kind:"gateway"` carries the provider `refundRef`
 *  (money actually moved); `kind:"manual"` has `refundRef:null` (an out-of-band
 *  return the admin recorded — x402's honest degraded path). `status` is the
 *  row's reserve-before-issue lifecycle — see {@link RefundStatus}. */
export interface RefundRecord {
	id: string;
	orderId: OrderId;
	amount: Cents;
	currency: Currency;
	kind: RefundKind;
	gateway: PaymentMethod;
	refundRef: string | null;
	reason: string | null;
	refundedBy: string;
	status: RefundStatus;
	idempotencyKey: IdempotencyKey;
	createdAt: string;
}

export type RefundKind = "gateway" | "manual";

/**
 * A refund row's lifecycle (ADR-0008, reserve-before-issue):
 *  - `recorded`   — FINALIZED: money moved (gateway, `refundRef` set) or an
 *    out-of-band return was recorded (manual). Counts toward the finalized `Σ`
 *    that drives the full-refund `→ refunded` flip.
 *  - `reserved`   — the ledger slot is held (ceiling arbitration won) but the
 *    gateway leg has not confirmed yet. Holds ceiling capacity; never drives
 *    the state flip. A crash here is resumable (same key re-issues, Stripe's
 *    native idempotency dedupes provider-side).
 *  - `unverified` — the gateway leg ended AMBIGUOUS (timeout, fate unknown).
 *    KEEPS holding capacity — the safe direction — until a human re-checks the
 *    provider. Never drives the flip.
 *  - `voided`     — the gateway leg definitively did not issue (fail-closed
 *    pre-flight / terminal rejection). Capacity RELEASED; kept as an audit
 *    record of the attempt.
 * Ceiling arbitration counts every non-`voided` row (`recorded` + `reserved` +
 * `unverified` — the ACTIVE sum); the `→ refunded` flip counts `recorded` only.
 */
export type RefundStatus = "recorded" | "reserved" | "unverified" | "voided";

/** Finalize a reserved refund with the gateway's confirmed `refundRef`. */
export interface FinalizeRefundInput {
	idempotencyKey: IdempotencyKey;
	refundRef: string;
}

/** `found:false` ⇒ no reserved/unverified row under the key AND no benign
 *  duplicate (impossible by construction on the orchestrated path; the use-case
 *  surfaces it LOUDLY). `alreadyFinalized:true` ⇒ the key's row was ALREADY
 *  `recorded` with the SAME `refundRef` — a concurrent same-key caller finalized
 *  first (the provider's native idempotency guarantees one refund): a benign
 *  duplicate carrying the existing row, NOT an anomaly. A different `refundRef`
 *  under the key stays `found:false` (the loud residual). `fullyRefunded` ⇒ the
 *  finalized `Σ` reached the ceiling: a fresh finalize drove the `→ refunded`
 *  flip; a benign duplicate reports the order already sitting in `refunded`. */
export interface FinalizeRefundStoreResult {
	found: boolean;
	alreadyFinalized: boolean;
	refund: RefundRecord | null;
	fullyRefunded: boolean;
	order: Order | null;
}

/** The store-level record-refund command (ADR-0008). `amount`/`currency` are
 *  already validated (currency-consistent, positive) by the use-case; the gateway
 *  leg (if any) already ran and produced `refundRef`. The store stamps
 *  `created_at` from its own clock. */
export interface RecordRefundInput {
	orderId: OrderId;
	amount: Cents;
	currency: Currency;
	kind: RefundKind;
	gateway: PaymentMethod;
	/** Provider refund id for a `gateway` refund; null for a `manual` record. */
	refundRef: string | null;
	/** Optional free-text reason (trimmed → null by the use-case). */
	reason: string | null;
	refundedBy: string;
	/** Every command carries one (CLAUDE.md); `UNIQUE(idempotency_key)` enforces
	 *  once-only — the ledger dedupe AND (for gateway) Stripe's native key. */
	idempotencyKey: IdempotencyKey;
}

/** The atomic outcome of {@link OrderStore.recordRefund} (ADR-0008).
 *  - `recorded` — the ledger row was written; `fullyRefunded` iff `Σ` reached the
 *    ceiling and the order flipped `→ refunded`.
 *  - `duplicate` — the idempotency key already recorded a refund (`refund` is the
 *    existing row); nothing new written.
 *  - `exceeds_ceiling` — `Σ refunds + amount` would exceed
 *    `min(capturedTotal, frozenTotal)`; nothing written. The use-case picks
 *    `REFUND_EXCEEDS_CAPTURED`/`_TOTAL` from the two bounds.
 *  - `order_not_found` — the order vanished before the guarded write. */
export interface RecordRefundStoreResult {
	outcome: "recorded" | "duplicate" | "exceeds_ceiling" | "order_not_found";
	/** The recorded row (`recorded`) or the existing one (`duplicate`); null
	 *  otherwise. */
	refund: RefundRecord | null;
	/** True iff this refund reached the ceiling and drove `→ refunded`. */
	fullyRefunded: boolean;
	/** Σ captured payments at write time (for the `exceeds_ceiling` bound choice). */
	capturedTotal: Cents;
	/** The frozen `order_totals.total` at write time (for the bound choice). */
	frozenTotal: Cents;
	/** The current order row after the attempt, or null if gone. */
	order: Order | null;
}

export type { OrderState };
