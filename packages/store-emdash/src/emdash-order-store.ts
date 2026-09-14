/**
 * `OrderStore` over EmDash's plugin-storage primitives, on the one-document order
 * aggregate: `orders/{orderId}` carries the header, the frozen line snapshot, the
 * totals, the ship-to, the audit events, the email outbox and the embedded
 * ledgers, so every order-only invariant is one document's compare-and-set.
 *
 * ## Creation is a claim, then a create-if-absent
 *
 * `orders.idempotency_key` UNIQUE was the SQL's once-only guard, and a returning-
 * nothing insert made the whole call a replay. Here the guard is
 * `order_keys/{idempotencyKey}` (ADR-0019 §7.9), and the order of the two writes
 * is load-bearing:
 *
 * 1. **Claim** `order_keys/{key}` create-if-absent, carrying the WHOLE prepared
 *    order document — order id, minted line ids, timestamps, everything — so any
 *    replayer finishes the create byte for byte instead of minting a second set of
 *    ids. A refused claim means the key has already minted an order: the call is a
 *    replay and returns `{ created: false, order }`.
 * 2. **Create** `orders/{orderId}` create-if-absent from the claim's payload. One
 *    write carries header + `readonly items` + totals + address together, which is
 *    where the SQL's multi-row `order_items` insert, its 1:1 `order_totals` row and
 *    its conditional `order_shipping_address` row all went.
 * 3. **Promote** the claim to `terminal`, dropping the payload. NEVER before
 *    step 2: a terminal key pointing at a non-existent order reads as "already
 *    minted" and would lose the checkout.
 *
 * The window is "claim written, order document not yet created", and it is
 * HEALED rather than tolerated — `createFromCart` and `getByIdempotencyKey` both
 * complete a `claimed` key they find, which is why the payload is carried at all.
 *
 * **Snapshot immutability is structural, not a discipline.** {@link OrderDoc.items}
 * is `readonly OrderItemDoc[]` with every element field `readonly`, and it is
 * written ONLY by step 2. Every later write in this file is `{ ...doc, … }`, which
 * carries that very array by reference — so there is no code path, and cannot be
 * one without a compile error, that rewrites a price or a title after purchase.
 *
 * ## The transition is ONE write
 *
 * ADR-0019 §7.10: the guarded flip, the appended audit event and the first-wins
 * outbox entry are a SINGLE `compareAndSet` guarded on the document revision AND
 * on `state === fromState` (plus, for expiry, on the deadline). So:
 *
 * - "flipped but no event" is unreachable, as it already was under the SQL's
 *   transaction;
 * - the outbox once-only is per `(orderId, toState)` — an entry is appended iff
 *   none with that target state exists, which is where
 *   `UNIQUE(order_id, to_state)` went. It is NOT per event;
 * - a lost race is a clean no-op: the guard fails, nothing is written, and no
 *   event is recorded (audit never double-counts a replay).
 *
 * ## The three hold brackets — the one real cross-aggregate edge
 *
 * Adopting, committing and releasing an order's reservations writes N inventory
 * documents, and no primitive can bracket them with the order write. So each is
 * ADR-0019 §1's other shape — **intent, per-id idempotent write, completion** —
 * and the intent is recorded IN the order document, in the same write as the state
 * change that implies it:
 *
 * | Bracket | Intent recorded by | Per-id write | Completed by |
 * |---|---|---|---|
 * | adopt | `createFromCart` (before the use-case's `adoptMany`) | `adoptMany`, idempotent per reservation id | {@link EmdashOrderStore.completeHoldAdoption} |
 * | commit | the `→ paid` flip (before settle's `commitMany`) | singular `commit` per id | {@link EmdashOrderStore.completeHoldCommit} |
 * | release | the `→ expired` AND `→ cancelled` flips | `releaseAdopted` per id, order-scoped | {@link EmdashOrderStore.completeHoldRelease} |
 *
 * The cancellation leg is the one the SQL adapter had no analogue for (its cancel was
 * a pure envelope write): a cancelled order no longer claims its holds, so it records
 * the same intent expiry does. `releaseAdopted`'s ADOPTED-ONLY guard is what makes that
 * safe on a PAID order cancelled after settle — a `committed` hold is not adopted, so
 * the release is an unconditional no-op and spent units are never returned.
 *
 * An intent whose `completedAt` is `null` is the marker that work is owed; each
 * completion is idempotent and callable by ANY replayer, which is what makes a
 * partial batch safe. The commit completion drives the **singular** `commit` per
 * id rather than re-running `commitMany`, because ADR-0019 §2 is explicit that
 * `commitMany` SKIPS an already-`committed` id: a SKU caught between its terminal
 * record and its prune is finished by the singular call, never by the batch.
 *
 * ## The refund ceiling is one write on this document
 *
 * `min(Σ captured, frozen total)` was computed under a row lock on `orders` so two
 * concurrent refunds could not each read the same headroom. Here `payments[]` and
 * `refunds[]` are fields of the very document the refund is appended to, so the
 * ceiling, the ACTIVE-capacity arbitration and the row all live inside ONE
 * compare-and-set — the revision doing what the lock did. The four-state capacity
 * lifecycle (ADR-0019 R6) is read and written in that same step: `reserved` and
 * `unverified` HOLD capacity, `voided` releases it, and `finalizeRefund` is
 * status-guarded and NEVER re-arbitrates, because its reservation already holds what
 * it is about to finalize. `refund_keys/{key}` exists because the settle half of the
 * protocol carries only the key — and, like `order_keys`, it carries the whole
 * prepared row so a crash before the order write is completed rather than re-minted.
 *
 * Fulfillment and cancellation ride the same guarded flip as every other state
 * change (`#flip`'s `envelope`), never a parallel copy of it; cancellation also
 * records the release intent, because a cancelled order no longer claims its holds.
 *
 * ## The email-outbox lease landed here, ahead of its increment
 *
 * The fulfillment and cancellation specs both assert that exactly ONE notification
 * DRAINS, which runs `dispatchOrderEmails` — so `claimNextEmail`, `markEmailSent`
 * and `rescheduleEmail` are a dependency of this increment's own gate, the way
 * `recordPayment` was a dependency of the previous one's. They implement ADR-0019's
 * R2: the SQL's OR-and-negation claim predicate becomes the single denormalized
 * {@link OrderDoc.emailDueAt} index, and the claim re-applies that predicate to the
 * entry it picked inside one compare-and-set.
 *
 * ## The whole port is implemented
 *
 * Every `OrderStore` method has a real implementation: the lists, the search, the
 * counts, the customer view, guest linking and the outbox settle path were the last
 * four, and there is no `NotImplementedInIncrementError` left to throw anywhere in this
 * package. What the ADMIN LIST cannot do is narrower and is a matter of SEMANTICS rather
 * than of a missing method: the port's `search` documents an unanchored `buyer_ref`
 * SUBSTRING, and the host's filter algebra has no substring operator — so that arm is
 * served as a PREFIX (ADR-0019 §6.1's ratified narrowing). See
 * {@link EmdashOrderStore.listOrders} and the package README.
 */
