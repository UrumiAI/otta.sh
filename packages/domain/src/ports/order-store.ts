import type { ExpiryListOptions } from "./cart-store.js";
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
	CancellationRefund,
	CancellationRestockPending,
	FulfillmentKind,
	Order,
	OrderAddress,
	OrderNotice,
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
	/**
	 * Order-level guarded expiry (§5): `UPDATE orders SET state='expired' WHERE
	 * id=:id AND state='pending' AND hold_expires_at<=:now RETURNING id`. Re-checks
	 * the deadline inside the flip so a double-sweep race expires exactly once.
	 * 0 rows ⇒ someone else won (paid/cancelled/expired, or not yet due) ⇒ false.
	 */
	expire(orderId: OrderId, now: string): Promise<boolean>;
	/**
	 * `expire`, for the sweep (QA2 M2): the SAME guarded flip, answering with what
	 * the expiry use-case needs next so it never re-reads the order. `null` when
	 * this call did not win the flip (exactly when `expire` would answer `false`);
	 * otherwise the order as the flip left it, and whether the store has ALREADY
	 * released the holds the order adopted.
	 *
	 * `holdsReleased: true` is a promise, not a hint: a store that records a release
	 * intent with the flip and completes it in the same call (the document store)
	 * says so, and the use-case then releases nothing itself. A store that cannot,
	 * or whose completion failed this time (its intent stays outstanding for the
	 * completer), says `false` and the use-case releases them through
	 * `InventoryStore.releaseAdoptedMany`, which is order-scoped and idempotent.
	 */
	expireWithOrder(orderId: OrderId, now: string): Promise<ExpiredOrder | null>;
	/**
	 * Unpaid past-TTL orders: `state='pending' AND hold_expires_at<=:now`, oldest
	 * deadline first.
	 *
	 * `excludeIntentDue` (QA3 N1): leave out every order with a payment intent that
	 * is DUE for withdrawal and not yet withdrawn (`cancelOutcome` null and
	 * `cancelDueAt <= now`) — such an order must not expire while the buyer can still
	 * pay it; `cancelDueIntents` withdraws it first. An intent whose cancel failed and
	 * was rescheduled is not due until its retry, so a provider outage never holds an
	 * order. `limit` then counts the orders LISTED, not the ones read: the store keeps
	 * reading past excluded ones (within its page bound).
	 */
	listExpirable(now: string, options?: OrderExpiryListOptions): Promise<OrderId[]>;
	/** Record the settled `payments` row (idempotent on `provider_ref`). */
	recordPayment(input: RecordPaymentInput): Promise<void>;

	// -- Payment intents (late-payment prevention) ----------------------------

	/**
	 * Remember a payment intent the gateway minted for this order — idempotent on
	 * `(orderId, intentId)`: a checkout replay that re-issues the SAME intent (the
	 * provider's native idempotency) records nothing new.
	 *
	 * WHY THE ORDER HAS TO REMEMBER IT. The intent id used to live only in the
	 * checkout reply and the buyer's pay-page cookie, so when the order expired
	 * nothing on the server could name the intent to cancel — and a buyer who kept
	 * the pay page open could still pay an order whose stock was already back on
	 * sale.
	 *
	 * DUE AT THE HOLD. A new intent is recorded with `cancelDueAt` = the order's
	 * `holdExpiresAt`: the instant from which, unless the order was paid, it should
	 * no longer be payable. The intent-cancel sweep (`cancelDueIntents`) drains due
	 * intents through {@link listIntentCancelsDue}; an order that is PAID owes no
	 * cancel, so the guarded `pending → paid` flip resolves its unresolved intents
	 * (`not_needed`) in the same write, and they never reach the sweep.
	 *
	 * A LIST, not a field: Stripe expires idempotency keys after ~24 h, so a very
	 * late checkout replay can mint a second intent for the same order, and every
	 * intent that can still be paid is one that must be cancelled.
	 */
	recordPaymentIntent(input: RecordPaymentIntentInput): Promise<void>;
	/** The intents recorded for this order, oldest first (empty when none). */
	listPaymentIntents(orderId: OrderId): Promise<PaymentIntentRecord[]>;
	/**
	 * Orders holding at least one UNRESOLVED intent whose `cancelDueAt <= now`,
	 * earliest first, at most `limit` — the intent-cancel sweep's batch.
	 */
	listIntentCancelsDue(now: string, limit: number): Promise<OrderId[]>;
	/**
	 * Write one intent's cancel bookkeeping: reschedule it (`cancelDueAt` set,
	 * `cancelOutcome` null), or resolve it (`cancelDueAt` null, an outcome set). A
	 * resolved intent leaves the due index for good. No-op for an unknown order or
	 * intent. Last-writer-wins on the entry; the domain owns the policy.
	 *
	 * THE RACE THIS ALLOWS IS HARMLESS. Two writers can meet on one entry — two
	 * overlapping sweep runs, or an unpaid cancel expediting an intent while a sweep
	 * reschedules it — and the later write wins outright. Every outcome of that is
	 * safe: the worst is one extra (idempotently-keyed, so deduplicated by Stripe)
	 * cancel call, or an intent looked at a little later than it could have been.
	 * Nothing here moves money; a payment that slips through is refunded at settle.
	 */
	updatePaymentIntentCancel(
		orderId: OrderId,
		intentId: string,
		update: PaymentIntentCancelUpdate,
	): Promise<void>;

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

	/**
	 * A person's answer to an UNVERIFIED refund, "it didn't happen" (review round
	 * 2): guarded `unverified → voided`, releasing the row's ceiling capacity and
	 * recording `resolvedBy` on it. False ⇒ no unverified row under the key. The
	 * other answer, "confirmed at the provider", is {@link finalizeRefund} with
	 * `resolvedBy`.
	 */
	voidUnverifiedRefund(input: {
		idempotencyKey: IdempotencyKey;
		resolvedBy: string;
	}): Promise<boolean>;
	/**
	 * Read the order AND its ledgers — state-change audit, captured payments,
	 * refunds — in ONE read of the aggregate, or `null` when there is no such order.
	 *
	 * The late-payment paths (settle's cure, the storefront's "was anything
	 * charged?" status, the refund-retry sweep) need all four together, and every
	 * one of them already lives on the order's single document: reading them
	 * through `getById` + `listEventsForOrder` + `getCapturedPayments` +
	 * `listRefunds` would read that same document four times, on a page a buyer
	 * reloads.
	 */
	readOrderLedger(orderId: OrderId): Promise<OrderLedger | null>;
	/**
	 * Schedule (or, with `null`, clear) a retry of ONE automatic late-payment refund,
	 * keyed by that refund's idempotency key — set after a transient provider
	 * failure, cleared once the refund is finalized or handed to a human. PER REFUND,
	 * not per order: an order can carry two late captures, and finishing one must
	 * never drop the retry the other still needs. The order is due
	 * ({@link listRefundRetriesDue}) while ANY of its refunds is scheduled.
	 * Last-writer-wins per key; the store only remembers the bookkeeping, the
	 * domain owns what a retry means (`retryLatePaymentRefunds`).
	 *
	 * WHY IT EXISTS. Stripe's redelivery is the first retry, but Stripe stops after
	 * a few days, and a `reserved` refund row keeps holding ceiling capacity —
	 * which would also refuse any admin refund against the same money — until
	 * something resumes it or hands it to a human.
	 */
	scheduleRefundRetry(
		orderId: OrderId,
		idempotencyKey: IdempotencyKey,
		retry: RefundRetrySchedule | null,
	): Promise<void>;
	/** Orders with at least one scheduled refund retry due (`at <= now`), earliest
	 *  first, at most `limit`. */
	listRefundRetriesDue(now: string, limit: number): Promise<OrderId[]>;
	/**
	 * Orders with at least one scheduled refund retry whose FIRST failure (`since`)
	 * is at or before `cutoff`, oldest first, at most `limit` — the give-up
	 * escalation's own list. Ranked by age rather than by due time, so a run of
	 * due-but-young retries at the head of the due list can never keep a stale
	 * one from being handed to a human.
	 */
	listRefundRetriesStale(cutoff: string, limit: number): Promise<OrderId[]>;
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

	/**
	 * Close the restock a cancellation recorded as pending on its flip
	 * (`OrderCancellation.restockPending`, issue #364): clear the marker and record
	 * `restocked`. Called AFTER the units went back through the inventory's keyed
	 * `restock`, by the cancellation itself, its replay, or the sweep.
	 *
	 * Guarded on the marker's own key, so it is idempotent and never clears a marker
	 * it did not finish: a second call (or a racing replay) is `completed:false`.
	 * Touches only the cancellation envelope — never lines, totals or state. An adapter
	 * that indexes outstanding cross-aggregate work (the document store's
	 * `holdsPendingAt`) re-derives that index in the same write.
	 */
	completeCancellationRestock(
		input: CompleteCancellationRestockInput,
	): Promise<CompleteCancellationRestockResult>;

	/**
	 * Count one more failed attempt at a cancellation's pending restock
	 * (`restockPending.failures`), guarded on the marker's key like
	 * `completeCancellationRestock`. Returns the new count, or 0 when no marker is
	 * pending under that key. Touches only the cancellation envelope.
	 */
	recordCancellationRestockFailure(orderId: OrderId, idempotencyKey: string): Promise<number>;

	// -- Phase 5 (§5/§7): order state machine + email outbox ------------------

	/**
	 * The unified guarded transition primitive (Phase 5 §5). Runs the guarded
	 * `UPDATE … WHERE id=:orderId AND state=:fromState RETURNING id` **and**, when
	 * `enqueueEmail`, the outbox `INSERT … ON CONFLICT (order_id, to_state) DO
	 * NOTHING` in a **single transaction on one connection** — so no reachable
	 * state has the order transitioned but no outbox row (or vice versa). A guard
	 * that matches 0 rows (already transitioned / raced) is a no-op:
	 * `transitioned:false`, no outbox write. `markPaid`/`expire`
	 * route through the same primitive so the Phase-4 transitions also enqueue.
	 */
	transition(input: OrderTransitionInput): Promise<OrderTransitionResult>;

	/** Every order owned by a customer (Phase 5 §7), NEWEST FIRST — `created_at
	 *  DESC, id DESC`, the admin list's order — because a shopper's list leads with
	 *  the order they just placed. The identity is derived server-side from the
	 *  session — the customer id is never client-supplied — which is the actual
	 *  mechanism behind "sees only own orders" (§4). */
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
	 * ONE ROW PER ORDER, whatever the filter reaches. The only table this may join
	 * is the 1:1 `order_totals`; any 1:N table a filter has to consult — today
	 * `order_items`, for `search`'s line-sku half — is reached by an EXISTENCE test
	 * and never by a join, or an order with two matching lines is returned twice,
	 * the `limit + 1` next-page detection counts duplicates as rows, and the page
	 * silently shrinks. `countOrders` shares the predicate and so shares the rule.
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
	 * Claim guest orders for a customer whose inbox is PROVEN (Phase 5 §9 Risk 3):
	 * `UPDATE orders SET customer_id=:customerId WHERE lower(buyer_ref)=lower(:buyerRef)
	 * AND customer_id IS NULL`. Called at sign-in (`verifyLogin` — the magic link
	 * just proved the inbox) and, since ADR-0004's 2026-10-02 amendment, whenever a
	 * signed-in customer lists their orders (`listCustomerOrders` — a live session
	 * is the same proof until it expires or is revoked). Pass only the customer's
	 * own email. Returns the number of orders linked. Idempotent — a second call
	 * links nothing new.
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
	/**
	 * Enqueue a NON-transition email about this order (see {@link OrderNotice}) on
	 * the same outbox the state emails drain from — first-wins per
	 * `(orderId, notice.kind, notice.refundId)`, the notice analogue of the state
	 * rows' `UNIQUE(order_id, to_state)`. The finalizing refund writes
	 * (`finalizeRefund`, the one-shot `recordRefund`) append a `refund-issued` notice
	 * in the SAME write for a `refund`-purpose row that leaves money captured
	 * (ADR-0026); a row that reaches the ceiling is announced by the `refunded` state
	 * email instead, and a `cancellation` or `late-payment` row by its own email. A replay (a redelivered webhook re-driving the
	 * step that enqueued it) writes nothing and answers `false`; `true` ⇒ this call
	 * enqueued the row. The row's `toState` is the order's state at enqueue time —
	 * informational only; the dispatcher picks the template from `notice`.
	 * `false` too when the order does not exist.
	 */
	enqueueNotice(orderId: OrderId, notice: OrderNoticeInput): Promise<boolean>;
	/**
	 * {@link claimNextEmail} narrowed to ONE order: the earliest due row of `orderId`,
	 * under the same due predicate, the same lease and the same single-winner
	 * conditional write — so it composes with a concurrent `claimNextEmail` (or a
	 * second call of its own) exactly as two global dispatchers do (ADR-0005). `null`
	 * ⇒ that order has nothing due (none enqueued, all sent/failed, or leased), or the
	 * order does not exist; it NEVER claims another order's row.
	 *
	 * It exists for the payment-settle route, which sends the order it just settled
	 * inline (ADR-0005's 2026-10-02 amendment). A request must never run the global
	 * drain — that walks the whole queue and belongs to the cron — and an order-scoped
	 * claim is a single read of one aggregate plus one write, bounded by construction.
	 *
	 * `onlyUnattempted` narrows it further to rows NO dispatcher has tried yet —
	 * `attempts === 0` AND `timeouts === 0` — checked inside the same conditional
	 * write, on top of the due predicate (so a row backed off to a future due time is
	 * never claimable early either). The settle route passes it: it makes at most one
	 * COUNTED attempt per row (the total budget, `maxAttempts`, is unchanged), so
	 * repeated deliveries during a provider outage cannot spend that budget and park
	 * the email `failed` within minutes. A cut-short inline attempt is released
	 * uncounted, so it may recur on a later delivery before the sweep takes the row
	 * (the provider `Idempotency-Key` dedupes it); and a row the cron has already
	 * backed off — an uncounted timeout leaves `attempts` at 0 but `timeouts` above
	 * it — is never retried inline, so a request can never undercut the cron's
	 * backoff.
	 */
	claimNextEmailForOrder(
		orderId: OrderId,
		now: string,
		leaseUntil: string,
		options?: ClaimEmailForOrderOptions,
	): Promise<OutboxEmail | null>;
	/**
	 * Mark a claimed row delivered (`sent_at`), terminal. Only ever called on a row
	 * `claimNextEmail` has already handed this dispatcher, so the entry it names is
	 * expected to EXIST. An adapter that cannot LOCATE the claimed entry must throw
	 * a typed RETRYABLE error rather than silently succeeding: a silent no-op would
	 * report a delivery that was never recorded, and the entry would sit in
	 * `sending` until its lease expired. The two adapter shapes differ
	 * legitimately: a SQL store addresses the row by PRIMARY KEY (`where id = :id`,
	 * no further condition) inside the same database the claim came from, so its
	 * zero-row outcome is the SILENT NO-OP form and cannot mean "looked in the wrong
	 * place" — the row is simply gone — while a document store that must re-read the
	 * owning aggregate to reach the entry throws when the entry is absent, because
	 * there a miss is indistinguishable from a lost write.
	 */
	markEmailSent(id: string, now: string): Promise<void>;
	/**
	 * Return a claimed row to `pending` for a later retry (`retryAt`), or mark it
	 * `failed` (retries exhausted) when `retryAt` is null. The locate semantics are
	 * `markEmailSent`'s, unchanged: the SQL adapters' guarded update treats an
	 * unfound row as a no-op, a document adapter throws a typed retryable error,
	 * and neither may report success without having written the reschedule.
	 */
	rescheduleEmail(id: string, retryAt: string | null, reason?: string): Promise<void>;
	/**
	 * Hand a claimed row back UNTRIED: `pending`, due at once, and with the
	 * attempt its claim counted taken back off. For a dispatcher that claimed a
	 * row and then could not try it — its time ran out before the send, or the
	 * send was cut off by the dispatcher's own timeout — so the row's
	 * `maxAttempts` budget is spent only on tries the provider actually got. The
	 * locate semantics are `markEmailSent`'s; only a `sending` row is released, so
	 * a double release is a no-op.
	 *
	 * `retryAt` moves the row's due time FORWARD (a backoff — without it the row is
	 * due at once); `timedOut` also records one more dispatcher timeout on it
	 * (`OutboxEmail.timeouts`). A row released with a forward due time sits behind
	 * every other due row, so one that keeps timing out cannot hold the head of the
	 * queue.
	 */
	releaseEmailClaim(id: string, options?: ReleaseEmailClaimOptions): Promise<void>;
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
	/** The refund the cancellation already issued, recorded on the envelope
	 *  verbatim (`OrderCancellation.refund`). Absent ⇒ `null`. */
	refund?: CancellationRefund | null;
	/** Whether the cancellation restocked the order's units, recorded verbatim
	 *  (`OrderCancellation.restocked`). Absent ⇒ `false`. */
	restocked?: boolean;
	/** The restock the cancellation will do once this flip lands, recorded verbatim
	 *  (`OrderCancellation.restockPending`) so a replay or the sweep can finish it.
	 *  Absent ⇒ `null` (nothing owed). */
	restockPending?: CancellationRestockPending | null;
}

