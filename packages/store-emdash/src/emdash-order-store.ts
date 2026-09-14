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
 * | release | the `→ expired` flip | `releaseAdopted` per id, order-scoped | {@link EmdashOrderStore.completeHoldRelease} |
 *
 * An intent whose `completedAt` is `null` is the marker that work is owed; each
 * completion is idempotent and callable by ANY replayer, which is what makes a
 * partial batch safe. The commit completion drives the **singular** `commit` per
 * id rather than re-running `commitMany`, because ADR-0019 §2 is explicit that
 * `commitMany` SKIPS an already-`committed` id: a SKU caught between its terminal
 * record and its prune is finished by the singular call, never by the batch.
 *
 * ## What this increment does NOT implement
 *
 * Refunds, reconciliation resolution, fulfillment and cancellation (INC-B3) and
 * the lists, search, customer view and outbox lease (INC-B4) throw
 * {@link NotImplementedInIncrementError} naming their increment — a loud, typed
 * refusal rather than a wrong answer. Their FIELDS and INDEXES are already in the
 * document shape (see `order-documents.ts`), so those increments add behaviour
 * without reshaping a collection that holds live orders.
 */
import {
	cents,
	type CancelOrderInput,
	type CancelOrderStoreResult,
	type CapturedPayment,
	type Clock,
	type CreateOrderInput,
	type CreateOrderResult,
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
	type OrderListFilter,
	type OrderListPage,
	type OrderListResult,
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
	NotImplementedInIncrementError,
	OrderIdCollisionError,
	OrderNotFoundError,
	PaymentRefConflictError,
	ScanPageLimitError,
} from "./errors.js";
import {
	computeHoldsPendingAt,
	customerKeyFor,
	findOutboxEntry,
	type HoldIntentDoc,
	isOutstanding,
	newHoldIntent,
	normalizeOrderDoc,
	ORDER_KEYS_COLLECTION,
	type OrderDoc,
	type OrderItemDoc,
	type OrderKeyDoc,
	ORDERS_COLLECTION,
	PAYMENT_REFS_COLLECTION,
	type PaymentRefDoc,
	physicalReservationIds,
} from "./order-documents.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

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
}

/** How many pages `listExpirable` will walk before it refuses to loop further. */
const MAX_EXPIRY_PAGES = 1000;