import {
	cents,
	computeRefundCeiling,
	emailTemplateForState,
	isLegalOrderTransition,
	type CancelOrderInput,
	type CancelOrderStoreResult,
	type CapturedPayment,
	type Cents,
	type Clock,
	type CreateOrderInput,
	type CreateOrderResult,
	type Currency,
	type CustomerId,
	type FinalizeRefundInput,
	type FinalizeRefundStoreResult,
	type IdempotencyKey,
	type IdGen,
	type InventoryStore,
	type Order,
	type OrderEvent,
	type OrderId,
	type OrderLine,
	type OrderCustomerKey,
	type OrderListCursor,
	type OrderListFilter,
	type OrderListPage,
	type OrderListResult,
	type OrderSummary,
	type OrderState,
	type OrderStore,
	type OrderTransitionInput,
	type OrderTransitionResult,
	type OutboxEmail,
	ReservationCommitLostError,
	type RecordFulfillmentInput,
	type RecordFulfillmentStoreResult,
	ReservationNotFoundError,
	type RecordPaymentInput,
	type RefundStatus,
	type RecordRefundInput,
	type RecordRefundStoreResult,
	type RefundRecord,
	type ResolveReconciliationInput,
	type ResolveReconciliationStoreResult,
} from "@otta-sh/domain";
import {
	CAS_RETRY,
	type CasRetryOptions,
	type CasStep,
	casDone,
	withCasRetry,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import {
	DerivedPointerConflictError,
	OrderIdCollisionError,
	OrderNotFoundError,
	OutboxEntryUnlocatableError,
	PaymentRefConflictError,
	ScanPageLimitError,
} from "./errors.js";
import {
	activeRefundTotal,
	capturedPaymentTotal,
	computeEmailDueAt,
	computeHoldsPendingAt,
	customerKeyFor,
	finalizedRefundTotal,
	findOutboxEntry,
	findRefund,
	foldBuyerRef,
	type HoldIntentDoc,
	isOutstanding,
	newHoldIntent,
	normalizeOrderDoc,
	ORDER_KEYS_COLLECTION,
	type OrderDoc,
	type OrderItemDoc,
	type OrderKeyDoc,
	ORDER_SKU_INDEX_COLLECTION,
	type OrderSkuIndexDoc,
	orderSkuIndexId,
	orderSkuKeys,
	ORDERS_COLLECTION,
	OUTBOX_KEYS_COLLECTION,
	type OutboxKeyDoc,
	PAYMENT_REFS_COLLECTION,
	type PaymentRefDoc,
	type OutboxEntryDoc,
	outboxDueAt,
	physicalReservationIds,
	REFUND_KEYS_COLLECTION,
	type RefundEntryDoc,
	type RefundKeyDoc,
	searchKeyFor,
} from "./order-documents.js";
import type { ReportingRollupWriter } from "./reporting-documents.js";
import type {
	OrderBy,
	StorageAccess,
	StorageCollection,
	WhereClause,
	WhereValue,
} from "./storage-access.js";

export interface EmdashOrderStoreOptions {
	/** The collections the plugin descriptor declared; see `ORDER_COLLECTIONS`. */
	storage: StorageAccess;
	/**
	 * The inventory authority. The order store performs NO inventory write of its
	 * own: every hold-bracket completion goes through this port, whose per-id
	 * operations are idempotent, which is what makes a partial set replayable.
	 */
	inventory: InventoryStore;
	/** Order-line and event ids come from here, never `crypto.randomUUID()`. */
	idGen: IdGen;
	/** Timestamps come from here, never `Date.now()`. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers must). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/**
	 * Override how many pages `listExpirable` will walk before it refuses to loop
	 * further (default {@link MAX_EXPIRY_PAGES}). Lowering it is how a suite reaches
	 * the ceiling without seeding a hundred thousand orders — the behaviour AT the
	 * ceiling is a typed `ScanPageLimitError`, never a silently short list.
	 */
	maxExpiryPages?: number;
	/**
	 * Override how many pages the EMAIL scans will walk before they refuse to loop
	 * further (default {@link MAX_OUTBOX_PAGES}).
	 *
	 * Separate from {@link maxExpiryPages} on purpose: the two scans are bounded by
	 * different things — the expiry scan by how many orders are past their hold
	 * deadline, the outbox scans by how many messages are in flight — so a suite that
	 * squeezes one must not silently squeeze the other, and an operator raising one
	 * budget is not agreeing to raise the other.
	 */
	maxOutboxPages?: number;
	/**
	 * Override how many pages the LIST scans will walk before they refuse to loop
	 * further (default {@link MAX_LIST_PAGES}).
	 *
	 * Its own budget for the reason the other two have their own: the list scans are
	 * bounded by how many orders match a filter, which has nothing to do with the
	 * hold-expiry backlog or the number of messages in flight.
	 */
	maxListPages?: number;
	/**
	 * Where this store reports its state transitions and finalized refunds, so the
	 * reporting rollups can be kept without any read-time aggregate.
	 *
	 * **Additive in the strongest sense.** It defaults to a no-op, it is called only
	 * AFTER the order write it describes is durable, it is never consulted for a
	 * decision, and a writer that throws changes nothing about this store's answer —
	 * reporting is derived data and a transition is not, so a reporting outage must
	 * never be able to refuse a payment or lose a refund. The counters it feeds are
	 * restored to exactness by a recompute, which is what makes swallowing the failure
	 * the honest choice rather than a silent one.
	 */
	reporting?: ReportingRollupWriter;
}

/**
 * The rollup writer a store that was given none reports to: nothing at all.
 *
 * A default rather than an optional call site, so every hook below is one
 * unconditional line and no path can forget the `?.`.
 */
const NO_REPORTING: ReportingRollupWriter = {
	async recordOrderEvent() {
		// Reporting is opt-in; a store wired without it keeps no rollups.
	},
};

/** How many pages `listExpirable` will walk before it refuses to loop further. */
const MAX_EXPIRY_PAGES = 1000;

/** How many pages the outbox claim / settle scans will walk before refusing. */
const MAX_OUTBOX_PAGES = 1000;

/** The host clamps `limit` at 100; asking for it is asking for the widest page. */
const EXPIRY_PAGE_SIZE = 100;

/** The same, for the outbox scans — declared separately for the reason the budget is. */
const OUTBOX_PAGE_SIZE = 100;

/** How many pages a list / count / link scan will walk before it refuses to loop. */
const MAX_LIST_PAGES = 1000;

/**
 * The page the list scans ask the host for. 100 is the host's own ceiling, so this is
 * "as wide as it will give".
 *
 * The host clamps `limit` at 100 and the PORT's `limit` is the caller's page size, so an
 * adapter that simply forwarded it would truncate a larger page silently. It does not:
 * the scan pages internally until it has `limit + 1` rows. In practice that loop is a
 * correctness guarantee rather than a hot path, because **the 100-row cap on what a
 * caller may ask for lives at the ROUTE** (`@otta-sh/service`'s admin-orders query
 * schema), not here — so a page bigger than one host page is a programmatic caller, not
 * the console.
 */
const LIST_PAGE_SIZE = 100;

/** The outcome of a hold-bracket completion: what landed, and what was lost. */
export interface HoldCompletionResult {
	/** True when this call had outstanding work and finished it. */
	completed: boolean;
	/** Reservation ids whose hold could not be adopted/committed (loud anomalies). */
	lost: string[];
}

/** What one guarded flip reports back: whether it won, and the resulting document. */
interface FlipOutcome {
	won: boolean;
	doc: OrderDoc | null;
}

export class EmdashOrderStore implements OrderStore {
	readonly #orders: StorageCollection<OrderDoc>;
	readonly #keys: StorageCollection<OrderKeyDoc>;
	readonly #paymentRefs: StorageCollection<PaymentRefDoc>;
	readonly #refundKeys: StorageCollection<RefundKeyDoc>;
	readonly #skuIndex: StorageCollection<OrderSkuIndexDoc>;
	readonly #outboxKeys: StorageCollection<OutboxKeyDoc>;
	readonly #inventory: InventoryStore;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxExpiryPages: number;
	readonly #maxOutboxPages: number;
	readonly #maxListPages: number;
	readonly #reporting: ReportingRollupWriter;

	constructor(options: EmdashOrderStoreOptions) {
		this.#orders = collectionOf<OrderDoc>(options.storage, ORDERS_COLLECTION);
		this.#keys = collectionOf<OrderKeyDoc>(options.storage, ORDER_KEYS_COLLECTION);
		this.#paymentRefs = collectionOf<PaymentRefDoc>(options.storage, PAYMENT_REFS_COLLECTION);
		this.#refundKeys = collectionOf<RefundKeyDoc>(options.storage, REFUND_KEYS_COLLECTION);
		this.#skuIndex = collectionOf<OrderSkuIndexDoc>(options.storage, ORDER_SKU_INDEX_COLLECTION);
		this.#outboxKeys = collectionOf<OutboxKeyDoc>(options.storage, OUTBOX_KEYS_COLLECTION);
		this.#inventory = options.inventory;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#maxExpiryPages = options.maxExpiryPages ?? MAX_EXPIRY_PAGES;
		this.#maxOutboxPages = options.maxOutboxPages ?? MAX_OUTBOX_PAGES;
		this.#maxListPages = options.maxListPages ?? MAX_LIST_PAGES;
		this.#reporting = options.reporting ?? NO_REPORTING;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
	}

	// -- creation --------------------------------------------------------------

	async createFromCart(input: CreateOrderInput): Promise<CreateOrderResult> {
		const now = this.#clock.now().toISOString();
		const prepared = this.#prepare(input, now);
		// The intent claim comes FIRST and carries the whole prepared document, so a
		// crash anywhere after it leaves a replayer everything it needs — including
		// the line ids, which a second `newId()` sweep would otherwise change.
		const claimed = await this.#keys.compareAndSet(input.idempotencyKey, null, {
			state: "claimed",
			orderId: prepared.orderId,
			doc: prepared,
			claimedAt: now,
		});
		if (!claimed.applied) {
			// The key already minted an order: this is a REPLAY, whatever order id the
			// caller brought. Resolving it completes a claim somebody else abandoned,
			// so a replay is also the heal path.
			const order = await this.#resolveKey(input.idempotencyKey);
			if (order === null) {
				throw new Error(
					`order key ${input.idempotencyKey} exists but its order could not be resolved`,
				);
			}
			return { created: false, order };
		}
		const order = await this.#finishClaim(input.idempotencyKey, prepared);
		return { created: true, order };
	}

	async getById(orderId: OrderId): Promise<Order | null> {
		const doc = await this.#orders.get(orderId);
		return doc === null ? null : toOrder(normalizeOrderDoc(doc));
	}

	async getByIdempotencyKey(key: IdempotencyKey): Promise<Order | null> {
		return this.#resolveKey(key);
	}

	// -- the guarded transitions ----------------------------------------------

	async markPaid(orderId: OrderId): Promise<boolean> {
		// pending → paid enqueues the confirmation email AND records the commit
		// intent, in the same write as the flip: settle's `commitMany` runs after
		// this call returns, so the intent has to be durable before it does.
		const { won } = await this.#flip({
			orderId,
			fromState: "pending",
			toState: "paid",
			enqueueEmail: true,
			intent: "commit",
		});
		return won;
	}

	async markFailed(orderId: OrderId): Promise<boolean> {
		// pending → failed has no template, so no outbox entry is enqueued.
		const { won } = await this.#flip({
			orderId,
			fromState: "pending",
			toState: "failed",
			enqueueEmail: false,
		});
		return won;
	}

	async expire(orderId: OrderId, now: string): Promise<boolean> {
		const { won } = await this.#flip({
			orderId,
			fromState: "pending",
			toState: "expired",
			enqueueEmail: true,
			holdExpiresBefore: now,
			intent: "release",
		});
		// The flip recorded the release intent; completing it is the second,
		// idempotent step, and any replayer can run it (`expireOrders` also releases
		// the same holds through the same order-scoped, no-op-on-miss port call).
		//
		// A failure HERE must not become the caller's, and must not be reported as a
		// lost flip: the flip is already durable, the port documents the return as
		// "did this call win the guarded expiry", and a throw would make a sweep that
		// really did expire the order look like one that did not — so the next run
		// would re-read it as pending, find it expired, and report 0 while the release
		// stayed owed anyway. The intent is left outstanding (and `holdsPendingAt`
		// keeps it findable), which is precisely the state the sweeper exists for.
		if (won) {
			try {
				await this.completeHoldRelease(orderId);
			} catch (err) {
				// Not swallowed silently: recorded on the order's own reconciliation
				// envelope, the one loud channel this port has that needs no extra
				// collaborator. Best-effort — if even that write fails, the outstanding
				// intent is still the durable record of the owed work.
				await this.#noteReleaseFailure(orderId, err);
			}
		}
		return won;
	}

	async listExpirable(now: string): Promise<OrderId[]> {
		// Both halves of the SQL predicate are declared index fields, so this is the
		// predicate itself rather than a candidate filter — but `limit` is clamped by
		// the host, so it pages, and each fetched document is re-checked because a
		// page read is not a lock.
		const ids: OrderId[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxExpiryPages; page++) {
			const result = await this.#orders.query({
				where: { state: "pending", holdExpiresAt: { lte: now } },
				limit: EXPIRY_PAGE_SIZE,
				cursor,
			});
			for (const { data } of result.items) {
				if (data.state === "pending" && data.holdExpiresAt <= now) {
					ids.push(data.orderId as OrderId);
				}
			}
			if (!result.hasMore || result.cursor === undefined) return ids;
			cursor = result.cursor;
		}
		// The loop ran out of pages with more to read. Returning what was collected
		// would be silent truncation, and for THIS scan that means an order past its
		// deadline is never swept — stock held out of sale forever, reported as
		// "nothing to expire". Loud and typed instead; the caller may re-run once the
		// sweep has drained work.
		throw new ScanPageLimitError("listExpirable", this.#maxExpiryPages, ids.length);
	}

	async transition(input: OrderTransitionInput): Promise<OrderTransitionResult> {
		const { won } = await this.#flip({
			orderId: input.orderId,
			fromState: input.fromState,
			toState: input.toState,
			enqueueEmail: input.enqueueEmail,
			// `markPaid`/`expire` route through this same primitive, so a bare
			// transition into those states records the same intent they would.
			...(input.toState === "paid"
				? { intent: "commit" as const }
				: input.toState === "expired"
					? { intent: "release" as const }
					: {}),
		});
		if (won && input.toState === "expired") {
			// Same reasoning as `expire`: the flip is durable, so a failing completion
			// leaves the intent outstanding for the sweeper rather than turning a won
			// transition into a thrown call.
			try {
				await this.completeHoldRelease(input.orderId);
			} catch (err) {
				await this.#noteReleaseFailure(input.orderId, err);
			}
		}
		return { transitioned: won, order: await this.getById(input.orderId) };
	}

	// -- reads -----------------------------------------------------------------

	async listEventsForOrder(orderId: OrderId): Promise<OrderEvent[]> {
		const doc = await this.#orders.get(orderId);
		if (doc === null) return [];
		// `at` is fixed-width ISO-8601 text, so lexical order IS chronological; `id`
		// is the stable tie-break when two events share a timestamp under a fixed
		// clock — the same `(at, id)` order the SQL's index emitted. The events array
		// is already in append order; sorting makes the contract's order explicit
		// rather than a property of how it was built.
		return [...doc.events]
			.toSorted((a, b) => (a.at === b.at ? compare(a.id, b.id) : compare(a.at, b.at)))
			.map((event) => ({
				id: event.id,
				orderId: orderId,
				at: event.at,
				kind: event.kind,
				fromState: event.fromState,
				toState: event.toState,
				actor: event.actor,
			}));
	}

	// -- the payments ledger ---------------------------------------------------

	async recordPayment(input: RecordPaymentInput): Promise<void> {
		// `payments.provider_ref` UNIQUE was GLOBAL, so the dedupe is a claim document
		// keyed by the reference — not merely "is this ref already in THIS order's
		// array". A redelivery routed at the wrong order would otherwise be recorded
		// twice, once per order, and `Σ captured` is the refund ceiling.
		const claimed = await this.#paymentRefs.compareAndSet(input.providerRef, null, {
			orderId: input.orderId,
			recordedAt: this.#clock.now().toISOString(),
		});
		if (!claimed.applied) {
			const held = await this.#paymentRefs.get(input.providerRef);
			// Another order holds the reference: refusing is the point — see the error.
			if (held !== null && held.orderId !== input.orderId) {
				throw new PaymentRefConflictError(input.providerRef, input.orderId, held.orderId);
			}
			// This order's own reference, claimed by an earlier (possibly crashed)
			// attempt. Fall through: the append below is itself keyed by the reference,
			// so a redelivery that already landed writes nothing and one that crashed
			// between the claim and the append is completed here.
		}
		await this.#casOrder<void>("recordPayment", async () => {
			const current = await this.#orders.getVersioned(input.orderId);
			// No order document, no foreign key to catch it: the alternative to
			// throwing is money recorded nowhere with the call reporting success.
			if (current === null) throw new OrderNotFoundError(input.orderId, "recordPayment");
			const doc = normalizeOrderDoc(current.value);
			if (doc.payments.some((payment) => payment.providerRef === input.providerRef)) {
				return casDone(undefined);
			}
			const now = this.#clock.now().toISOString();
			const written = await this.#orders.compareAndSet(input.orderId, current.revision, {
				...doc,
				payments: [
					...doc.payments,
					{
						gateway: input.gateway,
						providerRef: input.providerRef,
						amount: input.amount,
						currency: input.currency,
						status: input.status,
						recordedAt: now,
					},
				],
				updatedAt: now,
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	async flagReconciliation(orderId: OrderId, detail: string): Promise<void> {
		// Deliberately last-writer-wins on the FIELD (ADR-0019 §7.13): an anomaly
		// must always be recordable, so there is no expected-value guard here. The
		// document write is still a compare-and-set, because every write here is.
		await this.#casOrder<void>("flagReconciliation", async () => {
			const current = await this.#orders.getVersioned(orderId);
			if (current === null) return casDone(undefined);
			const doc = normalizeOrderDoc(current.value);
			const now = this.#clock.now().toISOString();
			const written = await this.#orders.compareAndSet(orderId, current.revision, {
				...doc,
				reconciliationFlag: detail,
				updatedAt: now,
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	// -- the hold brackets' completions ---------------------------------------

	/**
	 * Complete the ADOPTION intent `createFromCart` recorded: re-run `adoptMany`
	 * for the recorded reservation ids (idempotent per id, so a partial set is safe
	 * to re-run) and mark the intent complete.
	 *
	 * **It completes only while the order is still `pending`.** An adoption is what
	 * holds stock for an UNPAID order, and the state the order has moved to already
	 * decided what became of those holds: a `paid` order's were committed, an
	 * `expired` or `failed` one's were released, and re-adopting either is either a
	 * no-op the inventory store reports as `lost` (a terminal reservation is not
	 * adoptable) or — worse, if a later reserve reused the id — an adoption of
	 * somebody else's units. On any other state the intent is therefore CLOSED
	 * stamp-only, with no `adoptMany` call and nothing reported lost: the work it
	 * named is no longer owed, and a `lost` list here would be read as a stock
	 * anomaly that has not happened.
	 *
	 * Callable by any replayer, and a no-op once the intent is complete or was
	 * never recorded. `lost` carries every id whose hold could not be adopted —
	 * each a `RESERVATION_LOST` for the caller, never swallowed here.
	 */
	async completeHoldAdoption(orderId: OrderId): Promise<HoldCompletionResult> {
		const doc = await this.#orders.get(orderId);
		const intent = doc === null ? null : (doc.holdsAdopted ?? null);
		if (doc === null || !isOutstanding(intent) || intent === null) {
			return { completed: false, lost: [] };
		}
		let lost: string[] = [];
		if (doc.state === "pending" && intent.reservationIds.length > 0) {
			const result = await this.#inventory.adoptMany({
				reservationIds: [...intent.reservationIds],
				orderId,
				holdExpiresAt: intent.holdExpiresAt ?? doc.holdExpiresAt,
				now: this.#clock.now().toISOString(),
			});
			lost = result.lost;
		}
		await this.#stampIntent(orderId, "holdsAdopted");
		return { completed: true, lost };
	}

	/**
	 * Complete the COMMIT intent the `→ paid` flip recorded, driving the
	 * **singular** `commit` per reservation id.
	 *
	 * It is deliberately not a re-run of `commitMany`: ADR-0019 §2 records that
	 * `commitMany` skips only an already-`committed` id — leaving its hold live in
	 * the aggregate — so a SKU caught between its terminal record and its prune is
	 * finished by the singular call and by nothing else.
	 *
	 * **It completes only while the order is `paid`.** The commit intent means "this
	 * order's money arrived, so its holds are spent"; on any other state the flip
	 * that recorded it has been superseded and committing would spend units the
	 * order no longer claims. Stamp-only there, exactly as the adoption completion is.
	 *
	 * Two per-id conditions are FOLDED into `lost` rather than thrown, because both
	 * mean the same thing to the caller — this order's hold is gone and the order is
	 * paid, which is the `COMMIT_LOST` anomaly: `ReservationCommitLostError` (the hold
	 * was released or failed) and `ReservationNotFoundError` (the reservation has no
	 * index entry at all — an id the order snapshot names and inventory has never
	 * heard of). Throwing the latter would wedge the sweeper on that one order
	 * forever, re-reading the same unknown id on every pass, and it would abandon the
	 * ids after it in the list. Any other error is the caller's.
	 */
	async completeHoldCommit(orderId: OrderId): Promise<HoldCompletionResult> {
		const doc = await this.#orders.get(orderId);
		const intent = doc === null ? null : (doc.holdsCommitted ?? null);
		if (doc === null || !isOutstanding(intent) || intent === null) {
			return { completed: false, lost: [] };
		}
		const lost: string[] = [];
		if (doc.state === "paid") {
			for (const reservationId of intent.reservationIds) {
				try {
					await this.#inventory.commit(reservationId);
				} catch (err) {
					if (
						!(err instanceof ReservationCommitLostError) &&
						!(err instanceof ReservationNotFoundError)
					) {
						throw err;
					}
					lost.push(reservationId);
				}
			}
		}
		await this.#stampIntent(orderId, "holdsCommitted");
		return { completed: true, lost };
	}

	/**
	 * Complete the RELEASE intent the `→ expired` flip recorded: `releaseAdopted`
	 * per id, which is order-scoped and an unconditional no-op on any miss, then
	 * mark the intent complete.
	 *
	 * **It completes only while the order is `expired` or `cancelled`.**
	 * `releaseAdopted` is already order-scoped and cannot touch another order's hold,
	 * so the guard is not what makes it safe — it is what keeps a stale intent from
	 * returning units under an order that has since been paid (a settle racing a
	 * sweep), which `releaseAdopted` would happily do while the hold is still adopted
	 * by this very order. Both states are terminal ways for an order to stop claiming
	 * its holds, and `cancelOrder` records the same intent the expiry flip does.
	 * Stamp-only on any other state.
	 */
	async completeHoldRelease(orderId: OrderId): Promise<HoldCompletionResult> {
		const doc = await this.#orders.get(orderId);
		const intent = doc === null ? null : (doc.holdsReleased ?? null);
		if (doc === null || !isOutstanding(intent) || intent === null) {
			return { completed: false, lost: [] };
		}
		if (doc.state === "expired" || doc.state === "cancelled") {
			for (const reservationId of intent.reservationIds) {
				await this.#inventory.releaseAdopted(reservationId, orderId);
			}
		}
		await this.#stampIntent(orderId, "holdsReleased");
		return { completed: true, lost: [] };
	}

	// -- the refunds ledger, and its capacity ---------------------------------

	async getCapturedPayments(orderId: OrderId): Promise<CapturedPayment[]> {
		const doc = await this.#orders.get(orderId);
		if (doc === null) return [];
		return normalizeOrderDoc(doc).payments.map((payment) => ({
			gateway: payment.gateway,
			providerRef: payment.providerRef,
			amount: payment.amount,
			currency: payment.currency,
			status: payment.status,
		}));
	}

	async listRefunds(orderId: OrderId): Promise<RefundRecord[]> {
		const doc = await this.#orders.get(orderId);
		if (doc === null) return [];
		// `(created_at ASC, id ASC)` — the SQL's own order. `createdAt` is fixed-width
		// ISO-8601 text, so lexical order IS chronological, and `id` is the stable
		// tie-break when two refunds share a timestamp under a fixed clock.
		return [...normalizeOrderDoc(doc).refunds]
			.toSorted((a, b) =>
				a.createdAt === b.createdAt ? compare(a.id, b.id) : compare(a.createdAt, b.createdAt),
			)
			.map((refund) => toRefundRecord(refund, orderId));
	}

	async getRefundByIdempotencyKey(key: IdempotencyKey): Promise<RefundRecord | null> {
		// The key alone: `refund_keys/{key}` is the only handle this signature has, and
		// it is why the collection exists (ADR-0019 §3's refunds row). A `claimed` key
		// whose entry never landed answers NULL — the truth, and what makes the
		// use-case re-reserve, which then COMPLETES the claim from its carried intent.
		const claim = await this.#refundKeys.get(key);
		if (claim === null) return null;
		const doc = await this.#orders.get(claim.orderId);
		if (doc === null) return null;
		const entry = findRefund(normalizeOrderDoc(doc), key);
		return entry === undefined ? null : toRefundRecord(entry, claim.orderId as OrderId);
	}

	recordRefund(input: RecordRefundInput): Promise<RecordRefundStoreResult> {
		// The MANUAL / record-only one-shot: no gateway leg exists, so reserve and
		// finalize collapse into one write — the row lands `recorded` and a ceiling-
		// reaching FINALIZED sum drives `→ refunded` in that same write.
		return this.#insertRefund(input, { status: "recorded", driveFlip: true });
	}

	reserveRefund(input: RecordRefundInput): Promise<RecordRefundStoreResult> {
		// RESERVE the slot before the provider is ever called: the same arbitration,
		// but the row lands `reserved` and NEVER drives the flip — capacity held is
		// not money moved. A caller rejected here never reaches the gateway, which is
		// what makes "issued but unrecorded" unreachable.
		return this.#insertRefund(input, { status: "reserved", driveFlip: false });
	}

	async finalizeRefund(input: FinalizeRefundInput): Promise<FinalizeRefundStoreResult> {
		const claim = await this.#refundKeys.get(input.idempotencyKey);
		// No claim at all: there is no order to open, so this is the loud residual the
		// use-case surfaces — never a silent drop of a provider reference.
		if (claim === null) return MISSING_FINALIZE;
		const orderId = claim.orderId;
		const result = await this.#casOrder<Omit<FinalizeRefundStoreResult, "order">>(
			"finalizeRefund",
			async () => {
				const current = await this.#orders.getVersioned(orderId);
				if (current === null) return casDone(MISSING_FINALIZE_INNER);
				const doc = normalizeOrderDoc(current.value);
				const entry = findRefund(doc, input.idempotencyKey);
				if (entry === undefined) return casDone(MISSING_FINALIZE_INNER);
				// ALREADY finalized: the BENIGN duplicate iff the reference is the same one
				// (a concurrent same-key caller finalized first, and the provider's native
				// idempotency guarantees one refund). A DIFFERENT reference is the loud
				// residual, and the recorded row is left exactly as it is.
				if (entry.status === "recorded") {
					return casDone(
						entry.refundRef === input.refundRef
							? {
									found: true,
									alreadyFinalized: true,
									refund: toRefundRecord(entry, orderId as OrderId),
									fullyRefunded: doc.state === "refunded",
								}
							: MISSING_FINALIZE_INNER,
					);
				}
				// STATUS-GUARDED, exactly as the SQL's `WHERE status IN
				// ('reserved','unverified')` was: a stray finalize can never resurrect a
				// `voided` row's released capacity.
				if (entry.status !== "reserved" && entry.status !== "unverified") {
					return casDone(MISSING_FINALIZE_INNER);
				}

				const now = this.#clock.now().toISOString();
				const finalized: RefundEntryDoc = {
					...entry,
					status: "recorded",
					refundRef: input.refundRef,
				};
				const refunds = doc.refunds.map((row) =>
					row.idempotencyKey === input.idempotencyKey ? finalized : row,
				);
				let next: OrderDoc = { ...doc, refunds, updatedAt: now };
				// NO re-arbitration. The reservation already holds this capacity, so a
				// finalize arriving after a concurrent void of some OTHER row still
				// finalizes — the SQL's semantics, and the port's.
				const ceiling = computeRefundCeiling(
					cents(capturedPaymentTotal(doc.payments)),
					doc.totals.total,
				);
				let fullyRefunded = false;
				if (
					finalizedRefundTotal(refunds) === ceiling &&
					isLegalOrderTransition(doc.state, "refunded")
				) {
					next = this.#flipped(next, {
						fromState: doc.state,
						toState: "refunded",
						enqueueEmail: emailTemplateForState("refunded") !== null,
						actor: entry.refundedBy,
						now,
					});
					fullyRefunded = true;
				}
				const written = await this.#orders.compareAndSet(orderId, current.revision, next);
				if (!written.applied) return CAS_RETRY;
				// The full-refund path composes `#flipped` rather than `#flip`, so it brackets
				// its own locator — same ordering, same reason.
				if (fullyRefunded) await this.#recordOutboxLocator(next, "refunded");
				await this.#reportRefund(next, finalized.currency, finalized.id, finalized.amount);
				if (fullyRefunded) await this.#reportTransition(next, doc.state, "refunded");
				return casDone({
					found: true,
					alreadyFinalized: false,
					refund: toRefundRecord(finalized, orderId as OrderId),
					fullyRefunded,
				});
			},
		);
		const order = result.refund === null ? null : await this.getById(orderId as OrderId);
		return { ...result, order };
	}

	voidRefund(idempotencyKey: IdempotencyKey): Promise<boolean> {
		// Guarded `reserved → voided`: the gateway leg definitively did not issue, so
		// the row RELEASES its ceiling capacity (it leaves the active sum) and stays
		// as an audit record of the attempt.
		return this.#flipRefundStatus(idempotencyKey, "voided");
	}

	markRefundUnverified(idempotencyKey: IdempotencyKey): Promise<boolean> {
		// Guarded `reserved → unverified`: an ambiguous outcome KEEPS holding capacity
		// — the safe direction — until a human re-checks the provider.
		return this.#flipRefundStatus(idempotencyKey, "unverified");
	}

	// -- the reconciliation envelope ------------------------------------------

	async resolveReconciliation(
		input: ResolveReconciliationInput,
	): Promise<ResolveReconciliationStoreResult> {
		// A compare-and-CLEAR: the guard is EQUALITY against the flag the admin
		// reviewed, not "is flagged". That is what defends a stale review — a NEW
		// anomaly re-flagged since the page loaded no longer matches, so the write is
		// a clean no-op rather than a blind clear. The document revision adds a second
		// guard, which is what makes exactly one concurrent caller win.
		// `input.idempotencyKey` is deliberately unused: dedupe is structural here.
		const resolved = await this.#casOrder<boolean>("resolveReconciliation", async () => {
			const current = await this.#orders.getVersioned(input.orderId);
			if (current === null) return casDone(false);
			const doc = normalizeOrderDoc(current.value);
			if (doc.reconciliationFlag !== input.expectedFlag) return casDone(false);
			const now = this.#clock.now().toISOString();
			const written = await this.#orders.compareAndSet(input.orderId, current.revision, {
				...doc,
				reconciliationFlag: null,
				reconciliationResolution: {
					outcome: input.outcome,
					reason: input.reason,
					resolvedBy: input.resolvedBy,
					resolvedAt: now,
				},
				// NEVER `state`, `items` or `totals` — only the mutable envelope.
				updatedAt: now,
			});
			return written.applied ? casDone(true) : CAS_RETRY;
		});
		return { resolved, order: await this.getById(input.orderId) };
	}

	// -- fulfillment and cancellation ------------------------------------------

	async recordFulfillment(input: RecordFulfillmentInput): Promise<RecordFulfillmentStoreResult> {
		// Recording fulfillment IS shipping: the envelope rides the SAME guarded flip
		// as every other state change (`#flip`'s `envelope`), so no reachable state is
		// "shipped with no fulfillment recorded" or "fulfilled but not shipped", and
		// the shipped email that drains carries the tracking. The `fromState` guard is
		// the use-case's — validated against the state machine — so an order a
		// concurrent cancel already moved is a 0-row miss, never shipped behind it.
		// `input.idempotencyKey` is unused: dedupe is the guard plus the outbox's
		// first-wins entry.
		const { won } = await this.#flip({
			orderId: input.orderId,
			fromState: input.fromState,
			toState: "shipped",
			enqueueEmail: input.enqueueEmail,
			// The recorder is the actor this domain knows for a fulfillment flip.
			actor: input.recordedBy,
			envelope: (now) => ({
				fulfillment: {
					carrier: input.carrier,
					trackingNumber: input.trackingNumber,
					trackingUrl: input.trackingUrl,
					// A blank ship time is the store clock — the SAME instant the record
					// was stamped, which is what the port documents.
					shippedAt: input.shippedAt ?? now,
					recordedBy: input.recordedBy,
					recordedAt: now,
				},
			}),
		});
		return { recorded: won, order: await this.getById(input.orderId) };
	}

	async cancelOrder(input: CancelOrderInput): Promise<CancelOrderStoreResult> {
		// The same guarded flip, the same envelope seam: no reachable state is
		// "cancelled with no reason recorded", and a replay/lost race records nothing
		// — which is why a second cancel never overwrites the first reason.
		//
		// It also records the RELEASE intent, because a cancelled order's holds are no
		// longer claimed by it. That is the one thing the SQL adapter had no analogue
		// for (its cancel was a pure envelope write), and it is a cross-aggregate edge
		// like expiry's: intent in the same write as the flip, `releaseAdopted` per id
		// (order-scoped, an unconditional no-op on any miss), completion after.
		const { won } = await this.#flip({
			orderId: input.orderId,
			fromState: input.fromState,
			toState: "cancelled",
			enqueueEmail: input.enqueueEmail,
			actor: input.cancelledBy,
			intent: "release",
			envelope: (now) => ({
				cancellation: {
					reason: input.reason,
					detail: input.detail,
					cancelledBy: input.cancelledBy,
					cancelledAt: now,
				},
			}),
		});
		if (won) {
			// Same reasoning as `expire`: the flip is durable, so a failing completion
			// must not turn a won cancellation into a thrown call. The intent is left
			// outstanding and `holdsPendingAt` keeps it findable for the sweeper.
			try {
				await this.completeHoldRelease(input.orderId);
			} catch (err) {
				await this.#noteReleaseFailure(input.orderId, err, "cancellation");
			}
		}
		return { cancelled: won, order: await this.getById(input.orderId) };
	}

	// -- lists, search, counts, the customer view, guest linking ---------------

	/**
	 * Every order a customer owns, `createdAt ASC, id ASC` — the SQL's own ordering.
	 *
	 * The SQL predicate is `customer_id = :customerId`, an EQUALITY and not the list's
	 * union: this read is reached from a session whose identity is already resolved, and
	 * a guest order that has not been back-linked yet is not yet this customer's. The
	 * denormalized {@link OrderDoc.customerKey} holds the linked id whenever there is
	 * one, so the equality is expressible directly — and the in-memory re-check on
	 * `customerId` is what keeps a guest order whose folded buyer reference HAPPENS to
	 * spell a customer id out of somebody else's history.
	 */
	async listForCustomer(customerId: CustomerId): Promise<Order[]> {
		const docs = await this.#scanOrders(
			"listForCustomer",
			{ customerKey: customerId },
			{ createdAt: "asc" },
			Number.POSITIVE_INFINITY,
			(doc) => doc.customerId === customerId,
		);
		return docs.map((doc) => toOrder(doc));
	}

	/**
	 * The admin Orders list: a keyset page of `OrderSummary` projections, newest first.
	 *
	 * **Four arms at most, one page, and still one row per order.** The port's predicate
	 * has TWO places that need an OR, and `WhereClause` is AND-only (ADR-0019 §6.1):
	 *
	 * | Dimension | Alternatives | Served by |
	 * |---|---|---|
	 * | `search` | folded order-id PREFIX | `startsWith` on {@link OrderDoc.searchKey} |
	 * | | folded buyer-reference PREFIX | `startsWith` on {@link OrderDoc.buyerRefLower} |
	 * | | exact folded line sku | the derived `order_sku_index` documents |
	 * | `customer` | the linked customer id | `customerKey` equality |
	 * | | the folded buyer reference | `buyerRefLower` equality |
	 *
	 * The two indexed `search` alternatives are crossed with the two indexed `customer`
	 * ones, so a fully-specified filter issues up to FOUR indexed queries plus the sku
	 * arm; the results are merged and de-duplicated by order id, because a document
	 * satisfying two arms is the same row twice — exactly the double-count the port's
	 * `EXISTS` and its "OR is not additive" both exist to prevent.
	 *
	 * The port documents the buyer-reference arm as an unanchored SUBSTRING and this
	 * serves it as a PREFIX. That is the ratified narrowing, and it is the ONLY semantic
	 * difference from the SQL; the sku arm reads the FROZEN lines and stays exact.
	 *
	 * **The merge is exact, and the cursor is why.** The port's `OrderListCursor` is a
	 * VALUE position (`{ createdAt, id }`), not an opaque token, so "strictly after this
	 * position under `createdAt DESC, id DESC`" is decidable against a row from ANY arm
	 * without re-reading the cursor row. Each arm contributes its own top `limit + 1`
	 * rows after the cursor — drained to the end of its boundary TIE GROUP, see
	 * {@link byNewestFirst} — and the top `limit + 1` of the merge is the true page.
	 */
	async listOrders(filter: OrderListFilter, page: OrderListPage): Promise<OrderListResult> {
		const cursor = page.cursor ?? null;
		const search = foldSearch(filter.search);
		// `limit + 1` is the port's own next-page probe: one row past the page decides
		// whether `nextCursor` is a position or null.
		const wanted = page.limit + 1;
		const found = new Map<string, OrderDoc>();
		const after = (candidate: OrderDoc): boolean => isAfterCursor(candidate, cursor);
		for (const where of orderListWhereArms(filter, cursor, search)) {
			const arm = await this.#scanOrders("listOrders", where, { createdAt: "desc" }, wanted, after);
			for (const doc of arm) if (!found.has(doc.orderId)) found.set(doc.orderId, doc);
		}
		for (const doc of await this.#ordersMatchingSku(search, filter, cursor, wanted)) {
			if (!found.has(doc.orderId)) found.set(doc.orderId, doc);
		}
		// Sorted in CODE-UNIT order here, which is the adapter's total order; every arm was
		// drained past its boundary tie group so this slice cannot drop a tied row that the
		// host's collation happened to order differently.
		const merged = [...found.values()].toSorted(byNewestFirst).slice(0, wanted);
		const returned = merged.length > page.limit ? merged.slice(0, page.limit) : merged;
		const last = returned.at(-1);
		const nextCursor =
			merged.length > page.limit && last !== undefined
				? { createdAt: last.createdAt, id: last.orderId as OrderId }
				: null;
		return { orders: returned.map((doc) => toSummary(doc)), nextCursor };
	}

	/**
	 * The count that captions the page — the SAME predicate, by construction.
	 *
	 * A count cannot merge rows the way the list does, so each OR dimension is counted by
	 * **inclusion–exclusion**: for a union of `k` alternatives,
	 * `|∪| = Σ over nonempty subsets S of (-1)^(|S|+1) · |∩S|`, and every intersection is
	 * one more AND clause on one more indexed field. Two dimensions multiply, so a filter
	 * carrying both a search and a two-half customer key issues 3 × 3 = 9 indexed
	 * `count()` calls. That is the price of an order matching several arms being counted
	 * exactly ONCE, which is what the contract pins.
	 *
	 * The sku arm is added afterwards as a **set difference** — only the sku-matched
	 * orders no indexed arm already counted — decided in memory from each document's own
	 * `searchKey`/`buyerRefLower`. Unlike the list's, this arm is NOT keyset-bounded: a
	 * count is a cardinality over the whole matching set, so it resolves every pointer the
	 * sku collected, `O(matches)`. See {@link #ordersMatchingSku} for the ceiling.
	 */
	async countOrders(filter: OrderListFilter): Promise<number> {
		const search = foldSearch(filter.search);
		const base = orderListBaseWhere(filter, null, search);
		let total = 0;
		for (const term of inclusionExclusionTerms(base, orderListDimensions(filter, search))) {
			total += term.sign * (await this.#orders.count(term.where));
		}
		if (search === undefined) return total;
		for (const doc of await this.#ordersMatchingSku(
			search,
			filter,
			null,
			Number.POSITIVE_INFINITY,
		)) {
			if (!matchesSearchArms(doc, search)) total++;
		}
		return total;
	}

	/**
	 * Attach a just-authenticated customer's guest orders to their account.
	 *
	 * The SQL is `WHERE lower(buyer_ref) = :folded AND customer_id IS NULL`, and the
	 * document model adds one thing (ADR-0019 R3): the write must REWRITE
	 * {@link OrderDoc.customerKey} as well, or the customer filter would stop finding
	 * the order the instant it was linked. An unlinked order's key IS the folded buyer
	 * reference, so the index finds exactly the rows the SQL's `WHERE` did.
	 *
	 * Idempotent in the only way that matters here: the second login finds nothing,
	 * because every order it would have matched now keys on the customer id. The guard
	 * is re-applied INSIDE each compare-and-set, so a peer login racing the same inbox
	 * links each order once and the loser counts it as not its own.
	 */
	async linkGuestOrders(customerId: CustomerId, buyerRef: string): Promise<number> {
		const folded = foldBuyerRef(buyerRef);
		const claimable = (doc: OrderDoc): boolean =>
			doc.customerId === null && foldBuyerRef(doc.buyerRef) === folded;
		// Collected in full FIRST, then written: paging an index while rewriting the very
		// field it is ordered under would shift the window under the cursor.
		const docs = await this.#scanOrders(
			"linkGuestOrders",
			{ customerKey: folded },
			{ createdAt: "asc" },
			Number.POSITIVE_INFINITY,
			claimable,
		);
		let linked = 0;
		for (const found of docs) {
			const won = await this.#casOrder<boolean>("linkGuestOrders", async () => {
				const current = await this.#orders.getVersioned(found.orderId);
				if (current === null) return casDone(false);
				const doc = normalizeOrderDoc(current.value);
				if (!claimable(doc)) return casDone(false);
				const written = await this.#orders.compareAndSet(found.orderId, current.revision, {
					...doc,
					customerId,
					customerKey: customerKeyFor(customerId, doc.buyerRef),
					updatedAt: this.#clock.now().toISOString(),
				});
				return written.applied ? casDone(true) : CAS_RETRY;
			});
			if (won) linked++;
		}
		return linked;
	}

	/**
	 * Claim the next dispatchable outbox entry.
	 *
	 * ADR-0019 R2's design: the SQL claimed on `sent_at IS NULL AND status != 'failed'
	 * AND (lease_until IS NULL OR lease_until <= :now)`, an OR and a negation the filter
	 * algebra cannot express, so it becomes the ONE denormalized
	 * {@link OrderDoc.emailDueAt} index — `null` when the message is sent or failed,
	 * otherwise `max(dueAt, leaseUntil)` — and the claim is one compare-and-set that
	 * re-applies the same due predicate to the entry it picked. Only one dispatcher wins,
	 * and a crashed run's entry is claimable again the moment its lease lapses.
	 *
	 * Proven by `test/outbox-dispatch.dialects.test.ts` (the crashed-dispatcher and
	 * failed-send cases, ported from the SQL adapters' own suite).
	 */
	async claimNextEmail(now: string, leaseUntil: string): Promise<OutboxEmail | null> {
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxOutboxPages; page++) {
			const result = await this.#orders.query({
				where: { emailDueAt: { lte: now } },
				orderBy: { emailDueAt: "asc" },
				limit: OUTBOX_PAGE_SIZE,
				cursor,
			});
			for (const { data } of result.items) {
				const claimed = await this.#claimOutboxEntry(data.orderId, now, leaseUntil);
				if (claimed !== null) return claimed;
			}
			if (!result.hasMore || result.cursor === undefined) return null;
			cursor = result.cursor;
		}
		throw new ScanPageLimitError("claimNextEmail", this.#maxOutboxPages, 0, "maxOutboxPages");
	}

	/** Mark a claimed entry delivered. Terminal — it leaves the due index. */
	async markEmailSent(id: string, now: string): Promise<void> {
		await this.#updateOutboxEntry(id, (entry) => ({ ...entry, status: "sent", sentAt: now }));
	}

	/**
	 * Return a claimed entry to `pending` for a later tick, or park it `failed` when
	 * the retries are exhausted. `retryAt` moves the due time FORWARD so the row is
	 * not re-picked inside the same drain loop.
	 */
	async rescheduleEmail(id: string, retryAt: string | null): Promise<void> {
		await this.#updateOutboxEntry(id, (entry) =>
			retryAt === null
				? { ...entry, status: "failed", leaseUntil: null }
				: { ...entry, status: "pending", leaseUntil: null, dueAt: retryAt },
		);
	}

	// -- internals -------------------------------------------------------------

	/** Build the whole aggregate the claim will carry, ids and all. */
	#prepare(input: CreateOrderInput, now: string): OrderDoc {
		const items: OrderItemDoc[] = input.lines.map((line) => ({
			// One `newId()` per line, exactly as the multi-row insert did.
			id: this.#idGen.newId(),
			productId: line.productId,
			sku: line.sku,
			title: line.title,
			unitPrice: line.unitPrice,
			currency: line.currency,
			quantity: line.quantity,
			fulfillmentKind: line.fulfillmentKind,
			reservationId: line.reservationId,
		}));
		// The CREATE use-case's predicate, unfiltered by fulfillment kind: it is the id
		// list `createOrderFromCart` hands to `adoptMany` immediately after this write,
		// and the intent must name exactly what that batch will touch (see
		// `physicalReservationIds` for why the commit/release intents differ).
		const reservationIds = items
			.map((item) => item.reservationId)
			.filter((id): id is NonNullable<typeof id> => id !== null);
		const prepared: OrderDoc = {
			orderId: input.orderId,
			cartId: input.cartId,
			currency: input.currency,
			state: "pending",
			idempotencyKey: input.idempotencyKey,
			holdExpiresAt: input.holdExpiresAt,
			paymentMethod: input.paymentMethod,
			buyerRef: input.buyerRef,
			customerId: null,
			// R3: the fallback value. `linkGuestOrders` rewrites it; `buyerRefLower` is
			// frozen alongside `buyerRef` and is the second arm of the customer union.
			customerKey: customerKeyFor(null, input.buyerRef),
			buyerRefLower: foldBuyerRef(input.buyerRef),
			// The one prefix-searchable arm a single indexed field can serve; the line-sku
			// arm lives in `order_sku_index`, written right after this document lands.
			searchKey: searchKeyFor(input.orderId),
			// Derived from `emailOutbox`, which is empty until the first flip enqueues.
			emailDueAt: null,
			items,
			totals: {
				currency: input.totals.currency,
				subtotal: input.totals.subtotal,
				// Phase-4/5 callers pass none of these ⇒ 0 / null, reproducing the stub
				// the SQL adapter wrote byte for byte.
				discount: input.totals.discount ?? cents(0),
				shipping: input.totals.shipping ?? cents(0),
				tax: input.totals.tax ?? cents(0),
				total: input.totals.total,
				appliedCouponCode: input.totals.appliedCouponCode ?? null,
				shippingMethodSnapshot: input.totals.shippingMethodSnapshot ?? null,
				taxBreakdown: input.totals.taxBreakdown ?? null,
			},
			shippingAddress: input.shippingAddress ?? null,
			events: [],
			emailOutbox: [],
			payments: [],
			refunds: [],
			// The ADOPTION intent, recorded by the creating write itself — which is
			// what puts it before the use-case's `adoptMany`, the only ordering the
			// bracket needs. `holdsPendingAt` is the indexed scalar that makes it
			// findable by the sweeper, and it is derived from the intents, never set
			// independently.
			holdsPendingAt: null, // derived below, never hand-set
			holdsAdopted: newHoldIntent(reservationIds, now, input.holdExpiresAt),
			holdsCommitted: null,
			holdsReleased: null,
			reconciliationFlag: null,
			reconciliationResolution: null,
			fulfillment: null,
			cancellation: null,
			createdAt: now,
			updatedAt: now,
		};
		// ONE derivation of the sweeper's index, here as everywhere else: an adoption
		// intent over zero reservations is born complete, so a digital-only or
		// lines-free order is never listed as owing cross-aggregate work.
		return { ...prepared, holdsPendingAt: computeHoldsPendingAt(prepared) };
	}

	/**
	 * Finish a claim: create the order document, then promote the claim. Safe to
	 * run from any caller — the create is create-if-absent and the promotion is
	 * guarded, so a peer racing the same completion changes nothing.
	 */
	async #finishClaim(key: IdempotencyKey, prepared: OrderDoc): Promise<Order> {
		const written = await this.#orders.compareAndSet(prepared.orderId, null, prepared);
		const stored = await this.#orders.get(prepared.orderId);
		if (stored === null) {
			throw new Error(`order ${prepared.orderId} vanished immediately after createFromCart`);
		}
		// A refused create means the id is taken. If the document under it belongs to
		// a DIFFERENT key, the id source collided and adopting it would silently
		// attach this checkout to somebody else's order — loud, never adopted.
		if (!written.applied && stored.idempotencyKey !== key) {
			throw new OrderIdCollisionError(prepared.orderId, key, stored.idempotencyKey);
		}
		// BEFORE the key is promoted, deliberately. The by-sku index is derived, so it
		// needs no atomicity — but it does need a heal path, and the cheapest correct one
		// is the claim completion that already exists: a crash here leaves the key
		// `claimed`, and any replayer re-runs this write. Promote first and the same crash
		// would leave a terminal key over an order the search cannot find by sku.
		await this.#indexOrderSkus(normalizeOrderDoc(stored));
		await this.#terminalizeKey(key, prepared.orderId);
		// The order's ARRIVAL, reported only by the caller whose create actually landed:
		// a replay or a heal completing somebody else's claim wrote no state and owes no
		// event. `ordersByStatus` counts `pending` orders, so the rollups cannot learn
		// about an order from its first transition alone.
		if (written.applied) await this.#reportTransition(stored, null, stored.state);
		return toOrder(normalizeOrderDoc(stored));
	}

	/** Promote a `claimed` key to `terminal`, dropping the carried payload. */
	async #terminalizeKey(key: IdempotencyKey, orderId: string): Promise<void> {
		const current = await this.#keys.getVersioned(key);
		if (current === null || current.value.state === "terminal") return;
		// An unapplied write means a peer promoted it first, which is the same
		// outcome. Nothing to retry.
		await this.#keys.compareAndSet(key, current.revision, {
			state: "terminal",
			orderId,
			recordedAt: this.#clock.now().toISOString(),
		});
	}

	/**
	 * The order a key minted, COMPLETING the claim if it is still one. That is the
	 * heal path for the "claim written, order not created" window, and it is why
	 * the claim carries the whole payload.
	 */
	async #resolveKey(key: IdempotencyKey): Promise<Order | null> {
		const claim = await this.#keys.get(key);
		if (claim === null) return null;
		if (claim.state === "claimed") return this.#finishClaim(key, claim.doc);
		const doc = await this.#orders.get(claim.orderId);
		if (doc === null) return null;
		const order = normalizeOrderDoc(doc);
		// HEAL ON READ for the derived by-sku index, the same device the outbox locator
		// uses. A crash between the order document and its index documents can also leave
		// the key already TERMINAL, and then the claim-completion path above never runs —
		// so every resolve re-asserts the pointers. They are create-if-absent per
		// `(sku, orderId)` pair, so re-asserting them is idempotent and writes nothing on
		// the overwhelmingly common path where they are already there.
		await this.#indexOrderSkus(order);
		return toOrder(order);
	}

	/**
	 * The refund write both entry points share: the `refund_keys` claim, then ONE
	 * compare-and-set on the order document that arbitrates the ceiling against that
	 * document's own `payments[]` and `refunds[]` and appends the row.
	 *
	 * **The ceiling is computed INSIDE the write, from the document read on THIS
	 * attempt.** That is the whole reason payments and refunds are embedded: the SQL
	 * took a row lock on `orders` and summed under it so two concurrent refunds could
	 * not each read the same headroom, and the document revision does exactly that job
	 * — a peer that committed between this read and this write loses the compare-and-
	 * set, and the retry re-reads the sums it must respect. A ceiling taken from a
	 * pre-read would be the one bug this shape exists to make impossible.
	 *
	 * **The claim comes first, and carries the whole prepared row.** A crash between
	 * the claim and the order write leaves a `claimed` key whose entry never landed;
	 * every path that meets one re-runs the arbitration from the CARRIED intent, so
	 * the replay completes with the same refund id, amount and `createdAt` rather than
	 * minting a second row. A rejected arbitration leaves the same state, and that is
	 * deliberate: the SQL inserted no row when the ceiling refused a refund, so the key
	 * stayed usable, and here the two cases are one code path.
	 */
	async #insertRefund(
		input: RecordRefundInput,
		opts: { status: Extract<RefundStatus, "recorded" | "reserved">; driveFlip: boolean },
	): Promise<RecordRefundStoreResult> {
		const now = this.#clock.now().toISOString();
		const prepared: RefundEntryDoc = {
			id: this.#idGen.newId(),
			amount: input.amount,
			currency: input.currency,
			kind: input.kind,
			gateway: input.gateway,
			refundRef: input.refundRef,
			reason: input.reason,
			refundedBy: input.refundedBy,
			status: opts.status,
			idempotencyKey: input.idempotencyKey,
			createdAt: now,
		};
		let orderId: string = input.orderId;
		let intent = prepared;
		let driveFlip = opts.driveFlip;
		const claimed = await this.#refundKeys.compareAndSet(input.idempotencyKey, null, {
			state: "claimed",
			orderId,
			refund: prepared,
			driveFlip,
			claimedAt: now,
		});
		if (!claimed.applied) {
			const held = await this.#refundKeys.get(input.idempotencyKey);
			if (held !== null) {
				// The key's own order wins, not the caller's: `refunds.idempotency_key`
				// UNIQUE was GLOBAL, so a key already used against another order dedupes
				// against THAT order's row rather than minting a second one here.
				orderId = held.orderId;
				if (held.state === "claimed") {
					intent = held.refund;
					driveFlip = held.driveFlip;
				}
			}
		}

		const result = await this.#casOrder<Omit<RecordRefundStoreResult, "order">>(
			"recordRefund",
			async () => {
				const current = await this.#orders.getVersioned(orderId);
				if (current === null) {
					return casDone({
						outcome: "order_not_found" as const,
						refund: null,
						fullyRefunded: false,
						capturedTotal: cents(0),
						frozenTotal: cents(0),
					});
				}
				const doc = normalizeOrderDoc(current.value);
				// Both authoritative bounds, read in this attempt: the use-case picks
				// `REFUND_EXCEEDS_CAPTURED` vs `_TOTAL` from them, never from a pre-check.
				const capturedTotal = cents(capturedPaymentTotal(doc.payments));
				const frozenTotal = doc.totals.total; // FROZEN — never recomputed from products
				const existing = findRefund(doc, input.idempotencyKey);
				if (existing !== undefined) {
					return casDone({
						outcome: "duplicate" as const,
						refund: toRefundRecord(existing, orderId as OrderId),
						fullyRefunded: doc.state === "refunded",
						capturedTotal,
						frozenTotal,
					});
				}
				const ceiling = computeRefundCeiling(capturedTotal, frozenTotal);
				// ACTIVE capacity (R6): every non-`voided` row consumes it — finalized
				// money, held reservations and unverified attempts alike.
				const activePrior = activeRefundTotal(doc.refunds);
				if (activePrior + intent.amount > ceiling) {
					return casDone({
						outcome: "exceeds_ceiling" as const,
						refund: null,
						fullyRefunded: false,
						capturedTotal,
						frozenTotal,
					});
				}

				const writtenAt = this.#clock.now().toISOString();
				const refunds = [...doc.refunds, intent];
				let next: OrderDoc = { ...doc, refunds, updatedAt: writtenAt };
				let fullyRefunded = false;
				// A FULL refund flips `→ refunded` in THIS write, through the same flip
				// transform every other state change uses — so the state, the audit event,
				// the outbox entry and the ledger row commit together. Only the FINALIZED
				// sum counts: a held reservation never flips an order.
				if (
					driveFlip &&
					finalizedRefundTotal(refunds) === ceiling &&
					isLegalOrderTransition(doc.state, "refunded")
				) {
					next = this.#flipped(next, {
						fromState: doc.state,
						toState: "refunded",
						enqueueEmail: emailTemplateForState("refunded") !== null,
						actor: intent.refundedBy,
						now: writtenAt,
					});
					fullyRefunded = true;
				}
				const applied = await this.#orders.compareAndSet(orderId, current.revision, next);
				if (!applied.applied) return CAS_RETRY;
				// A RESERVED refund is not money that came back, so only a finalized one is
				// reported; the ceiling-reaching one also reports the flip it folded in.
				if (intent.status === "recorded") {
					await this.#reportRefund(next, intent.currency, intent.id, intent.amount);
				}
				if (fullyRefunded) await this.#reportTransition(next, doc.state, "refunded");
				return casDone({
					outcome: "recorded" as const,
					refund: toRefundRecord(intent, orderId as OrderId),
					fullyRefunded,
					capturedTotal,
					frozenTotal,
				});
			},
		);
		if (result.refund !== null) {
			await this.#terminalizeRefundKey(input.idempotencyKey, orderId, result.refund.id);
		}
		return { ...result, order: await this.getById(orderId as OrderId) };
	}

	/**
	 * A guarded refund-status flip, out of `reserved` only — `voidRefund` and
	 * `markRefundUnverified`, which differ in nothing but the target state and in
	 * whether the row keeps its capacity.
	 */
	async #flipRefundStatus(
		key: IdempotencyKey,
		to: Extract<RefundStatus, "voided" | "unverified">,
	): Promise<boolean> {
		const claim = await this.#refundKeys.get(key);
		if (claim === null) return false;
		const orderId = claim.orderId;
		return this.#casOrder<boolean>(`refund:${to}`, async () => {
			const current = await this.#orders.getVersioned(orderId);
			if (current === null) return casDone(false);
			const doc = normalizeOrderDoc(current.value);
			const entry = findRefund(doc, key);
			// The guard the SQL's `WHERE status = 'reserved'` was: capacity is released
			// or held deliberately, never by accident.
			if (entry === undefined || entry.status !== "reserved") return casDone(false);
			const now = this.#clock.now().toISOString();
			const written = await this.#orders.compareAndSet(orderId, current.revision, {
				...doc,
				refunds: doc.refunds.map((row) =>
					row.idempotencyKey === key ? { ...row, status: to } : row,
				),
				updatedAt: now,
			});
			return written.applied ? casDone(true) : CAS_RETRY;
		});
	}

	/** Promote a refund claim to `terminal`, dropping the carried payload. */
	async #terminalizeRefundKey(
		key: IdempotencyKey,
		orderId: string,
		refundId: string,
	): Promise<void> {
		const current = await this.#refundKeys.getVersioned(key);
		if (current === null || current.value.state === "terminal") return;
		// An unapplied write means a peer promoted it first — the same outcome.
		await this.#refundKeys.compareAndSet(key, current.revision, {
			state: "terminal",
			orderId,
			refundId,
			recordedAt: this.#clock.now().toISOString(),
		});
	}

	/**
	 * THE guarded flip: `state === fromState` (and the deadline, when asked), the
	 * new state, the appended audit event, the first-wins outbox entry and any hold
	 * intent — ONE compare-and-set.
	 */
	async #flip(input: {
		orderId: OrderId;
		fromState: OrderState;
		toState: OrderState;
		enqueueEmail: boolean;
		actor?: string;
		/** `expire`'s second predicate: the deadline must already have passed. */
		holdExpiresBefore?: string;
		/** Which cross-aggregate intent this flip records, if any. */
		intent?: "commit" | "release";
		/**
		 * The mutable envelope that rides the guarded write — the SQL's `extraSet`
		 * (PR #63's precedent), which is how `recordFulfillment` and `cancelOrder`
		 * record their columns in the SAME write as the flip instead of owning a
		 * second, drift-prone copy of it. Computed from the store clock, so it is a
		 * callback rather than a value.
		 */
		envelope?: (now: string) => Partial<OrderDoc>;
	}): Promise<FlipOutcome> {
		return this.#casOrder<FlipOutcome>("transition", async () => {
			const current = await this.#orders.getVersioned(input.orderId);
			if (current === null) return casDone<FlipOutcome>({ won: false, doc: null });
			const doc = normalizeOrderDoc(current.value);
			// The guard, as the SQL's `WHERE id = :id AND state = :fromState` was: a
			// mismatch is a 0-row no-op — no state change, NO event, no outbox entry.
			if (doc.state !== input.fromState) return casDone<FlipOutcome>({ won: false, doc });
			if (input.holdExpiresBefore !== undefined && doc.holdExpiresAt > input.holdExpiresBefore) {
				return casDone<FlipOutcome>({ won: false, doc });
			}

			const now = this.#clock.now().toISOString();
			const reservationIds = physicalReservationIds(doc);
			const next: OrderDoc = {
				...this.#flipped(doc, {
					fromState: input.fromState,
					toState: input.toState,
					enqueueEmail: input.enqueueEmail,
					actor: input.actor ?? null,
					now,
				}),
				...(input.envelope === undefined ? {} : input.envelope(now)),
				...(input.intent === "commit"
					? { holdsCommitted: newHoldIntent(reservationIds, now) }
					: {}),
				...(input.intent === "release"
					? { holdsReleased: newHoldIntent(reservationIds, now) }
					: {}),
			};
			// The indexed scalar the sweeper scans, re-derived from the three intents in
			// the SAME write that recorded one — so an outstanding bracket is findable
			// the instant it exists, and never a moment after it is closed.
			next.holdsPendingAt = computeHoldsPendingAt(next);
			const written = await this.#orders.compareAndSet(input.orderId, current.revision, next);
			if (!written.applied) return CAS_RETRY;
			// The locator, bracketed AFTER the flip (see `#recordOutboxLocator`). Only the
			// enqueueing flip has one to record.
			if (input.enqueueEmail) await this.#recordOutboxLocator(next, input.toState);
			// The rollup, after everything this flip owes is durable. Reached only on a WON
			// flip, and `casDone` ends the retry loop, so it fires exactly once per move.
			await this.#reportTransition(next, input.fromState, input.toState);
			return casDone<FlipOutcome>({ won: true, doc: next });
		});
	}

	/**
	 * THE guarded flip's write, as a pure document transform: the new state, the
	 * appended audit event and the first-wins outbox entry.
	 *
	 * It exists so the flip has ONE implementation even where it cannot be its own
	 * compare-and-set. A full refund has to flip `→ refunded` in the SAME write that
	 * appends the refund row (the ceiling and the flip are one decision on one
	 * document), so it composes this transform rather than calling {@link #flip} —
	 * which is the document-model analogue of the SQL's rule that every state change
	 * rides `#flipAndEnqueue` and never a parallel copy.
	 *
	 * The caller owns the GUARD (`state === fromState`) and the write; this owns what
	 * the write contains.
	 */
	#flipped(
		doc: OrderDoc,
		input: {
			fromState: OrderState;
			toState: OrderState;
			enqueueEmail: boolean;
			actor: string | null;
			now: string;
		},
	): OrderDoc {
		const next: OrderDoc = {
			...doc,
			state: input.toState,
			updatedAt: input.now,
			// Append-only audit, in THIS write: a row exists iff the flip won.
			events: [
				...doc.events,
				{
					id: this.#idGen.newId(),
					at: input.now,
					kind: "state_change",
					fromState: input.fromState,
					toState: input.toState,
					actor: input.actor,
				},
			],
			// First-wins per `(orderId, toState)` — NOT per event.
			emailOutbox:
				input.enqueueEmail && findOutboxEntry(doc, input.toState) === undefined
					? [
							...doc.emailOutbox,
							{
								id: this.#idGen.newId(),
								toState: input.toState,
								status: "pending",
								attempts: 0,
								leaseUntil: null,
								sentAt: null,
								createdAt: input.now,
							},
						]
					: doc.emailOutbox,
		};
		// R2's denormalized due time, derived in the SAME write that enqueued the entry
		// — the only way `claimNextEmail` can find it.
		return { ...next, emailDueAt: computeEmailDueAt(next) };
	}

	/** Mark one hold intent complete. Idempotent; a missing intent is a no-op. */
	async #stampIntent(
		orderId: OrderId,
		field: "holdsAdopted" | "holdsCommitted" | "holdsReleased",
	): Promise<void> {
		await this.#casOrder<void>(`complete:${field}`, async () => {
			const current = await this.#orders.getVersioned(orderId);
			if (current === null) return casDone(undefined);
			const doc = normalizeOrderDoc(current.value);
			const intent: HoldIntentDoc | null = doc[field] ?? null;
			if (!isOutstanding(intent) || intent === null) return casDone(undefined);
			const now = this.#clock.now().toISOString();
			const stamped: OrderDoc = { ...doc, [field]: { ...intent, completedAt: now } };
			const written = await this.#orders.compareAndSet(orderId, current.revision, {
				...stamped,
				// Cleared exactly when the LAST outstanding intent closes, because it is
				// recomputed rather than decremented.
				holdsPendingAt: computeHoldsPendingAt(stamped),
				updatedAt: now,
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/**
	 * Record that a release completion failed after a durable expiry flip, on the
	 * order's own reconciliation envelope — the one loud channel this port has that
	 * needs no extra collaborator.
	 *
	 * Best-effort by construction: if this write fails too, the OUTSTANDING intent
	 * (and the `holdsPendingAt` index that finds it) is still the durable record of
	 * the owed work, which is what the sweeper actually acts on.
	 */
	async #noteReleaseFailure(orderId: OrderId, cause: unknown, label = "expiry"): Promise<void> {
		const detail = cause instanceof Error ? cause.message : String(cause);
		try {
			await this.flagReconciliation(
				orderId,
				`${label} released no holds: ${detail} — the release intent is still outstanding`,
			);
		} catch {
			// Deliberately swallowed: see the docblock. Never turn a won flip into a throw.
		}
	}

	/**
	 * Page the `orders` index under one where clause, keeping the documents a
	 * predicate accepts, until `need` of them are collected or the pages run out.
	 *
	 * The host's own cursor drives the paging INSIDE one call, which is safe here for
	 * the reason it is not safe across calls: the row it re-reads to seek is a row this
	 * same call just read. Across calls the port's value-position cursor is used instead
	 * — see `listOrders`.
	 *
	 * The budget behaves exactly as `listExpirable`'s does: reaching it with pages still
	 * unread and rows still owed is a typed {@link ScanPageLimitError}, never a silently
	 * short list.
	 */
	async #scanOrders(
		operation: string,
		where: WhereClause,
		orderBy: OrderBy,
		need: number,
		keep: (doc: OrderDoc) => boolean,
	): Promise<OrderDoc[]> {
		const collected: OrderDoc[] = [];
		// The `createdAt` of the row that reached `need`. Once it is set, the arm keeps
		// draining until the FIRST row with a different `createdAt`: see `byNewestFirst`
		// for why stopping at `need` would be collation-dependent.
		let boundary: string | null = null;
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxListPages; page++) {
			const result = await this.#orders.query({ where, orderBy, limit: LIST_PAGE_SIZE, cursor });
			for (const { data } of result.items) {
				const doc = normalizeOrderDoc(data);
				// Checked BEFORE `keep`, because the ordering is on `createdAt` alone: once it
				// differs from the boundary the tie group is over, whatever the filter says.
				if (boundary !== null && doc.createdAt !== boundary) return collected;
				if (!keep(doc)) continue;
				collected.push(doc);
				if (boundary === null && collected.length >= need) boundary = doc.createdAt;
			}
			if (!result.hasMore || result.cursor === undefined) return collected;
			cursor = result.cursor;
		}
		throw new ScanPageLimitError(operation, this.#maxListPages, collected.length, "maxListPages");
	}

	/**
	 * The search's line-sku arm: the orders whose FROZEN lines carry this exact folded
	 * sku, ordered `createdAt DESC` and bounded the same way every other arm is.
	 *
	 * Empty for a search that is absent or the empty string — the empty string is the
	 * WIDEST filter on the id arm (every string starts with it), so this arm could add
	 * nothing to it, and `sku = ''` is no real sku.
	 *
	 * **It is a KEYSET arm, not a full resolve.** The pointer documents carry the order's
	 * frozen `createdAt` and are indexed `[sku, createdAt]`, so the list reads them
	 * newest-first and opens only the orders it could actually return — `need` of them,
	 * drained past the boundary tie group like any other arm. The pointer gives an order
	 * ID; the document is then read by id, which is one read per order the arm returns
	 * rather than an N+1 over the table.
	 *
	 * **The COUNT passes `Infinity` and is therefore `O(matches)`.** A cardinality has no
	 * page to stop at, so counting a sku resolves every order that ever bought it. The
	 * ceiling is real and typed: `maxListPages × LIST_PAGE_SIZE` pointers (1000 × 100 =
	 * 100 000 by default), past which the call raises `ScanPageLimitError` naming
	 * `maxListPages` rather than returning a short count. A sku with more matching orders
	 * than that needs the budget raised, and would deserve a materialized counter first.
	 *
	 * The pointer is DERIVED, so the frozen lines stay the authority: a pointer whose
	 * order is gone, or whose sku is no longer on the lines it names, is not a row.
	 */
	async #ordersMatchingSku(
		search: string | undefined,
		filter: OrderListFilter,
		cursor: OrderListCursor | null,
		need: number,
	): Promise<OrderDoc[]> {
		if (search === undefined || search === "") return [];
		const range = createdAtRange(filter, cursor);
		const where: WhereClause = range === null ? { sku: search } : { sku: search, createdAt: range };
		const docs: OrderDoc[] = [];
		let boundary: string | null = null;
		let indexCursor: string | undefined;
		for (let page = 0; page < this.#maxListPages; page++) {
			const result = await this.#skuIndex.query({
				where,
				orderBy: { createdAt: "desc" },
				limit: LIST_PAGE_SIZE,
				cursor: indexCursor,
			});
			for (const { data } of result.items) {
				if (boundary !== null && data.createdAt !== boundary) return docs;
				const stored = await this.#orders.get(data.orderId);
				// A pointer with no order behind it, or one the lines no longer bear, is not a
				// row: the pointer is derived and may never widen the predicate.
				if (stored === null) continue;
				const doc = normalizeOrderDoc(stored);
				if (!orderSkuKeys(doc).includes(search)) continue;
				if (!matchesOrderFilter(doc, filter) || !isAfterCursor(doc, cursor)) continue;
				docs.push(doc);
				if (boundary === null && docs.length >= need) boundary = data.createdAt;
			}
			if (!result.hasMore || result.cursor === undefined) return docs;
			indexCursor = result.cursor;
		}
		throw new ScanPageLimitError("listOrders", this.#maxListPages, docs.length, "maxListPages");
	}

	/**
	 * Write the derived by-sku index documents for one order. Create-if-absent per pair,
	 * so a replay, a heal and a multi-line order carrying one sku twice all converge on
	 * the same single row.
	 */
	async #indexOrderSkus(doc: OrderDoc): Promise<void> {
		for (const sku of orderSkuKeys(doc)) {
			const id = orderSkuIndexId(sku, doc.orderId);
			const written = await this.#skuIndex.compareAndSet(id, null, {
				sku,
				orderId: doc.orderId,
				// The order's own creation instant, frozen: what makes the arm a keyset arm.
				createdAt: doc.createdAt,
			});
			// A refused create means "already there", which is the point — but it is only SAFE
			// if the incumbent agrees, so it is read back and compared rather than assumed.
			await this.#assertPointerAgrees(
				written.applied,
				ORDER_SKU_INDEX_COLLECTION,
				id,
				doc.orderId,
				() => this.#skuIndex.get(id),
			);
		}
	}

	/**
	 * The shared read-back for the two DERIVED pointer collections.
	 *
	 * `compareAndSet(id, null, …)` returning `applied: false` means the row exists. That
	 * is the ordinary outcome of a replay or a peer, and the pointer is idempotent — but
	 * "idempotent" is a claim about the CONTENT, so the content is checked. A disagreeing
	 * incumbent is an id collision, and adopting it would mis-route a settle or make the
	 * sku search answer with somebody else's order.
	 *
	 * An incumbent that has vanished between the refused write and the read-back is NOT an
	 * error: there is nothing to disagree with, and the next heal writes it again.
	 */
	async #assertPointerAgrees(
		applied: boolean,
		collection: string,
		pointerId: string,
		expectedOrderId: string,
		read: () => Promise<{ orderId: string } | null>,
	): Promise<void> {
		if (applied) return;
		const incumbent = await read();
		if (incumbent === null || incumbent.orderId === expectedOrderId) return;
		throw new DerivedPointerConflictError(
			collection,
			pointerId,
			expectedOrderId,
			incumbent.orderId,
		);
	}

	/**
	 * Record the outbox locator for the entry a won flip just enqueued.
	 *
	 * Bracketed, not atomic — it is a second document, and there is no transaction. The
	 * ordering is deliberate: the locator is written AFTER the flip, so the only
	 * reachable tear is "entry exists, locator does not", which the settle path heals
	 * with one bounded walk of the `emailDueAt` index. The reverse ordering would leave
	 * a locator pointing at an entry that does not exist, which nothing can heal.
	 */
	async #recordOutboxLocator(doc: OrderDoc, toState: OrderState): Promise<void> {
		const entry = findOutboxEntry(doc, toState);
		if (entry === undefined) return;
		const written = await this.#outboxKeys.compareAndSet(entry.id, null, {
			orderId: doc.orderId,
		});
		// A refused write is the ordinary "this flip re-recorded an entry that already had
		// its locator" — unless the incumbent names another order, in which case an entry id
		// collided and a settle would land on the wrong document.
		await this.#assertPointerAgrees(
			written.applied,
			OUTBOX_KEYS_COLLECTION,
			entry.id,
			doc.orderId,
			() => this.#outboxKeys.get(entry.id),
		);
	}

	/**
	 * Claim the earliest due entry on ONE order, re-applying the due predicate inside
	 * the write — so only one dispatcher can win a claim, and a lapsed lease is
	 * claimable again.
	 */
	async #claimOutboxEntry(
		orderId: string,
		now: string,
		leaseUntil: string,
	): Promise<OutboxEmail | null> {
		return this.#casOrder<OutboxEmail | null>("claimNextEmail", async () => {
			const current = await this.#orders.getVersioned(orderId);
			if (current === null) return casDone<OutboxEmail | null>(null);
			const doc = normalizeOrderDoc(current.value);
			let picked: OutboxEntryDoc | undefined;
			let pickedDue: string | undefined;
			for (const entry of doc.emailOutbox) {
				const due = outboxDueAt(entry);
				if (due === null || due > now) continue;
				if (pickedDue === undefined || due < pickedDue) {
					picked = entry;
					pickedDue = due;
				}
			}
			if (picked === undefined) return casDone<OutboxEmail | null>(null);
			const claimed: OutboxEntryDoc = {
				...picked,
				status: "sending",
				leaseUntil,
				attempts: picked.attempts + 1,
			};
			const next = replaceOutboxEntry(doc, claimed);
			const written = await this.#orders.compareAndSet(orderId, current.revision, next);
			return written.applied
				? casDone<OutboxEmail | null>({
						id: claimed.id,
						orderId: doc.orderId as OrderId,
						toState: claimed.toState,
						attempts: claimed.attempts,
					})
				: CAS_RETRY;
		});
	}

	/**
	 * Apply a transform to the outbox entry with this id, via the locator.
	 *
	 * The dispatcher settles a row by ENTRY id alone, and an entry embedded in an order
	 * document cannot be found by one — so `outbox_keys/{entryId} → { orderId }` is the
	 * locator, and this is a single `get` followed by one guarded compare-and-set. It
	 * replaces the walk of the `emailDueAt` index the transitions increment shipped as
	 * declared debt.
	 *
	 * **The walk survives as the HEAL, once** — and an unresolvable id is LOUD, not a
	 * no-op. The locator is a second document written after the flip, so "entry enqueued,
	 * locator missing" is reachable; a settle that finds no locator walks the bounded index
	 * once and writes the locator it found, so the next settle is a `get` again. If the
	 * walk and one more locator read both come up empty the call raises
	 * {@link OutboxEntryUnlocatableError} — see {@link #locateOutboxEntry} for why a quiet
	 * return there is the one outcome that could cause a double send. `maxOutboxPages`
	 * bounds only the fallback.
	 *
	 * **The write is guarded on `status === "sending"`.** Only a CLAIMED entry may be
	 * settled, so a double settle is a no-op: the entry is already terminal and the guard
	 * refuses it. The port's `void` return is what makes a no-op the correct outcome
	 * rather than a lost write, and the same is true of an order that has since vanished.
	 */
	async #updateOutboxEntry(
		id: string,
		transform: (entry: OutboxEntryDoc) => OutboxEntryDoc,
	): Promise<void> {
		const orderId = await this.#locateOutboxEntry(id);
		await this.#casOrder<void>("settleEmail", async () => {
			const current = await this.#orders.getVersioned(orderId);
			if (current === null) return casDone(undefined);
			const doc = normalizeOrderDoc(current.value);
			const entry = doc.emailOutbox.find((row) => row.id === id);
			// Only a CLAIMED entry is settleable. A `pending` entry was never handed out,
			// and a `sent`/`failed` one is terminal — settling either would be this file's
			// only unguarded write.
			if (entry === undefined || entry.status !== "sending") return casDone(undefined);
			const next = replaceOutboxEntry(doc, transform(entry));
			const written = await this.#orders.compareAndSet(orderId, current.revision, next);
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/**
	 * Resolve an outbox entry id to the order that holds it: locator, then heal, then FAIL.
	 *
	 * The three steps are deliberate, and the third is the correction this increment's
	 * review forced. An earlier version returned `undefined` when the walk found nothing
	 * and let the settle be a no-op — which conflates two states that are not equivalent:
	 *
	 * - an **already-drained** entry has a locator, so it never reaches the walk at all,
	 *   and its settle is a guarded no-op inside the compare-and-set;
	 * - an entry whose locator was lost and whose row the walk MISSED is still `sending`.
	 *   The `emailDueAt` index churns under concurrent claims and settles, so a walk really
	 *   can pass a row that another dispatcher is moving. Returning quietly there leaves a
	 *   live lease to lapse and the message to be claimed and sent a SECOND time.
	 *
	 * So the walk is followed by one more locator read — a peer completing the same heal is
	 * the likeliest explanation for a missed row — and if that is still empty the call
	 * raises {@link OutboxEntryUnlocatableError}. Loud, typed and retryable: nothing was
	 * written, and the next tick may well resolve it.
	 */
	async #locateOutboxEntry(id: string): Promise<string> {
		const direct = await this.#outboxKeys.get(id);
		if (direct !== null) return direct.orderId;
		const walked = await this.#walkForOutboxEntry(id);
		if (walked !== undefined) {
			const written = await this.#outboxKeys.compareAndSet(id, null, { orderId: walked });
			await this.#assertPointerAgrees(written.applied, OUTBOX_KEYS_COLLECTION, id, walked, () =>
				this.#outboxKeys.get(id),
			);
			return walked;
		}
		// A peer may have healed it while this call was walking; that is a success, not a
		// race to lose.
		const second = await this.#outboxKeys.get(id);
		if (second !== null) return second.orderId;
		throw new OutboxEntryUnlocatableError(id, this.#maxOutboxPages);
	}

	/**
	 * One bounded walk of the same `emailDueAt` index the claim uses, looking for the order
	 * that holds an entry whose locator is missing.
	 *
	 * A CLAIMED entry is in that index by construction (its lease is its due time), so this
	 * is a heal and not a guess — but it is not a proof either, because the index moves
	 * under concurrent dispatchers. `undefined` therefore means "not found in this pass",
	 * and the caller decides what that means; it never means "settled".
	 */
	async #walkForOutboxEntry(id: string): Promise<string | undefined> {
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxOutboxPages; page++) {
			const result = await this.#orders.query({
				where: { emailDueAt: { lte: FAR_FUTURE } },
				orderBy: { emailDueAt: "asc" },
				limit: OUTBOX_PAGE_SIZE,
				cursor,
			});
			for (const { data } of result.items) {
				if ((data.emailOutbox ?? []).some((entry) => entry.id === id)) return data.orderId;
			}
			if (!result.hasMore || result.cursor === undefined) return undefined;
			cursor = result.cursor;
		}
		throw new ScanPageLimitError("settleEmail", this.#maxOutboxPages, 0, "maxOutboxPages");
	}

	/**
	 * Report one durable transition to the rollups, and swallow whatever it does.
	 *
	 * **The swallow is the contract, not laziness.** By the time this runs the state
	 * write has committed, so a throw here would tell the caller its transition failed
	 * when it did not — the worst possible lie about a payment. What is lost instead is a
	 * counter, in the UNDER-counting direction, and the reporting adapter's recompute is
	 * the routine that restores it. The retry helper would not absorb this throw either:
	 * it only re-runs on a retryable storage abort, so an uncaught reporting failure
	 * would escape as the store call's own error.
	 */
	async #reportTransition(
		doc: OrderDoc,
		fromState: OrderState | null,
		toState: OrderState,
	): Promise<void> {
		try {
			await this.#reporting.recordOrderEvent({
				kind: "transition",
				orderId: doc.orderId,
				orderCreatedAt: doc.createdAt,
				currency: doc.currency,
				fromState,
				toState,
				orderTotalCents: doc.totals.total,
			});
		} catch {
			// Swallowed by design — see this method's docblock.
		}
	}

	/** Report one FINALIZED refund to the rollups. Swallowed for the same reason. */
	async #reportRefund(
		doc: OrderDoc,
		currency: Currency,
		refundId: string,
		amount: Cents,
	): Promise<void> {
		try {
			await this.#reporting.recordOrderEvent({
				kind: "refund",
				orderId: doc.orderId,
				orderCreatedAt: doc.createdAt,
				// The REFUND's currency, which is the bucket the money came back into.
				currency,
				refundId,
				refundedCents: amount,
			});
		} catch {
			// Swallowed by design — see `#reportTransition`.
		}
	}

	#casOrder<T>(operation: string, step: (attempt: number) => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}