/** Close a cancellation's pending restock (`completeCancellationRestock`). */
export interface CompleteCancellationRestockInput {
	orderId: OrderId;
	/** The key the pending restock was recorded under; a marker under any other key
	 *  is left alone. */
	idempotencyKey: string;
	/** Whether any unit came back — ORed into `OrderCancellation.restocked`. */
	restocked: boolean;
}

/** `completed:false` ⇒ nothing was pending under that key (already closed, never
 *  recorded, or the order is gone). `order` is the current row, or null. */
export interface CompleteCancellationRestockResult {
	completed: boolean;
	order: Order | null;
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
	/** Who made the move — recorded on the flip's audit event. Absent ⇒ `null`. */
	actor?: string;
}

export interface OrderTransitionResult {
	/** True iff this call won the guarded flip; false ⇒ already transitioned. */
	transitioned: boolean;
	/** The order after the attempt (current state either way), or null if gone. */
	order: Order | null;
}

/**
 * A notice to enqueue, WITH the facts its email states. The amount is the money
 * the notice is about — for `late-payment-refunded`, the refund itself — and NOT
 * the order total: a late capture can differ from the total, and an email that
 * tells the buyer the wrong figure came back is worse than no email.
 */
export interface OrderNoticeInput {
	kind: OrderNotice;
	amount: Cents;
	currency: Currency;
	/** The refund the notice announces, when it announces one. Part of the dedupe
	 *  key: first-wins per `(orderId, kind, refundId)`, so two refunds of the same
	 *  kind are two emails and a replay of either is none. */
	refundId?: string;
}

