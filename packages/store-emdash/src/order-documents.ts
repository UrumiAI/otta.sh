/**
 * The order document model: **one aggregate document per order**, carrying the
 * header, the frozen line snapshot, the totals, the ship-to, the audit events,
 * the email outbox, the payments and refunds ledgers and the cross-aggregate
 * hold intents — plus one claim collection the idempotency key forces.
 *
 * **Why one document.** Every order invariant spans facts that must agree: the
 * state against the audit event that records the flip, the flip against the
 * outbox row the buyer's email drains from, a refund against the ceiling the
 * payments imply, the totals row against the order it belongs to. There is no
 * transaction here, so each of those becomes a single `compareAndSet` on
 * `orders/{orderId}` — ADR-0019 §1's rule applied to the order aggregate.
 *
 * Six SQL features disappear into the shape rather than being reproduced
 * (ADR-0019 §7.9, §7.10, §7.13):
 *
 * - **`orders.idempotency_key` UNIQUE** becomes {@link OrderKeyDoc} —
 *   `order_keys/{idempotencyKey}`, claimed create-if-absent BEFORE the order
 *   document and carrying the whole prepared document, so any replayer can finish
 *   the create deterministically (and mints no second set of line ids).
 * - **`order_items` as a child table** becomes {@link OrderDoc.items}, typed
 *   `readonly` and written ONLY by the creating write. Snapshot immutability stops
 *   being a discipline ("no code path updates a snapshot") and becomes
 *   structural: every later write is `{ ...doc, … }`, which carries the same
 *   array by reference and cannot rewrite an element.
 * - **`order_totals.order_id` as PRIMARY KEY** becomes {@link OrderDoc.totals}
 *   being a field. One totals row per order is tautological.
 * - **`order_events` with no conflict clause** becomes the append-only
 *   {@link OrderDoc.events}, appended in the SAME compare-and-set as the flip it
 *   records — so "flipped but no event" is unreachable, as it already was.
 * - **`order_emails_outbox (order_id, to_state)` UNIQUE** becomes the first-wins
 *   {@link OrderDoc.emailOutbox}: an entry is appended iff no entry with that
 *   `toState` exists yet. The once-only is per `(orderId, toState)`, NOT per
 *   event — a second flip into the same state (never legal today) would append no
 *   second entry.
 * - **`orders.hold_expires_at <= now` as a scan target** becomes the declared,
 *   denormalized {@link OrderDoc.holdExpiresAt} index, which is the only way
 *   `listExpirable` can find work.
 *
 * **The cross-aggregate edges are intents, not atoms.** Adopting and committing a
 * checkout's holds writes N per-SKU inventory documents, which no primitive can
 * bracket with the order write. So the order document records the INTENT before
 * any per-SKU write ({@link HoldIntentDoc}), each per-SKU write is idempotent by
 * reservation id, and a replayer (or the sweeper) completes a partial set from the
 * recorded intent. See `EmdashOrderStore`'s class docblock for the three
 * brackets.
 *
 * **Order notes do NOT live in this document.** ADR-0019 §4 listed per-order notes
 * among the four ledgers that "collapse inside their aggregate", and that one does
 * not hold: a note is operator-supplied free text with no natural bound, appended
 * for as long as an order is discussed, so embedding it would make the size of the
 * hot money-path document a function of how much support wrote about it. INC-B8's
 * `EmdashOrderNotesStore` therefore gets a CHILD collection,
 * `order_notes/{orderId}:{noteId}` indexed on `orderId` — its port only ever reads
 * notes by order and appends one at a time, so nothing it does needs them in the
 * aggregate. One of the two corrections to ADR-0019 §4 recorded in this file (the
 * other is {@link PAYMENT_REFS_COLLECTION}).
 *
 * **Every declared field is now written.** `searchKey` and `emailDueAt` were the last
 * two declared-but-unwritten fields, and INC-B4 (lists, search, the customer view, the
 * outbox lease) is what writes them.
 *
 * Declaring them early was worth doing and did NOT buy what an earlier draft of this
 * docblock claimed. It bought one thing: the descriptor's index list and this file's
 * stopped needing an edit per increment. It did not make the shape final — the same
 * increment had to ADD a field (`buyerRefLower`, once a contract case pinned the edge
 * ADR-0019 R3 left conditional) and two derived collections
 * ({@link ORDER_SKU_INDEX_COLLECTION} for the search's line-sku arm,
 * {@link OUTBOX_KEYS_COLLECTION} for the outbox locator). Neither collection holds truth
 * the order document does not, and nothing is deployed, so "reshaping a collection that
 * holds live orders" was never the constraint it was described as; the real constraint is
 * that a declared index is a READ CONTRACT and an undeclared field throws.
 */