/** Beyond any timestamp this domain writes — the upper bound of the due-index scan. */
const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

/** Swap one outbox entry for its successor, re-deriving R2's due index. */
function replaceOutboxEntry(doc: OrderDoc, entry: OutboxEntryDoc): OrderDoc {
	const emailOutbox = doc.emailOutbox.map((row) => (row.id === entry.id ? entry : row));
	return { ...doc, emailOutbox, emailDueAt: computeEmailDueAt({ emailOutbox }) };
}

/** The no-held-row finalize disposition: the loud residual the use-case surfaces. */
const MISSING_FINALIZE_INNER = {
	found: false,
	alreadyFinalized: false,
	refund: null,
	fullyRefunded: false,
} as const;

/** The same, with the order the port's result shape carries. */
const MISSING_FINALIZE: FinalizeRefundStoreResult = { ...MISSING_FINALIZE_INNER, order: null };

/** The embedded ledger row → the port's `RefundRecord`. */
function toRefundRecord(refund: RefundEntryDoc, orderId: OrderId): RefundRecord {
	return {
		id: refund.id,
		orderId,
		amount: refund.amount,
		currency: refund.currency,
		kind: refund.kind,
		gateway: refund.gateway,
		refundRef: refund.refundRef,
		reason: refund.reason,
		refundedBy: refund.refundedBy,
		status: refund.status,
		idempotencyKey: refund.idempotencyKey,
		createdAt: refund.createdAt,
	};
}