/** One refund's retry bookkeeping ({@link OrderStore.scheduleRefundRetry}). */
export interface RefundRetrySchedule {
	/** When to try again (ISO-8601 UTC). */
	at: string;
	/** Transient failures so far — drives the backoff. */
	attempts: number;
	/** When the FIRST transient failure happened — drives the give-up window. */
	since: string;
}

/** A scheduled retry, as the ledger read reports it. */
export interface RefundRetry extends RefundRetrySchedule {
	idempotencyKey: IdempotencyKey;
}

/** Remember one gateway-minted payment intent against its order. */
export interface RecordPaymentIntentInput {
	orderId: OrderId;
	gateway: PaymentMethod;
	/** The provider's intent id (`pi_…` for Stripe). */
	intentId: string;
}

/**
 * How an intent's cancel ended:
 *  - `cancelled` / `not_cancellable` — the provider withdrew it / it was already
 *    final (succeeded or cancelled);
 *  - `unsupported` — the gateway holds no standing intent or no credential;
 *  - `not_needed` — the order was paid (or vanished): there is nothing to withdraw;
 *  - `failed` — a terminal refusal, or retries exhausted. Logged; the late-payment
 *    refund remains the backstop.
 */
export type PaymentIntentCancelOutcome =
	| "cancelled"
	| "not_cancellable"
	| "unsupported"
	| "not_needed"
	| "failed";