/** The host clamps `limit` at 100; asking for it is asking for the widest page. */
const EXPIRY_PAGE_SIZE = 100;

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
	readonly #inventory: InventoryStore;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxExpiryPages: number;

	constructor(options: EmdashOrderStoreOptions) {
		this.#orders = collectionOf<OrderDoc>(options.storage, ORDERS_COLLECTION);
		this.#keys = collectionOf<OrderKeyDoc>(options.storage, ORDER_KEYS_COLLECTION);
		this.#paymentRefs = collectionOf<PaymentRefDoc>(options.storage, PAYMENT_REFS_COLLECTION);
		this.#inventory = options.inventory;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#maxExpiryPages = options.maxExpiryPages ?? MAX_EXPIRY_PAGES;
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
	 * **It completes only while the order is `expired`.** `releaseAdopted` is already
	 * order-scoped and cannot touch another order's hold, so the guard is not what
	 * makes it safe — it is what keeps a stale intent from returning units under an
	 * order that has since been paid (a settle racing a sweep), which
	 * `releaseAdopted` would happily do while the hold is still adopted by this very
	 * order. Stamp-only on any other state.
	 */
	async completeHoldRelease(orderId: OrderId): Promise<HoldCompletionResult> {
		const doc = await this.#orders.get(orderId);
		const intent = doc === null ? null : (doc.holdsReleased ?? null);
		if (doc === null || !isOutstanding(intent) || intent === null) {
			return { completed: false, lost: [] };
		}
		if (doc.state === "expired") {
			for (const reservationId of intent.reservationIds) {
				await this.#inventory.releaseAdopted(reservationId, orderId);
			}
		}
		await this.#stampIntent(orderId, "holdsReleased");
		return { completed: true, lost: [] };
	}

	// -- INC-B3: refunds, reconciliation resolution, fulfillment, cancellation --

	getCapturedPayments(_orderId: OrderId): Promise<CapturedPayment[]> {
		throw new NotImplementedInIncrementError("getCapturedPayments", "INC-B3");
	}

	listRefunds(_orderId: OrderId): Promise<RefundRecord[]> {
		throw new NotImplementedInIncrementError("listRefunds", "INC-B3");
	}

	getRefundByIdempotencyKey(_key: IdempotencyKey): Promise<RefundRecord | null> {
		throw new NotImplementedInIncrementError("getRefundByIdempotencyKey", "INC-B3");
	}

	recordRefund(_input: RecordRefundInput): Promise<RecordRefundStoreResult> {
		throw new NotImplementedInIncrementError("recordRefund", "INC-B3");
	}

	reserveRefund(_input: RecordRefundInput): Promise<RecordRefundStoreResult> {
		throw new NotImplementedInIncrementError("reserveRefund", "INC-B3");
	}

	finalizeRefund(_input: FinalizeRefundInput): Promise<FinalizeRefundStoreResult> {
		throw new NotImplementedInIncrementError("finalizeRefund", "INC-B3");
	}

	voidRefund(_idempotencyKey: IdempotencyKey): Promise<boolean> {
		throw new NotImplementedInIncrementError("voidRefund", "INC-B3");
	}

	markRefundUnverified(_idempotencyKey: IdempotencyKey): Promise<boolean> {
		throw new NotImplementedInIncrementError("markRefundUnverified", "INC-B3");
	}

	resolveReconciliation(
		_input: ResolveReconciliationInput,
	): Promise<ResolveReconciliationStoreResult> {
		throw new NotImplementedInIncrementError("resolveReconciliation", "INC-B3");
	}

	recordFulfillment(_input: RecordFulfillmentInput): Promise<RecordFulfillmentStoreResult> {
		throw new NotImplementedInIncrementError("recordFulfillment", "INC-B3");
	}

	cancelOrder(_input: CancelOrderInput): Promise<CancelOrderStoreResult> {
		throw new NotImplementedInIncrementError("cancelOrder", "INC-B3");
	}

	// -- INC-B4: lists, search, the customer view, the outbox lease ------------

	listForCustomer(_customerId: CustomerId): Promise<Order[]> {
		throw new NotImplementedInIncrementError("listForCustomer", "INC-B4");
	}

	listOrders(_filter: OrderListFilter, _page: OrderListPage): Promise<OrderListResult> {
		throw new NotImplementedInIncrementError("listOrders", "INC-B4");
	}

	countOrders(_filter: OrderListFilter): Promise<number> {
		throw new NotImplementedInIncrementError("countOrders", "INC-B4");
	}

	linkGuestOrders(_customerId: CustomerId, _buyerRef: string): Promise<number> {
		throw new NotImplementedInIncrementError("linkGuestOrders", "INC-B4");
	}

	claimNextEmail(_now: string, _leaseUntil: string): Promise<OutboxEmail | null> {
		throw new NotImplementedInIncrementError("claimNextEmail", "INC-B4");
	}

	markEmailSent(_id: string, _now: string): Promise<void> {
		throw new NotImplementedInIncrementError("markEmailSent", "INC-B4");
	}

	rescheduleEmail(_id: string, _retryAt: string | null): Promise<void> {
		throw new NotImplementedInIncrementError("rescheduleEmail", "INC-B4");
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
			// R3: the fallback value. `linkGuestOrders` (INC-B4) rewrites it.
			customerKey: customerKeyFor(null, input.buyerRef),
			// INC-B4 fills both; declared now so the collection is never reshaped.
			searchKey: null,
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
		await this.#terminalizeKey(key, prepared.orderId);
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
		return doc === null ? null : toOrder(normalizeOrderDoc(doc));
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
				...doc,
				state: input.toState,
				updatedAt: now,
				// Append-only audit, in THIS write: a row exists iff the flip won.
				events: [
					...doc.events,
					{
						id: this.#idGen.newId(),
						at: now,
						kind: "state_change",
						fromState: input.fromState,
						toState: input.toState,
						actor: input.actor ?? null,
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
									createdAt: now,
								},
							]
						: doc.emailOutbox,
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
			return written.applied ? casDone<FlipOutcome>({ won: true, doc: next }) : CAS_RETRY;
		});
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
	async #noteReleaseFailure(orderId: OrderId, cause: unknown): Promise<void> {
		const detail = cause instanceof Error ? cause.message : String(cause);
		try {
			await this.flagReconciliation(
				orderId,
				`expiry released no holds: ${detail} — the release intent is still outstanding`,
			);
		} catch {
			// Deliberately swallowed: see the docblock. Never turn a won flip into a throw.
		}
	}

	#casOrder<T>(operation: string, step: (attempt: number) => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}

/** Plain code-unit comparison — never `localeCompare`, so every tier agrees. */
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