/** Plain code-unit comparison — never `localeCompare`, so every tier agrees. */
/**
 * The search string, folded — or `undefined` when the filter carries none.
 *
 * The fold is applied ONCE, here, so the two arms (a `startsWith` on `searchKey` and an
 * equality on the index's `sku`) cannot disagree about which side was folded. Both
 * stored sides are already folded at write time, so this is the whole of the "lower()
 * on both operands" the SQL spelled out.
 *
 * The empty string is kept as the empty string, not collapsed to `undefined`: the port
 * pins it as the WIDEST filter on the id arm, which `startsWith("")` gives for free.
 * Literal `%`, `_` and `\` need no handling — the host escapes the prefix before it
 * builds the `LIKE`, so a metacharacter in a search is a character.
 */
function foldSearch(search: string | undefined): string | undefined {
	return search === undefined ? undefined : search.toLowerCase();
}

/**
 * The customer key's arms — the SQL's `customer_id = :id OR lower(buyer_ref) = :ref`, as
 * one `WhereClause` per arm.
 *
 * `null` when the key is absent or carries neither half, which is the port's own rule
 * ("adapters ignore a key with neither half"). One arm when one half is set, two when both
 * are — and the two are UNIONED, never ANDed: an order is this person's if EITHER holds,
 * and one matching both is still one row.
 *
 * The `customerId` half reads {@link OrderDoc.customerKey}, which is that id verbatim on a
 * linked order (ADR-0019 R3). The one value it could over-reach is an UNLINKED order whose
 * folded buyer reference literally spells a customer id — customer ids are uuids and buyer
 * references are email addresses, so the two value spaces do not overlap; and because the
 * LIST uses this same clause, a count could not disagree with its page even if they did.
 */