/** A payment intent recorded for an order ({@link OrderStore.recordPaymentIntent}). */
export interface PaymentIntentRecord {
	gateway: PaymentMethod;
	intentId: string;
	/** ISO-8601 UTC — the store clock when it was first recorded. */
	recordedAt: string;
	/** When the sweep should next look at it; `null` once resolved. */
	cancelDueAt: string | null;
	/** Cancel attempts the sweep has made (transient failures count). */
	cancelAttempts: number;
	/** How it ended; `null` while unresolved. */
	cancelOutcome: PaymentIntentCancelOutcome | null;
}

/** One intent's next cancel bookkeeping ({@link OrderStore.updatePaymentIntentCancel}). */
export interface PaymentIntentCancelUpdate {
	cancelDueAt: string | null;
	cancelAttempts: number;
	cancelOutcome: PaymentIntentCancelOutcome | null;
}

/** The order with its ledgers, as {@link OrderStore.readOrderLedger} returns it. */
export interface OrderLedger {
	order: Order;
	events: OrderEvent[];
	payments: CapturedPayment[];
	refunds: RefundRecord[];
	/** The order's scheduled late-payment refund retries, by key order. */
	refundRetries: RefundRetry[];
	/** The payment intents its checkout recorded, oldest first. */
	paymentIntents: PaymentIntentRecord[];
}