import type {
	Cents,
	Currency,
	FulfillmentKind,
	IdempotencyKey,
	OrderAddress,
	OrderCancellation,
	OrderEventKind,
	OrderFulfillment,
	OrderState,
	PaymentMethod,
	ProductId,
	ReconciliationResolution,
	RefundKind,
	RefundStatus,
	ReservationId,
	Sku,
} from "@otta-sh/domain";

/** Collection name: the per-order aggregate. Id is the order id. */
export const ORDERS_COLLECTION = "orders";
/** Collection name: order idempotency key → its claim, then its terminal record. */
export const ORDER_KEYS_COLLECTION = "order_keys";
/**
 * Collection name: payment provider reference → the order that recorded it.
 *
 * **A correction to ADR-0019 §4's table, to be recorded when that ADR is next
 * amended.** The table maps `payments.provider_ref` UNIQUE onto "the provider
 * reference keys the entry inside `payments[]`", which is a per-ORDER dedupe — and
 * the constraint it replaces is GLOBAL. A gateway redelivery that arrives against
 * the wrong order id (a mis-routed webhook, a replayed event after an order was
 * re-minted) would otherwise be recorded twice, once per order, and the refund
 * ceiling reads `Σ captured`. One claim document per reference restores the global
 * once-only, with the document id doing the work no unique index may be trusted for.
 */
export const PAYMENT_REFS_COLLECTION = "payment_refs";

/**
 * Collection name: refund idempotency key → the order that holds the refund.
 *
 * ADR-0019 §3's refunds row names it for one reason, and it is a shape fact rather
 * than a convenience: the settle half of the reserve-before-issue protocol
 * (`finalizeRefund`, `voidRefund`, `markRefundUnverified`,
 * `getRefundByIdempotencyKey`) carries ONLY the key. An embedded `refunds[]` array
 * cannot be found by a key without scanning every order document, so the key needs
 * its own document to say which order to open. It doubles as the once-only claim
 * that replaces `refunds.idempotency_key` UNIQUE (§4), and — like `order_keys` — it
 * carries the whole prepared entry while `claimed`, so a crash between the claim and
 * the order's compare-and-set is COMPLETED with the same refund id rather than
 * re-minted.
 */
export const REFUND_KEYS_COLLECTION = "refund_keys";

/**
 * Collection name: the derived by-sku index over the orders' FROZEN lines — one
 * document per `(foldedSku, orderId)` pair, id `${foldedSku}:${orderId}`.
 *
 * ADR-0019 §6.2. The orders-list search has a line-sku arm the port spells as a
 * correlated `EXISTS`, and neither an `EXISTS` nor a reach inside an array field is
 * something `WhereClause` can express — so the arm is denormalized into documents the
 * `sku` index can answer with an equality. Two properties make it safe to write
 * OUTSIDE the order's own compare-and-set: it is DERIVED (nothing here is truth that
 * the order document does not already hold), and its document id is the pair, so
 * writing it twice — a multi-line order carrying the same sku twice, a replay, a heal —
 * is the same single row. That is also what makes the list's "one row per order"
 * structural rather than a de-duplication step: a sku matches an order once.
 */
export const ORDER_SKU_INDEX_COLLECTION = "order_sku_index";

/**
 * Collection name: the outbox-entry locator — `outbox_keys/{entryId} → { orderId }`.
 *
 * The dispatcher settles a row by ENTRY id alone (`markEmailSent(id, …)`,
 * `rescheduleEmail(id, …)`), and an entry embedded in an order document cannot be
 * found by one. The transitions increment walked the `emailDueAt` index to find it and
 * recorded the debt; this is the locator that pays it, the same device `payment_refs` and `refund_keys`
 * are. It is a SECOND document, so it is bracketed rather than atomic: written right
 * after the flip that enqueued the entry, and healed on read — a settle that finds no
 * locator falls back to the bounded index walk ONCE and writes the locator it found.
 */
export const OUTBOX_KEYS_COLLECTION = "outbox_keys";

/**
 * One collection as the plugin descriptor declares it, widened past
 * `CollectionIndexDeclaration` in exactly one direction: an index entry may be a
 * COMPOSITE (`["state", "createdAt"]`), which ADR-0019 §4 declares for `orders`
 * and the inventory/cart collections never needed. The host takes
 * `Array<string | string[]>` and folds a composite into the queryable-field
 * allow-list field by field, so declaring one is a superset of declaring its
 * members — the read contract is unchanged and the descriptor keeps the compound
 * the admin list will page on.
 */
export interface OrderCollectionIndexDeclaration {
	readonly indexes?: readonly (string | readonly string[])[];
	readonly uniqueIndexes?: readonly (string | readonly string[])[];
}