function customerKeyArms(customer: OrderCustomerKey | undefined): WhereClause[] | null {
	if (customer === undefined) return null;
	const arms: WhereClause[] = [];
	if (customer.customerId !== undefined) arms.push({ customerKey: customer.customerId });
	if (customer.buyerRef !== undefined)
		arms.push({ buyerRefLower: foldBuyerRef(customer.buyerRef) });
	return arms.length === 0 ? null : arms;
}

/**
 * The search's INDEXED arms — the two of its three the filter algebra can express.
 *
 * The order-id arm is an anchored prefix on `searchKey` and reproduces the SQL exactly.
 * The buyer-reference arm is a prefix on `buyerRefLower` where the SQL had an unanchored
 * SUBSTRING: that is the ratified narrowing (ADR-0019 §6.1), and it is a prefix rather than
 * nothing because the index already exists for the customer key and a prefix is what
 * restores the operator workflow the arm is FOR — typing an address, or its local part, and
 * finding the order. The third arm, the exact line sku, is not a clause at all; it rides
 * the derived `order_sku_index` documents.
 *
 * `null` when there is no search. An EMPTY search yields arms that match everything, which
 * is the port's own boundary ("every string starts with `\"\"`").
 */
function searchArms(search: string | undefined): WhereClause[] | null {
	if (search === undefined) return null;
	return [{ searchKey: { startsWith: search } }, { buyerRefLower: { startsWith: search } }];
}