/** Narrowing for {@link OrderStore.claimNextEmailForOrder}. */
export interface ClaimEmailForOrderOptions {
	/** Claim only a row no dispatcher has tried before — never claimed for an
	 *  attempt (`attempts === 0`) and never timed out (`timeouts === 0`). */
	onlyUnattempted?: boolean;
}

/** How {@link OrderStore.releaseEmailClaim} hands a row back. */
export interface ReleaseEmailClaimOptions {
	/** When the row is due again (a backoff). Absent: due at once. */
	readonly retryAt?: string;
	/** The send was cut off for time: record one more timeout on the row. */
	readonly timedOut?: boolean;
}

/** A claimed outbox row the dispatcher renders + sends (Phase 5 §5). */
export interface OutboxEmail {
	id: string;
	orderId: OrderId;
	toState: OrderState;
	/** Delivery attempts so far (incremented on claim) — drives retry budgeting. */
	attempts: number;
	/** Sends that timed out with their FULL allowance (`EmailSendTimeoutError`,
	 *  not cut short) — not attempts, but counted separately so a provider that is
	 *  merely slow is backed off and, past a limit, reported and counted after all.
	 *  It stops at that limit (`MAX_UNCOUNTED_TIMEOUTS`): from then on a timeout is
	 *  recorded as an attempt instead, so the row's `attempts` carries the rest. 0
	 *  when absent. */
	timeouts: number;
	/** Set on a NON-transition row ({@link OrderStore.enqueueNotice}): the
	 *  dispatcher renders the notice's template, with its own payload, instead of
	 *  `toState`'s. `null` on every state-transition row. */
	notice: OrderNoticeInput | null;
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
	/**
	 * The account that owns the order FROM BIRTH, or absent/null for a guest order.
	 * Set only when the checkout came from a session whose customer's email IS the
	 * `buyerRef` (`checkoutOwner`), so it is the same claim `linkGuestOrders` makes
	 * at the next sign-in — made now, so a signed-in shopper's order is in their
	 * list at once instead of after another magic link. A replay keeps the first
	 * write's owner: the order, like its snapshots, is written once.
	 */
	customerId?: CustomerId | null;
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
 *  HALF-OPEN `[from, to)` window on `created_at`; `search` matches an order-id
 *  PREFIX, a folded `buyer_ref` PREFIX or an EXACT purchase-time line sku — see
 *  the field below. */
export interface OrderListFilter {
	states?: readonly OrderState[];
	/** Inclusive lower bound (ISO-8601 UTC). */
	from?: string;
	/** EXCLUSIVE upper bound (ISO-8601 UTC) — half-open window (MOD-7). */
	to?: string;
	/**
	 * The operator's free-text lookup: an order-id PREFIX, **or** a folded
	 * `buyer_ref` PREFIX, **or** an EXACT purchase-time line sku, ORed, with
	 * `lower()` applied to BOTH sides of all three arms. Spelled in SQL — as the
	 * FLOOR, not as any adapter's emitted statement — that is `lower(id) LIKE
	 * lower(:s || '%')` OR `lower(buyer_ref) LIKE lower(:s || '%')` OR `EXISTS
	 * (SELECT id FROM order_items WHERE order_id = orders.id AND lower(sku) =
	 * lower(:s))`. No shipped adapter emits exactly that: the SQL stores emit the
	 * unanchored `lower('%' || :s || '%')` on the buyer-reference arm (their
	 * sanctioned superset, below), and a document store emits no SQL at all. The
	 * spelling is here because a predicate is clearer as a predicate than as prose.
	 *
	 * THAT IS A FLOOR, NOT A CEILING — the ratified narrowing (ADR-0019 §6). The
	 * contract suite GUARANTEES exactly this much of every adapter: a PREFIX of the
	 * id matches, a PREFIX of the folded buyer reference matches, an EXACT folded
	 * line sku matches, and `%`, `_` and `\` in the search string are compared as
	 * characters rather than as pattern syntax. Both text arms are therefore
	 * ANCHORED. An adapter MAY match MORE — a store whose SQL can serve an
	 * unanchored `LIKE` keeps the buyer-reference arm as a SUBSTRING, a superset of
	 * the guarantee — so the contract deliberately does NOT assert that a
	 * mid-string fragment fails; an adapter whose filter algebra has no substring
	 * operator serves the prefix and pins its own narrower behaviour in its own
	 * package tests. Callers may rely on the floor only. The narrowing is
	 * user-visible on the buyer-reference axis (a domain-only fragment stops being
	 * a search) and belongs in the screen's empty state, not only here.
	 *
	 * WHY A PREFIX ON THE ID. The console never renders a full uuid — it renders
	 * the shortest unique prefix (the git-style short id in
	 * `admin-presentation`'s `shortIdsFor`/`shortIdFixed`). The characters an
	 * operator can actually see, read out and type back are therefore a PREFIX,
	 * and an exact-only match made the one identifier on screen unsearchable. A
	 * whole id is its own prefix, so the previous exact-match behaviour survives
	 * as a special case. The id half is ANCHORED on purpose: an unanchored id
	 * match would surface arbitrary rows on any hex fragment.
	 *
	 * WHY A PREFIX ON THE BUYER REF, RATHER THAN AN EXACT MATCH. It holds the
	 * customer's email, and an operator arrives with what they can read off a
	 * ticket — usually the start of the address — not the address exactly as
	 * stored. A whole address is its own prefix, so the exact lookup survives as a
	 * special case, exactly as it does on the id arm. Anchored rather than
	 * unanchored because the guarantee has to sit where EVERY store can meet it.
	 *
	 * WHY THE SKU HALF READS THE ORDER'S OWN LINES, AND IS EXACT. The sku matched
	 * is the one FROZEN onto the order's lines at purchase time — the same
	 * insert-once snapshot the detail screen renders — never the live catalogue's
	 * current sku for that product. Renaming a product's sku therefore leaves
	 * every earlier order findable under the sku it was bought as, and moves none
	 * of them to the new one; that is the point of the snapshot, and the contract
	 * pins it. The half is EXACT (folded, but no prefix, no substring) because a
	 * sku is an IDENTIFIER an operator pastes whole off a packing slip or a
	 * support ticket, and because exactness is the settled house rule for skus:
	 * `ProductListFilter.search` matches an exact-lower sku beside its substring
	 * title, and the `customer` key below keeps exact-lower `buyer_ref` for the
	 * same identity reason. A substring here would drag every variant of a family
	 * (`TEE-BLK-S`, `TEE-BLK-M`, …) into a search for one of them, which is a
	 * different question from the one the operator asked.
	 *
	 * ONE ROW PER ORDER, WHATEVER THE SKU ARM MATCHES — and that is the INVARIANT,
	 * not a mechanism. Lines are 1:N against the order; the list's contract is one
	 * row per order (`listOrders` doc) and `countOrders` shares the predicate, so an
	 * order carrying two matching lines must appear ONCE and count ONCE. Returning
	 * it twice would inflate the `limit + 1` next-page probe, shrink the page and
	 * make the count disagree with the caption it writes. HOW each adapter reaches
	 * that is its own business: the SQL adapters express the arm as a correlated
	 * `EXISTS` and never as a join onto `order_items` (a join is exactly the shape
	 * that double-counts), the in-memory fake as `lines.some(...)`, and a document
	 * store as a denormalized per-`(sku, order)` key whose id makes uniqueness
	 * tautological. The contract pins the invariant on all of them.
	 *
	 * WHY THE FOLD IS EXPLICIT ON BOTH SIDES. A bare `LIKE` is case-SENSITIVE on
	 * Postgres and ASCII-case-INSENSITIVE on SQLite; only an explicit `lower()`
	 * on both operands makes the two dialects and the fake agree. The pattern
	 * side is folded by SQL `lower()` rather than JS `toLowerCase()` — one
	 * function folds both operands, so within a dialect the two sides cannot
	 * drift. Known, accepted divergence (the same one `couponFilterConditions`
	 * and `linkGuestOrders` already carry): SQLite's built-in `lower()` folds
	 * ASCII only, while JS `toLowerCase()` is Unicode-aware, so a non-ASCII
	 * buyer_ref ("JOSÉ@…") folds differently on sqlite than on pg/the fake.
	 * Emails and hex ids are ASCII, which is why this is accepted rather than
	 * solved. Ids are lowercase hex (`crypto.randomUUID()`), so folding the id is
	 * a no-op on the STORED side — it is there to forgive the TYPED side, e.g. a
	 * uuid pasted back from a client that upper-cased it. The sku half folds the
	 * same way and inherits the same caveat: it spells `lower(sku) = lower(:s)`
	 * (SQL folding both operands) rather than the products list's `lower(sku) =
	 * :sJsLowered` — identical for the ASCII skus a catalogue actually carries,
	 * and one fewer place the two sides can drift apart within a dialect.
	 *
	 * WILDCARDS ARE LITERAL. `%`, `_` and `\` (the escape character itself) are
	 * `LIKE` metacharacters; a search containing them matches them as characters
	 * (the SQL adapters escape the pattern and pass `ESCAPE '\'`; the fake and a
	 * document store build no `LIKE` pattern at all, so their `startsWith`/
	 * `includes` are literal by construction). The
	 * sku half needs no escaping at all — an equality has no pattern language, so
	 * a sku spelled `50%_OFF` is compared character for character.
	 *
	 * THE EMPTY STRING MATCHES EVERYTHING, because every string starts with `""`
	 * (and, on an adapter serving the wider arm, contains it). That is the widest
	 * filter this axis has, not the narrowest — the inverted reading of "search for
	 * nothing". (The sku half does
	 * not widen it further and does not narrow it: `""` equals no real sku, and
	 * the id arm has already matched every row.) The service's query schema
	 * requires `min(1)`, so the wire cannot send it; the boundary is pinned in the
	 * contract for every other caller.
	 *
	 * THE SEQUENTIAL SCAN IS THE DESIGN IN THE SQL ADAPTERS, not an oversight. The
	 * unanchored substring THEY serve as their superset of the buyer-reference arm
	 * cannot be served by a b-tree, so `idx_orders_buyer_ref_lower` (migration
	 * `0022`) no longer backs their predicate; nor can the primary key serve the
	 * anchored id half, since a default-collation b-tree answers
	 * `LIKE 'x%'` only with `text_pattern_ops`, and either way an OR arm that
	 * must scan forces a scan for the whole predicate. A trigram/full-text index
	 * was declined outright at this scale, and the shape of the cost was measured
	 * before deciding: over 5k rows, a page whose search matches NOTHING (the
	 * worst case — the whole table scanned, then sorted) took 3.4 ms, and one
	 * with matches dense enough for the `(created_at, id)` keyset index to keep
	 * driving the ordering took under 1 ms with the search riding as a heap
	 * filter. Read those as a FLOOR, not as the production statement: they came
	 * from a synthetic four-column `orders` table with no `order_totals` join and
	 * no other filter axis, and a searched page issues the list AND the exact
	 * filtered-set count together, so a real page pays this predicate twice under
	 * the same filter (see `countOrders`). They are not comparable
	 * to the products list's ~27 ms/page figure either — different table, columns
	 * and harness — which is why that number is cited only as the precedent for
	 * ACCEPTING an unanchored scan, never as a bound on this one. Revisit if
	 * orders reach a scale where the shape stops holding; measure the real
	 * statement then. The index still backs every EQUALITY path on `buyer_ref` —
	 * `linkGuestOrders` and the `customer` key below — which is exactly why those
	 * keep exact-lower-equals semantics and did NOT follow this widening.
	 *
	 * THE SKU ARM IS PLANNED DIFFERENTLY BY THE TWO DIALECTS, and neither shape
	 * was assumed — both were read off `EXPLAIN` of the statement the adapter
	 * actually compiles, over a synthetic 5k-order / 10k-line set (ANALYZEd).
	 *
	 * ON POSTGRES IT IS ONE MORE SCAN, of `order_items`, not a per-row probe. pg
	 * DE-CORRELATES the `EXISTS` into a hashed subplan: one pass over the line
	 * table filtered on `lower(sku)` — a sequential scan, since `lower(sku)` has
	 * no index — hashed by `order_id` and then probed in memory per row. That pass
	 * is paid by EVERY search, including one that is plainly an id or an email,
	 * and by BOTH statements a searched page issues. Measured (statement
	 * `Execution Time`, pg 16): a sku search 6.3 ms for the page and 5.9 ms for
	 * its count, against 2.8 ms and 2.8 ms for the same search with the arm
	 * stripped out; an id-PREFIX search 5.4 ms and 5.6 ms, against 4.2 ms and
	 * 2.7 ms without it. Forcing the intuitive plan instead (`enable_seqscan =
	 * off`, which does make the probe an index scan on
	 * `idx_order_items_order_product`, 5000 loops) was SLOWER — 21–24 ms across
	 * runs — so that index is not what keeps this cheap on pg; the hash is.
	 *
	 * ON SQLITE IT IS THE OPPOSITE, and that is fine. SQLite keeps the subquery
	 * CORRELATED and serves it as a per-row `SEARCH order_items USING INDEX
	 * idx_order_items_order_product (order_id=?)`, so there the arm rides the very
	 * index the pg plan ignores; and because SQL's `OR` short-circuits and the two
	 * cheap arms are written FIRST, a row already matched by id or buyer_ref never
	 * runs the probe at all. Measured there (mean of 5 store calls,
	 * better-sqlite3): 4.4 ms for an id-prefix page against 5.2 ms for a sku page.
	 *
	 * Read all of these as a SHAPE, not a budget, for the same reasons the figures
	 * above are a floor. The obvious lever, if the shape stops holding on pg, is a
	 * functional index on `lower(order_items.sku)`, which turns that one scan into
	 * an index scan; deliberately not pulled now, on the same reasoning that
	 * declined the trigram index — measure the real statement first.
	 */
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
 * not additive). `buyerRef` folds case (`lower() = lower()`) but stays EXACT —
 * it deliberately did NOT follow `search`'s widening to a prefix, because
 * this key is an IDENTITY predicate (whose orders are these?) rather than a
 * fuzzy lookup: an unanchored OR anchored fragment would fold two customers into
 * one person's history (`amy@` reaches `amy@a.test` and `amy@b.test` alike),
 * and equality is what keeps `idx_orders_buyer_ref_lower` on the plan. It exists
 * as its own key — distinct from `search` — for that reason, and because
 * `search` ALSO matches an order-id prefix and a purchase-time line sku.
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
	/** Why the money went back — see {@link RefundPurpose}. ABSENT on a row written
	 *  before the field existed, which reads as `"refund"`. */
	purpose?: RefundPurpose;
	/** On a `cancellation` row: whether that cancellation returns the units to stock —
	 *  the FIRST attempt's choice, so a retry after a crash keeps it whatever the
	 *  checkbox then says (ADR-0026). Absent on every other row. */
	restock?: boolean;
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
	/** Who resolved this row by hand when its outcome was unknown (`unverified`
	 *  → recorded or voided, review round 2). Absent otherwise. */
	resolvedBy?: string;
}