/**
 * The six collections `EmdashOrderStore` reads and writes, with the indexes each
 * must declare. A declared index is a **read contract**, not a performance knob:
 * a `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`, so
 * this list and the descriptor's must not drift.
 *
 * Every index ADR-0019 §4 names for `orders` is declared here, plus three it does
 * not: `holdExpiresAt` and `holdsPendingAt`, which the port and the sweeper force
 * (`listExpirable` scans `state = 'pending' AND hold_expires_at <= :now`, and neither
 * half may be an undeclared field), and `buyerRefLower`, which ADR-0019 R3 left
 * CONDITIONAL on a contract case pinning the edge its `customerKey` collapse narrows —
 * a case does pin it, so the field is declared and the customer union is resolved as two
 * merged arms. `buyerRefLower` also carries the search's buyer-reference arm.
 *
 * `order_keys`, `payment_refs` and `refund_keys` declare none — every access to
 * each is by document id, which is the whole point of keying a claim by the key
 * (or, for `payment_refs`, by the provider reference) it must make once-only.
 */
export const ORDER_COLLECTIONS: Readonly<Record<string, OrderCollectionIndexDeclaration>> = {
	[ORDERS_COLLECTION]: {
		indexes: [
			"state",
			"createdAt",
			"customerKey",
			"buyerRefLower",
			"searchKey",
			"emailDueAt",
			"holdExpiresAt",
			"holdsPendingAt",
			["state", "createdAt"],
		],
	},
	[ORDER_KEYS_COLLECTION]: {},
	[PAYMENT_REFS_COLLECTION]: {},
	// Every access is by document id — the whole point of keying a claim by the key.
	[REFUND_KEYS_COLLECTION]: {},
	// The search's line-sku arm: an exact-lower equality on `sku`, ORDERED by the
	// order's frozen `createdAt` so the arm takes its own keyset top `limit + 1`
	// instead of resolving every pointer a sku ever collected. Declared as a
	// COMPOSITE because that is what the arm's predicate is; the host folds it into
	// the queryable-field allow-list field by field, so both halves are usable
	// separately too. `orderId` is NOT declared — it is read off the document.
	[ORDER_SKU_INDEX_COLLECTION]: { indexes: [["sku", "createdAt"]] },
	// Every access is by entry id; that is the whole point of a locator.
	[OUTBOX_KEYS_COLLECTION]: {},
};

/**
 * One frozen order line. `readonly` in every field, and held in a `readonly`
 * array: the price and the title are snapshots taken at creation, and the type is
 * what makes "no code path ever updates a snapshot" checkable by the compiler
 * rather than by review.
 */
export interface OrderItemDoc {
	readonly id: string;
	readonly productId: ProductId;
	readonly sku: Sku;
	/** The product title at purchase time (ADR-0013's cache, frozen here). */
	readonly title: string;
	/** Integer minor units, branded. Never a float, never re-derived. */
	readonly unitPrice: Cents;
	readonly currency: Currency;
	readonly quantity: number;
	readonly fulfillmentKind: FulfillmentKind;
	/** The adopted reservation for a physical line; null for a digital one. */
	readonly reservationId: ReservationId | null;
}

/** The 1:1 totals, as a field. One totals row per order is tautological here. */
export interface OrderTotalsDoc {
	readonly currency: Currency;
	readonly subtotal: Cents;
	readonly discount: Cents;
	readonly shipping: Cents;
	readonly tax: Cents;
	readonly total: Cents;
	readonly appliedCouponCode: string | null;
	readonly shippingMethodSnapshot: unknown | null;
	readonly taxBreakdown: unknown | null;
}

/**
 * One append-only state-change audit record, appended in the SAME
 * compare-and-set as the flip it records.
 */
export interface OrderEventDoc {
	id: string;
	/** ISO-8601 UTC — the store clock at the instant of the flip. */
	at: string;
	kind: OrderEventKind;
	fromState: OrderState | null;
	toState: OrderState | null;
	/** The recorder/canceller when the domain models one, else null. */
	actor: string | null;
}

/** An outbox entry's lifecycle, mirroring the `order_emails_outbox.status` set. */
export type OutboxStatus = "pending" | "sending" | "sent" | "failed";

/**
 * One email-outbox entry — **at most one per `(orderId, toState)`**, which is
 * where the SQL's `UNIQUE(order_id, to_state)` went.
 *
 * The lease fields are declared now and driven by INC-B4: R2's denormalized
 * {@link OrderDoc.emailDueAt} is what an `updateIf`-guarded claim can filter on,
 * because the SQL predicate's OR and negation are inexpressible here.
 */