/** The list predicate's OR dimensions, in a fixed order so list and count agree. */
function orderListDimensions(filter: OrderListFilter, search: string | undefined): WhereClause[][] {
	const dimensions: WhereClause[][] = [];
	const bySearch = searchArms(search);
	if (bySearch !== null) dimensions.push(bySearch);
	const byCustomer = customerKeyArms(filter.customer);
	if (byCustomer !== null) dimensions.push(byCustomer);
	return dimensions;
}

/** True when a document satisfies either INDEXED search arm — the sku arm's overlap test. */
function matchesSearchArms(doc: OrderDoc, search: string): boolean {
	return (doc.searchKey ?? "").startsWith(search) || (doc.buyerRefLower ?? "").startsWith(search);
}

/**
 * AND two or more `WhereClause`s, or `null` when the conjunction is unsatisfiable.
 *
 * Needed because the dimensions are crossed and TWO of them can name the same field:
 * `buyerRefLower` carries the search's prefix arm and the customer key's exact arm. A plain
 * object spread would silently drop one of the two predicates, so the overlap is resolved
 * arithmetically instead — an exact value ANDed with a prefix is that value iff it has the
 * prefix, and two prefixes are the longer iff it extends the shorter.
 *
 * Any other repeated field would be a programming error (nothing else is written by two
 * dimensions), and it throws rather than guessing.
 */