export type RefundKind = "gateway" | "manual";

/**
 * Why a refund was made (QA T1-4):
 *  - `refund`       — an admin refund in its own right. When the FINALIZED `Σ`
 *    reaches the ceiling it drives `→ refunded`, as ADR-0008 decided.
 *  - `cancellation` — the money a cancellation returns BEFORE it flips the order
 *    `→ cancelled` (`cancelOrderWithRefund`). It consumes ceiling capacity like any
 *    other row but NEVER drives `→ refunded`: the cancellation is what closes the
 *    order, and `refunded` is terminal, so flipping first would make the cancel
 *    illegal and send the buyer a second email.
 *  - `late-payment` — the automatic refund of a payment that landed after the order
 *    had expired or been cancelled unpaid (`settleOrder`, ADR-0022). Its order is
 *    already terminal, so it never flips anything, and the buyer hears about it
 *    through its own `late-payment-refunded` notice — never an admin-refund email.
 */
export type RefundPurpose = "refund" | "cancellation" | "late-payment";

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
	/** A person confirmed an UNVERIFIED refund at the provider: who, recorded on
	 *  the row. Absent on the gateway's own finalize. */
	resolvedBy?: string;
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
	/** Stored on the row; a `cancellation` row never drives `→ refunded`, on the
	 *  one-shot record OR on a later finalize. Absent ⇒ `"refund"`. */
	purpose?: RefundPurpose;
	/** On a `cancellation` row: whether that cancellation returns the units to stock —
	 *  the FIRST attempt's choice, so a retry after a crash keeps it whatever the
	 *  checkbox then says (ADR-0026). Absent on every other row. */
	restock?: boolean;
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

/** What {@link OrderStore.expireWithOrder} answers for a WON expiry. */
export interface ExpiredOrder {
	/** The order as the flip left it: `state` is `expired`. */
	readonly order: Order;
	/** True when the store already released every hold the order adopted. */
	readonly holdsReleased: boolean;
}

/** {@link OrderStore.listExpirable}'s options. */
export interface OrderExpiryListOptions extends ExpiryListOptions {
	/** Leave out orders whose payment intent is due and not yet withdrawn. */
	readonly excludeIntentDue?: boolean;
}