export interface OutboxEntryDoc {
	id: string;
	toState: OrderState;
	status: OutboxStatus;
	attempts: number;
	leaseUntil: string | null;
	sentAt: string | null;
	createdAt: string;
	/**
	 * When the entry becomes sendable again after a failed attempt was rescheduled.
	 * ABSENT on a freshly enqueued entry, which is due at `createdAt` — the field
	 * exists only because a retry moves the due time forward, and R2's `emailDueAt`
	 * is `max(dueAt, leaseUntil)`.
	 */
	dueAt?: string;
}

/**
 * One settled payment, keyed within the array by `providerRef` — which is where
 * `payments.provider_ref` UNIQUE went: a redelivered gateway event finds its own
 * reference present and appends nothing.
 */
export interface PaymentEntryDoc {
	gateway: PaymentMethod;
	providerRef: string;
	amount: Cents;
	currency: Currency;
	status: string;
	recordedAt: string;
}

/**
 * One refund ledger row, appended by the SAME compare-and-set that arbitrated the
 * ceiling against this document's own `payments[]` and `refunds[]`.
 *
 * `status` is ADR-0019 R6's four-state capacity lifecycle: every non-`voided` row
 * HOLDS ceiling capacity (`recorded` money that moved, `reserved` a slot held before
 * issuance, `unverified` an ambiguous gateway outcome held in the safe direction),
 * and `voided` RELEASES it while staying as an audit record of the attempt. Only
 * `recorded` rows count toward the finalized sum that drives the `→ refunded` flip.
 */