function andWhere(parts: readonly WhereClause[]): WhereClause | null {
	const merged: WhereClause = {};
	for (const part of parts) {
		for (const [field, value] of Object.entries(part)) {
			const held = merged[field];
			if (held === undefined) {
				merged[field] = value;
				continue;
			}
			const reconciled = reconcileClause(field, held, value);
			if (reconciled === null) return null;
			merged[field] = reconciled;
		}
	}
	return merged;
}

/** The prefix a `startsWith` clause carries, or `null` for any other predicate shape. */
function prefixOf(value: WhereValue): string | null {
	return typeof value === "object" && value !== null && "startsWith" in value
		? value.startsWith
		: null;
}

/** The one overlap {@link andWhere} can meet: an exact fold against a prefix of it. */
function reconcileClause(field: string, a: WhereValue, b: WhereValue): WhereValue | null {
	const aPrefix = prefixOf(a);
	const bPrefix = prefixOf(b);
	if (typeof a === "string" && typeof b === "string") return a === b ? a : null;
	if (typeof a === "string" && bPrefix !== null) return a.startsWith(bPrefix) ? a : null;
	if (typeof b === "string" && aPrefix !== null) return b.startsWith(aPrefix) ? b : null;
	if (aPrefix !== null && bPrefix !== null) {
		if (aPrefix.startsWith(bPrefix)) return a;
		if (bPrefix.startsWith(aPrefix)) return b;
		return null;
	}
	throw new Error(
		`cannot AND two predicates on '${field}' — only an exact fold and a prefix of it are ` +
			"expected to overlap, so this is a programming error in the predicate builder",
	);
}