export interface RefundEntryDoc {
	id: string;
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

/**
 * One cross-aggregate hold intent, recorded on the order document BEFORE any
 * per-SKU inventory write and marked complete after the last one.
 *
 * This is ADR-0019 §1's second primitive — intent claim, then deterministic
 * completion — for the one edge the order aggregate genuinely has: adopting,
 * committing and releasing N reservations whose documents are N other
 * aggregates. Each per-SKU write is idempotent by reservation id, so a partial
 * set is always safe to re-run, and an intent with `completedAt: null` is the
 * marker that tells a replayer (or the sweeper) there is work owed.
 *
 * It is deliberately NOT a state enum: an absent `completedAt` IS the unfinished
 * marker, the same shape `inventory_movements` uses for the same reason.
 */
export interface HoldIntentDoc {
	/** The reservation ids this intent covers. Empty for a digital-only order. */
	readonly reservationIds: readonly string[];
	/** The deadline an adoption re-points each hold to; absent for the others. */
	readonly holdExpiresAt?: string;
	/** When the intent was recorded (the store clock). */
	readonly recordedAt: string;
	/** Set once every per-id write has landed. `null` while work is owed. */
	readonly completedAt: string | null;
}

/** `orders/{orderId}` — the aggregate. */
export interface OrderDoc {
	orderId: string;
	cartId: string | null;
	currency: Currency;
	state: OrderState;
	idempotencyKey: IdempotencyKey;
	/** The checkout hold deadline. DECLARED INDEX: `listExpirable` scans it. */
	holdExpiresAt: string;
	paymentMethod: PaymentMethod | null;
	buyerRef: string;
	customerId: string | null;
	/**
	 * DECLARED INDEX, and ADR-0019 R3's ruling: `customerId ?? lower(buyerRef)`.
	 *
	 * The customer filter is a UNION, not a collapsible OR — an order is born
	 * `customerId: null` and back-linked only at the customer's NEXT login — so the
	 * union moves into the VALUE SET. R3 collapsed it to one clause on this one field;
	 * the pinned edge below ({@link OrderDoc.buyerRefLower}) forced the OR back out, so the
	 * filter is now this field's arm ANDed-or-merged with that one. `linkGuestOrders`
	 * rewrites this field, or the filter would stop finding an order the moment it was
	 * linked.
	 */
	customerKey: string;
	/**
	 * DECLARED INDEX, and the ONE field ADR-0019 R3 left conditional: `lower(buyerRef)`.
	 *
	 * R3 ruled that the customer filter's union collapses into `customerKey`, and handed
	 * the lists increment one question — whether any contract case pins the edge that
	 * collapse narrows, an order owned by a customer id whose buyer reference ALSO folds
	 * to the queried reference. **A case does pin it**: `listOrders customer key with a
	 * single half set filters on that half alone` asserts that a `buyerRef`-only key
	 * returns the LINKED order too, whose `customerKey` holds its customer id and can
	 * never match the reference. So R3's conditional applies and this field is kept.
	 *
	 * With it the customer key becomes the SQL's own OR again —
	 * `customerKey = :customerId OR buyerRefLower = :folded` — resolved as two indexed
	 * arms the adapter merges under the port's value-position cursor, with the count
	 * taken by inclusion–exclusion so it still shares the list's predicate exactly. It
	 * ALSO carries the search's buyer-reference arm, as a `startsWith`.
	 *
	 * Frozen at creation, like `buyerRef` itself: `linkGuestOrders` rewrites
	 * `customerKey` and never this.
	 *
	 * **Nullable for the same reason `searchKey` is, and with the same non-remedy.** A
	 * document written before INC-B4 carries neither field, and a `startsWith` or an
	 * equality over SQL NULL is NULL — so such an order is simply unreachable by the
	 * arms that read them (it is still listed, filtered, counted and paged like any
	 * other). **No backfill is owed, because nothing is deployed**: this collection has
	 * never held a production order, and the `null` exists so the adapter's own
	 * normalization has a defined value rather than to describe data anyone must migrate.
	 * Neither field is ever null on a document this build writes.
	 */
	buyerRefLower: string | null;
	/**
	 * DECLARED INDEX. The denormalized prefix-searchable key (ADR-0019 §6.1), and it
	 * is exactly {@link searchKeyFor}: the FOLDED ORDER ID and nothing else.
	 *
	 * `WhereClause` is AND-only and offers one `startsWith` per field — no substring, no
	 * OR — so ONE indexed field can serve exactly ONE anchored prefix arm. The port's
	 * `search` is three ORed arms, and each has its own home:
	 *
	 * - the order-id PREFIX arm is THIS field, reproduced exactly (anchored, folded on
	 *   both sides, a whole id is its own prefix, and `""` matches every row because
	 *   every string starts with it);
	 * - the `buyer_ref` arm is a `startsWith` on {@link OrderDoc.buyerRefLower} — served,
	 *   but ANCHORED where the port documents an unanchored SUBSTRING. That prefix is the
	 *   whole of the user-visible narrowing ADR-0019 §6.1 ratified: an operator can type
	 *   an address or its local part, and loses only the MID-STRING reach. Re-spelling the
	 *   port's arm as a prefix is a `[Domain]` change with its own PR;
	 * - the exact line-sku arm is {@link ORDER_SKU_INDEX_COLLECTION}.
	 *
	 * The adapter queries the two indexed arms separately and merges them, which is exact
	 * because the port's cursor is a self-describing value position — see
	 * `EmdashOrderStore.listOrders`.
	 *
	 * Still nullable, for the reason {@link OrderDoc.buyerRefLower} spells out: documents
	 * written before this increment carry neither field, and a `startsWith` over SQL NULL
	 * is NULL, so such an order is unreachable by these arms (never unlisted). No backfill
	 * is owed — nothing is deployed — and it is never null on a document this build writes.
	 */
	searchKey: string | null;
	/**
	 * DECLARED INDEX, ADR-0019 R2: `null` when the message is sent or failed,
	 * otherwise `max(dueAt, leaseUntil)`. Re-derived by {@link computeEmailDueAt} on every
	 * write that touches `emailOutbox`, never incremented, so the indexed scalar cannot
	 * drift from the entries it summarizes.
	 */
	emailDueAt: string | null;
	/**
	 * THE FROZEN SNAPSHOT. `readonly` in both directions (array and element), and
	 * written only by the creating write — every later write is a `{ ...doc }`
	 * spread that carries this same array by reference.
	 */
	readonly items: readonly OrderItemDoc[];
	totals: OrderTotalsDoc;
	/** The ship-to snapshot (ADR-0009), or null when none was captured. */
	shippingAddress: OrderAddress | null;
	/** Append-only state-change audit; appended inside the guarded flip. */
	events: OrderEventDoc[];
	/** At most one entry per `toState`; first-wins. */
	emailOutbox: OutboxEntryDoc[];
	/** Settled payments, keyed by `providerRef`. */
	payments: PaymentEntryDoc[];
	/** The refunds ledger; the ceiling is arbitrated against it in place. */
	refunds: RefundEntryDoc[];
	/**
	 * DECLARED INDEX. The earliest `recordedAt` over the hold intents that still owe
	 * per-id work, or `null` when none do — the only way the sweeper can FIND an
	 * order whose cross-aggregate bracket tore.
	 *
	 * It is the same device `carts.holdExpiresAt` is, for the same reason: the filter
	 * algebra has no OR and cannot reach inside a field, so "any of these three
	 * intents is outstanding" has to be one indexed scalar. It is recomputed from the
	 * document's own three intents on every write that touches one
	 * ({@link computeHoldsPendingAt}), never incrementally, so it cannot drift from
	 * what it summarizes.
	 */
	holdsPendingAt: string | null;
	/** The adoption intent recorded at creation; see {@link HoldIntentDoc}. */
	holdsAdopted: HoldIntentDoc | null;
	/** The commit intent recorded by the `→ paid` flip. */
	holdsCommitted: HoldIntentDoc | null;
	/** The release intent recorded by the `→ expired` flip. */
	holdsReleased: HoldIntentDoc | null;
	/** The settle anomaly marker; deliberately last-writer-wins (ADR-0019 §7.13). */
	reconciliationFlag: string | null;
	/** The admin disposition, written by the compare-and-clear `resolveReconciliation`. */
	reconciliationResolution: ReconciliationResolution | null;
	/** The shipping fulfillment; it rides the guarded `→ shipped` flip. */
	fulfillment: OrderFulfillment | null;
	/** The structured cancellation; it rides the guarded `→ cancelled` flip. */
	cancellation: OrderCancellation | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * `order_keys/{idempotencyKey}` — the durable once-only guard for
 * `createFromCart`, in two states.
 *
 * `claimed` is written create-if-absent BEFORE the order document and carries the
 * WHOLE prepared document, so a replayer completes the create byte for byte —
 * same order id, same line ids, same timestamps — rather than minting a second
 * set. `terminal` drops the payload once the order document exists, because from
 * then on the order IS the record and a duplicated copy of it would be drift
 * surface that also doubles the claim's row size.
 *
 * Ordering, and it is the same rule inventory's replay ordering is: the order
 * document is created BEFORE the claim is promoted. Promote first and a crash
 * leaves a terminal key pointing at an order that does not exist, which reads as
 * "already minted" and loses the checkout.
 */
export type OrderKeyDoc =
	| {
			state: "claimed";
			/** The order id this key minted. A completion reuses it, never re-mints. */
			orderId: string;
			/** The fully prepared aggregate, so any replayer can finish the create. */
			doc: OrderDoc;
			claimedAt: string;
	  }
	| {
			state: "terminal";
			orderId: string;
			recordedAt: string;
	  };

/** The folded buyer reference — R3's identity fold, exact but case-insensitive. */
export function foldBuyerRef(buyerRef: string): string {
	return buyerRef.toLowerCase();
}

/**
 * R3's denormalized customer key: the linked customer id when there is one, else the
 * folded buyer reference — which is why the FALLBACK value lives here rather than both
 * halves. The list's `customerId` arm is an equality on this field; its buyer-reference
 * arm reads {@link OrderDoc.buyerRefLower}, because an order already linked to a customer
 * keeps its id here and would otherwise drop out of its own buyer reference's results.
 */
export function customerKeyFor(customerId: string | null, buyerRef: string): string {
	return customerId ?? foldBuyerRef(buyerRef);
}

/**
 * The folded, prefix-searchable key — the order id, lowercased.
 *
 * Ids this domain mints are lowercase hex already, so the fold is a no-op on the
 * STORED side; it is here to forgive the TYPED side (a uuid pasted back from a client
 * that upper-cased it), exactly as the SQL's `lower(id) LIKE lower(:s || '%')` was.
 */
export function searchKeyFor(orderId: string): string {
	return orderId.toLowerCase();
}

/** The sku fold both sides of the sku arm share — `lower()` on the stored value. */
export function foldSku(sku: string): string {
	return sku.toLowerCase();
}

/** `order_sku_index/{foldedSku}:{orderId}` — the pair IS the document id. */
export function orderSkuIndexId(foldedSku: string, orderId: string): string {
	return `${foldedSku}:${orderId}`;
}

/**
 * The DISTINCT folded skus of an order's frozen lines — what the by-sku index holds
 * for it.
 *
 * Distinct because the index's document id is the pair: an order with two lines of
 * one sku owes ONE index document, which is the structural half of the port's "an
 * order carrying two matching lines appears once".
 */
export function orderSkuKeys(doc: Pick<OrderDoc, "items">): string[] {
	return [...new Set((doc.items ?? []).map((item) => foldSku(item.sku)))];
}

/** `order_sku_index/{foldedSku}:{orderId}` — a derived pointer, never truth. */
export interface OrderSkuIndexDoc {
	/** DECLARED INDEX: the folded sku the search arm matches with an equality. */
	sku: string;
	orderId: string;
	/**
	 * DECLARED INDEX: the order's own `createdAt`, copied here.
	 *
	 * It is what makes the sku arm a KEYSET arm rather than a full resolve: the list
	 * orders these pointers `createdAt DESC` and reads only the `limit + 1` orders it can
	 * actually return, instead of opening every order that ever bought the sku. Frozen,
	 * like the `createdAt` it copies — an order's creation instant never moves, so this
	 * denormalization has no update path and cannot drift.
	 *
	 * A pointer written before this field existed is invisible to the arm (a `createdAt`
	 * range over a missing key extracts NULL and matches nothing). Nothing is deployed,
	 * so no backfill is owed; a replay of the order's idempotency key rewrites it.
	 */
	createdAt: string;
}

/** `outbox_keys/{entryId}` — which order document holds that outbox entry. */
export interface OutboxKeyDoc {
	orderId: string;
}

/**
 * Normalize a stored order so every embedded ledger is present. A document
 * written by an earlier build (or hand-seeded in a test) may lack one, and
 * `noUncheckedIndexedAccess` protects the element type, not the container.
 *
 * `items` is normalized to `[]` when absent but is never COPIED when present:
 * copying it would put a fresh array on the next write, and the whole point of
 * the `readonly` typing is that the creating write's array is the one that stays.
 */
export function normalizeOrderDoc(doc: OrderDoc): OrderDoc {
	return {
		...doc,
		// The two denormalized read keys INC-B4 added. A pre-INC-B4 document carries
		// neither; normalizing them to `null` is what keeps the field DEFINED (and so
		// round-trippable through a compare-and-set) rather than silently absent.
		searchKey: doc.searchKey ?? null,
		buyerRefLower: doc.buyerRefLower ?? null,
		items: doc.items ?? [],
		events: doc.events ?? [],
		emailOutbox: doc.emailOutbox ?? [],
		payments: doc.payments ?? [],
		refunds: doc.refunds ?? [],
	};
}

/** The outbox entry for `toState`, if one was ever enqueued. */
export function findOutboxEntry(doc: OrderDoc, toState: OrderState): OutboxEntryDoc | undefined {
	return doc.emailOutbox.find((entry) => entry.toState === toState);
}

/**
 * Every physical line's reservation id — what a hold intent covers.
 *
 * The predicate is `settleOrder`'s own, character for character
 * (`fulfillmentKind === "physical" && reservationId !== null`), NOT just "has a
 * reservation id". They agree on every order this domain can mint — a digital line
 * reserves nothing — but the intent and the batch it brackets must not be derived
 * from two different predicates: a digital line that somehow carried a reservation
 * id would appear in the intent, never in `commitMany`'s argument, and the sweeper
 * would then try forever to commit a hold nothing ever adopted.
 *
 * **This is used by the COMMIT and RELEASE intents, and deliberately not by the
 * ADOPT one.** `createFromCart` records the adoption intent over every line that
 * carries a reservation id, unfiltered — which is `createOrderFromCart`'s own
 * predicate for the `adoptMany` call it makes right after. So each intent matches the
 * use-case whose batch it brackets, and the single order where the two predicates
 * disagree is a DIGITAL line carrying a reservation id: its hold really was adopted
 * (the create use-case passed the id), so the adopt intent must name it or a partial
 * adoption could never be completed, while settle would never commit it and the
 * commit intent must not claim otherwise.
 */
export function physicalReservationIds(doc: OrderDoc): string[] {
	return doc.items
		.filter((item) => item.fulfillmentKind === "physical" && item.reservationId !== null)
		.map((item) => item.reservationId)
		.filter((id): id is ReservationId => id !== null);
}

/** `payment_refs/{providerRef}` — the global once-only claim for a provider ref. */
export interface PaymentRefDoc {
	orderId: string;
	recordedAt: string;
}

/**
 * A freshly recorded intent — **born COMPLETE when it covers nothing**.
 *
 * An intent over zero reservation ids owes zero per-id writes, so there is nothing a
 * replayer or the sweeper could ever do with it. Leaving it outstanding would put
 * every digital-only order, and every lines-free one, permanently into
 * {@link OrderDoc.holdsPendingAt} — an index whose whole purpose is "this order has
 * cross-aggregate work owed" would then be answering "this order exists". The
 * completion methods stay correct either way (they are idempotent and skip an empty
 * list), which is exactly why the emptiness is decided here, once, rather than at
 * three call sites.
 */
export function newHoldIntent(
	reservationIds: readonly string[],
	recordedAt: string,
	holdExpiresAt?: string,
): HoldIntentDoc {
	return {
		reservationIds: [...reservationIds],
		...(holdExpiresAt === undefined ? {} : { holdExpiresAt }),
		recordedAt,
		completedAt: reservationIds.length === 0 ? recordedAt : null,
	};
}

/** True when an intent exists and still owes per-id work. */
export function isOutstanding(intent: HoldIntentDoc | null): boolean {
	return intent !== null && intent.completedAt === null;
}

/**
 * Recompute {@link OrderDoc.holdsPendingAt} from the document's own intents: the
 * earliest `recordedAt` among those still outstanding, else `null`.
 *
 * Derived, never incremented, so the indexed scalar the sweeper scans cannot
 * disagree with the three fields it summarizes.
 */
export function computeHoldsPendingAt(
	doc: Pick<OrderDoc, "holdsAdopted" | "holdsCommitted" | "holdsReleased">,
): string | null {
	let earliest: string | null = null;
	for (const intent of [doc.holdsAdopted, doc.holdsCommitted, doc.holdsReleased]) {
		if (!isOutstanding(intent) || intent === null) continue;
		if (earliest === null || intent.recordedAt < earliest) earliest = intent.recordedAt;
	}
	return earliest;
}

/**
 * `refund_keys/{refundIdempotencyKey}` — the durable once-only guard for a refund,
 * and the ONLY handle the settle half of the protocol has.
 *
 * Two states, for the same reason `order_keys` has two. `claimed` is written
 * create-if-absent BEFORE the order's compare-and-set and carries the WHOLE prepared
 * entry, so a crash in between is completed with the SAME refund id, amount and
 * `createdAt` rather than re-minted — and `driveFlip` is carried with it, because
 * `recordRefund` (the one-shot manual path) and `reserveRefund` (the held slot)
 * share the claim shape and differ only in whether a full refund may flip the order.
 * `terminal` drops the payload once the entry is in the order document, which from
 * then on IS the record.
 *
 * **A `claimed` key whose entry never landed does NOT block a retry**, and that is
 * deliberate: the SQL inserted no row when arbitration rejected a refund, so the key
 * stayed usable. Here the claim survives a rejected arbitration, and every path that
 * meets a `claimed` key re-runs the arbitration from the carried intent — which
 * makes the ceiling-rejection case and the crash case one code path instead of two.
 */
export type RefundKeyDoc =
	| {
			state: "claimed";
			/** The order whose document holds (or will hold) the entry. */
			orderId: string;
			/** The fully prepared ledger row, so any replayer completes it verbatim. */
			refund: RefundEntryDoc;
			/** Whether a ceiling-reaching FINALIZED sum may drive `→ refunded`. */
			driveFlip: boolean;
			claimedAt: string;
	  }
	| {
			state: "terminal";
			orderId: string;
			refundId: string;
			recordedAt: string;
	  };

/** The refund an idempotency key minted inside this order, if any. */
export function findRefund(doc: OrderDoc, key: string): RefundEntryDoc | undefined {
	return doc.refunds.find((refund) => refund.idempotencyKey === key);
}

/**
 * The ACTIVE sum the ceiling arbitrates against: every non-`voided` row (R6).
 *
 * Integer minor units throughout — the accumulator is the raw integer the branded
 * `Cents` values already are, re-branded once at the boundary by the caller, exactly
 * as the domain's own `sumRefunds`/`sumCapturedPayments` do it.
 */
export function activeRefundTotal(refunds: readonly RefundEntryDoc[]): number {
	let total = 0;
	for (const refund of refunds) if (refund.status !== "voided") total += refund.amount;
	return total;
}

/** The FINALIZED sum — `recorded` rows only. What drives the `→ refunded` flip. */
export function finalizedRefundTotal(refunds: readonly RefundEntryDoc[]): number {
	let total = 0;
	for (const refund of refunds) if (refund.status === "recorded") total += refund.amount;
	return total;
}

/** Σ of the SUCCEEDED payments — "how much money we actually hold". */
export function capturedPaymentTotal(payments: readonly PaymentEntryDoc[]): number {
	let total = 0;
	for (const payment of payments) if (payment.status === "succeeded") total += payment.amount;
	return total;
}

/**
 * When one outbox entry is next claimable, or `null` when it never will be again.
 *
 * `pending` is due at its `dueAt` (a reschedule moved it) or at `createdAt`;
 * `sending` is due when its lease lapses, which is what makes a crashed
 * dispatcher's row claimable again; `sent` and `failed` are terminal and drop out
 * of the index entirely.
 */
export function outboxDueAt(entry: OutboxEntryDoc): string | null {
	const due = entry.dueAt ?? entry.createdAt;
	if (entry.status === "pending") return due;
	if (entry.status === "sending") {
		const lease = entry.leaseUntil;
		return lease === null ? due : lease > due ? lease : due;
	}
	return null;
}

/**
 * Recompute {@link OrderDoc.emailDueAt} — R2's single denormalized field — as the
 * earliest due time over the order's non-terminal outbox entries, else `null`.
 *
 * The SQL claimed on `sent_at IS NULL AND status != 'failed' AND (lease_until IS
 * NULL OR lease_until <= :now)`, whose OR and negation the filter algebra cannot
 * express. One indexed scalar can, and like `holdsPendingAt` it is DERIVED on every
 * write that touches the array rather than incremented, so it cannot drift from the
 * entries it summarizes.
 */
export function computeEmailDueAt(doc: Pick<OrderDoc, "emailOutbox">): string | null {
	let earliest: string | null = null;
	for (const entry of doc.emailOutbox ?? []) {
		const due = outboxDueAt(entry);
		if (due === null) continue;
		if (earliest === null || due < earliest) earliest = due;
	}
	return earliest;
}