/**
 * Inclusion–exclusion over the OR dimensions, as the terms a count sums.
 *
 * For one dimension of `k` alternatives,
 * `|∪| = Σ over nonempty S of (-1)^(|S|+1) · |∩S|`. Dimensions are independent AND
 * factors, so their term lists multiply and the signs multiply with them. Terms whose
 * conjunction is unsatisfiable drop out (they count zero).
 */
function inclusionExclusionTerms(
	base: WhereClause,
	dimensions: readonly WhereClause[][],
): { where: WhereClause; sign: number }[] {
	let terms: { parts: WhereClause[]; sign: number }[] = [{ parts: [base], sign: 1 }];
	for (const arms of dimensions) {
		const next: { parts: WhereClause[]; sign: number }[] = [];
		for (const term of terms) {
			for (const subset of nonEmptySubsets(arms)) {
				next.push({
					parts: [...term.parts, ...subset],
					sign: term.sign * (subset.length % 2 === 1 ? 1 : -1),
				});
			}
		}
		terms = next;
	}
	const out: { where: WhereClause; sign: number }[] = [];
	for (const term of terms) {
		const where = andWhere(term.parts);
		if (where !== null) out.push({ where, sign: term.sign });
	}
	return out;
}

/** Every non-empty subset of a small alternative list, as bitmasks. */
function nonEmptySubsets<T>(items: readonly T[]): T[][] {
	const subsets: T[][] = [];
	for (let mask = 1; mask < 1 << items.length; mask++) {
		const subset: T[] = [];
		for (const [index, item] of items.entries()) {
			if ((mask & (1 << index)) !== 0) subset.push(item);
		}
		subsets.push(subset);
	}
	return subsets;
}

/** The half-open window plus the cursor's coarse bound, or `null` when unconstrained. */
function createdAtRange(
	filter: OrderListFilter,
	cursor: OrderListCursor | null,
): { gte?: string; lt?: string; lte?: string } | null {
	const range: { gte?: string; lt?: string; lte?: string } = {};
	if (filter.from !== undefined) range.gte = filter.from;
	if (filter.to !== undefined) range.lt = filter.to; // EXCLUSIVE — half-open (MOD-7)
	if (cursor !== null) range.lte = cursor.createdAt;
	return Object.keys(range).length === 0 ? null : range;
}

/**
 * The AND-only half of the list predicate: states, the window and the cursor's coarse
 * bound. Shared verbatim by `listOrders` and `countOrders` — the document-store analogue
 * of the SQL adapters' `orderFilterConditions`, and the reason a count can never disagree
 * with the page it captions.
 *
 * `state` is an `in` set and the window is HALF-OPEN `[from, to)` as `gte`/`lt`. The OR
 * dimensions (the search's two indexed arms, the customer key's two) are NOT here — they
 * are crossed onto this base by {@link orderListWhereArms} for the list and summed by
 * {@link inclusionExclusionTerms} for the count.
 *
 * The `search` argument is accepted and deliberately unused in the clause: it is the
 * dimensions' business. It stays in the signature so a caller cannot build a base that
 * silently disagrees about whether a search is present.
 */
function orderListBaseWhere(
	filter: OrderListFilter,
	cursor: OrderListCursor | null,
	_search: string | undefined,
): WhereClause {
	const where: WhereClause = {};
	if (filter.states !== undefined && filter.states.length > 0) {
		where.state = { in: [...filter.states] };
	}
	const range = createdAtRange(filter, cursor);
	if (range !== null) where.createdAt = range;
	return where;
}

/** The base predicate crossed with every OR dimension: one indexed query each. */
function orderListWhereArms(
	filter: OrderListFilter,
	cursor: OrderListCursor | null,
	search: string | undefined,
): WhereClause[] {
	const base = orderListBaseWhere(filter, cursor, search);
	let arms: WhereClause[] = [base];
	for (const dimension of orderListDimensions(filter, search)) {
		const next: WhereClause[] = [];
		for (const arm of arms) {
			for (const alternative of dimension) {
				const merged = andWhere([arm, alternative]);
				if (merged !== null) next.push(merged);
			}
		}
		arms = next;
	}
	return arms;
}

/**
 * The same predicate as {@link orderListBaseWhere} plus the customer arms, MINUS the
 * search and the cursor, decided in memory.
 *
 * It exists for the sku arm alone: those documents arrive by id from the derived index
 * rather than from a filtered query, so the rest of the predicate has to be applied to
 * them here. It is deliberately the same clause list in the same order, so a change to
 * one is visibly a change to the other.
 */
function matchesOrderFilter(doc: OrderDoc, filter: OrderListFilter): boolean {
	if (filter.states !== undefined && filter.states.length > 0) {
		if (!filter.states.includes(doc.state)) return false;
	}
	if (filter.from !== undefined && doc.createdAt < filter.from) return false;
	if (filter.to !== undefined && doc.createdAt >= filter.to) return false; // EXCLUSIVE
	const customer = filter.customer;
	if (
		customer !== undefined &&
		(customer.customerId !== undefined || customer.buyerRef !== undefined)
	) {
		const byId = customer.customerId !== undefined && doc.customerKey === customer.customerId;
		const byRef =
			customer.buyerRef !== undefined && doc.buyerRefLower === foldBuyerRef(customer.buyerRef);
		if (!byId && !byRef) return false; // the UNION, not an intersection
	}
	return true;
}

/**
 * True when the document sits strictly AFTER a cursor position under
 * `createdAt DESC, id DESC` — the port's own ordering.
 *
 * The port's cursor is a value position rather than an opaque token, so this is
 * decidable against any document from any arm without re-reading the cursor's row. That
 * is what makes a DELETED cursor row a non-event here: the position still describes
 * itself, and paging continues from it.
 */
function isAfterCursor(doc: OrderDoc, cursor: OrderListCursor | null): boolean {
	if (cursor === null) return true;
	if (doc.createdAt !== cursor.createdAt) return doc.createdAt < cursor.createdAt;
	return doc.orderId < cursor.id;
}

/**
 * `createdAt DESC, id DESC` — the list's total order, for the in-adapter merge.
 *
 * **THE INVARIANT, because two orderings are in play.** The adapter's total order is
 * `createdAt DESC, id DESC` in **code-unit** order (`<` on JS strings, via
 * {@link compare}), which is the ordering the port's cursor position and
 * {@link isAfterCursor} are defined in. The HOST's `order by` breaks its `createdAt` ties
 * on the storage `id` COLUMN under the database's collation — and Postgres's default
 * collation is not code-unit order: it ignores punctuation at the primary level, so `oa`
 * and `o-b` sort in one order there and the other order here.
 *
 * That only matters where rows are DROPPED, so the rule is: **an arm is drained to the end
 * of its boundary tie group before anything is sliced.** `#scanOrders` and
 * `#ordersMatchingSku` both keep reading past `need` until `createdAt` changes, and only
 * then does `listOrders` sort by this comparator and slice. Truncating at `need` in the
 * host's row order would let a tied row that Postgres ordered differently fall off one page
 * without appearing on the next — a silent gap, on one dialect only.
 *
 * `createdAt` itself is safe to compare either way: it is fixed-width ISO-8601 UTC, so
 * lexical, chronological and collated order coincide.
 */
function byNewestFirst(a: OrderDoc, b: OrderDoc): number {
	return compare(b.createdAt, a.createdAt) || compare(b.orderId, a.orderId);
}

/**
 * The document → `OrderSummary` projection: the admin table's columns and nothing else.
 *
 * `total` comes off the embedded totals (the SQL's 1:1 `order_totals` join, now a
 * field), and `reconciliationFlag` is narrowed to a BOOLEAN badge on purpose — the list
 * never leaks the free-text anomaly detail.
 */
function toSummary(doc: OrderDoc): OrderSummary {
	return {
		id: doc.orderId as OrderId,
		state: doc.state,
		currency: doc.currency,
		buyerRef: doc.buyerRef,
		customerId: doc.customerId,
		paymentMethod: doc.paymentMethod,
		createdAt: doc.createdAt,
		total: doc.totals.total,
		reconciliationFlag: doc.reconciliationFlag !== null,
	};
}

function compare(a: string, b: string): number {
	return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * The document → port projection. The lines are COPIED into a fresh mutable array
 * because `Order.lines` is mutable in the port; the document's own `readonly`
 * array is never handed out, so a caller cannot reach the snapshot through it.
 */
function toOrder(doc: OrderDoc): Order {
	const orderId = doc.orderId as OrderId;
	const lines: OrderLine[] = doc.items.map((item) => ({
		id: item.id,
		orderId,
		productId: item.productId,
		sku: item.sku,
		title: item.title,
		unitPrice: item.unitPrice,
		currency: item.currency,
		quantity: item.quantity,
		fulfillmentKind: item.fulfillmentKind,
		reservationId: item.reservationId,
	}));
	return {
		id: orderId,
		cartId: doc.cartId,
		currency: doc.currency,
		state: doc.state,
		idempotencyKey: doc.idempotencyKey,
		holdExpiresAt: doc.holdExpiresAt,
		paymentMethod: doc.paymentMethod,
		buyerRef: doc.buyerRef,
		customerId: doc.customerId,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
		lines,
		totals: {
			orderId,
			currency: doc.totals.currency,
			subtotal: doc.totals.subtotal,
			discount: doc.totals.discount,
			shipping: doc.totals.shipping,
			tax: doc.totals.tax,
			total: doc.totals.total,
			appliedCouponCode: doc.totals.appliedCouponCode,
			shippingMethodSnapshot: doc.totals.shippingMethodSnapshot,
			taxBreakdown: doc.totals.taxBreakdown,
		},
		shippingAddress: doc.shippingAddress,
		reconciliationFlag: doc.reconciliationFlag,
		reconciliationResolution: doc.reconciliationResolution,
		fulfillment: doc.fulfillment,
		cancellation: doc.cancellation,
	};
}
