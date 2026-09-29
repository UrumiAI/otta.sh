/**
 * `ReportingStore` over precomputed day documents — the one adapter in this package
 * whose port moved from READ time to WRITE time.
 *
 * The SQL answered `revenueByPeriod` and `ordersByStatus` with one `GROUP BY` over
 * `orders` joined to `order_totals` and `refunds`, with the period bucket as a
 * dialect-branched truncation. A plugin has no join, no aggregate and no raw SQL, so
 * those two reports are served from `reporting_daily` — one document per (currency, UTC
 * day) holding the counters a window folds — and the two reports that CANNOT be
 * precomputed are still computed on read:
 *
 * ```
 * revenueByPeriod  reporting_daily, paged by the `date` range, folded to day/week/month
 * ordersByStatus   reporting_daily, the same scan, folded over `stateCounts`
 * topProducts      a scan of `orders`, over the FROZEN line snapshots
 * lowStock         a scan of `inventory`, titled through the live sku claim
 * ```
 *
 * **Why those two stayed on read.** A per-product-per-day rollup would make the day
 * document grow without bound in the catalogue, and `lowStock` has no window at all —
 * it is a current-state question about stock, which is one scan of a collection that is
 * the size of the sku list. Neither is a counter, so neither gains anything from being
 * written ahead of time.
 *
 * **What a rollup costs, stated honestly.** Reporting becomes work on the write path:
 * every transition and every finalized refund owes a claim and a counter write, and the
 * order store's hook is what pays it (after the order write is durable, and never able
 * to fail it). The counters are DERIVED, so they can drift — a lost event, a crash
 * between the claim and the write — and {@link EmdashReportingStore.reconcile} is the
 * definition they are restored to. That division is deliberate: the delta stream is
 * responsible for never drifting in the dangerous direction, the recompute for
 * eventually being exact (ADR-0019's cross-cutting rule (c)).
 *
 * **The window is EXACT, whatever instants it names.** The day document is the counters
 * for a whole day, so it can only answer for a day the window covers whole: the interior
 * of a window is read from the documents, and an EDGE day the window truncates is
 * computed from an instant-filtered scan of that day's orders instead (at most two such
 * days, and only when a bound is not midnight). `created_at BETWEEN from AND to`
 * therefore means the same thing here as it did in the statement this replaced, and a
 * ragged window costs two bounded scans rather than an approximation.
 */
import {
	cents,
	currency as toCurrency,
	type Clock,
	type DateRange,
	type LowStockRow,
	type PeriodBucket,
	type ReportInterval,
	type ReportingStore,
	type StatusCount,
	type TopProduct,
	type TopProductsMetric,
} from "@otta-sh/domain";
import { CAS_RETRY, casDone, withCasRetry, type CasRetryOptions } from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import { ScanPageLimitError } from "./errors.js";
import type { InventoryDoc } from "./inventory-documents.js";
import { INVENTORY_COLLECTION } from "./inventory-documents.js";
import type { OrderDoc } from "./order-documents.js";
import { normalizeOrderDoc, ORDERS_COLLECTION } from "./order-documents.js";
import type { ProductCommerceDoc, SkuOwnerDoc } from "./product-commerce-documents.js";
import {
	PRODUCT_COMMERCE_COLLECTION,
	SKU_OWNERS_COLLECTION,
} from "./product-commerce-documents.js";
import {
	addAggregate,
	bucketStartOf,
	dayEndOf,
	dayKeyOf,
	dayKeysBetween,
	dayStartOf,
	FINALIZED_REFUND_STATUS,
	hasReportingDailyGuards,
	isCurrentReportingDailyDoc,
	isHybridReportingDailyDoc,
	newReportingDailyDoc,
	normalizeReportingDailyDoc,
	normalizeStateCounts,
	REPORTING_APPLIED_COLLECTION,
	REPORTING_DAILY_COLLECTION,
	reportingDailyDocId,
	reportingRefundClaimId,
	reportingTransitionClaimId,
	isAbsorbed,
	REVENUE_STATES,
	stateCountField,
	storedStateCounts,
	toStoredReportingDailyDoc,
	type CurrentReportingDailyDoc,
	type ReportingAppliedDoc,
	type ReportingDailyDoc,
	type ReportingDailyStoredDoc,
	type ReportingOrderEvent,
} from "./reporting-documents.js";
import type {
	NumericDelta,
	StorageAccess,
	StorageCollection,
	Versioned,
	WhereClause,
} from "./storage-access.js";

/** The host clamps `limit` at 100, so that is the page every scan here reads. */
const PAGE_SIZE = 100;

/**
 * The separator that joins two values into one grouping key.
 *
 * Written as the ESCAPE, never as a literal control character: a raw one in the source
 * makes ripgrep and every diff viewer treat the whole file as binary, which silently
 * hides it from the searches a reader would actually use to find it. It is `\u0000`
 * rather than a printable character because a title may legitimately contain any of
 * those, and a separator a value can spell would merge two groups into one.
 */
const KEY_SEP = "\u0000";

/** Page ceiling for one report read. A year of daily buckets is four pages. */
const MAX_REPORT_PAGES = 1000;

/**
 * Page ceiling for one recompute, PER DAY rather than per call.
 *
 * Per day because a recompute's cost is a property of the day: every day costs at least
 * the page that lists its documents plus one page of orders, so a per-call budget would
 * refuse a long range on VOLUME — a 400-day range would trip a 1000-page ceiling with
 * nothing wrong — and the number that matters is how many orders one day can hold.
 */
const MAX_RECONCILE_PAGES = 1000;

export interface EmdashReportingStoreOptions {
	/** The collections the descriptor declared (`REPORTING_COLLECTIONS` and the
	 *  order, inventory and product-commerce collections the reads reach). */
	storage: StorageAccess;
	/** Stamps the day document's `updatedAt` and each claim's timestamps. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/** Page ceiling for a report read. Raise it for a window wider than the budget. */
	maxReportPages?: number;
	/**
	 * Budget ceiling for one day's recompute, PER DAY and per attempt. Raised independently
	 * of the read budget: the two are bounded by different things (documents versus orders).
	 *
	 * One day's attempt spends one unit per page of orders, one per page of that day's
	 * claims, and one per claim it has to absorb. So the ceiling is a function of how many
	 * claims an order carries — an order accumulates one per transition and one per
	 * finalized refund — and not of the order count alone.
	 *
	 * At the default of 1000, and for a day whose claims are already absorbed (the steady
	 * state, and every closed day after its first heal), the cost is
	 * `orders/100 + claims/100` units: at about two claims per order that clears roughly
	 * 30,000 orders in a day, and an order history with more claims each lowers it
	 * proportionally. A day being healed from nothing pays a unit per claim as well, which
	 * is where the real limit sits — a few hundred orders' worth of first-time absorption
	 * per call. Raise this, or chunk the range, for a day bigger than that.
	 */
	maxReconcilePages?: number;
	/**
	 * Where this adapter reports evidence of DRIFT — today, a counter that a decrement
	 * would have driven below zero.
	 *
	 * Flooring is not a defensive nicety: it means a decrement arrived whose matching
	 * increment is not in the document, so something was lost. The floor keeps the report
	 * from showing a negative revenue, and this observer is what keeps it from being
	 * silent. An operator seeing it should run a recompute over the day.
	 */
	onAnomaly?: (anomaly: ReportingAnomaly) => void;
}

/**
 * Evidence that the counters have drifted from the orders. An operator seeing either kind
 * should run a recompute over the day.
 *
 * - `floored`: a decrement would have driven a counter below zero, so its matching
 *   increment is missing. The counter was floored at zero.
 * - `tainted`: a live event found the day document rewritten by an OLDER version of this
 *   adapter (a mixed-version deploy or a rollback; see `isHybridReportingDailyDoc`), and
 *   un-tainted it before applying. Whatever that writer's rewrite discarded is still
 *   missing until a recompute restores it.
 */
export type ReportingAnomaly =
	| {
			kind: "floored";
			/** Which counter the decrement would have driven negative. */
			counter: string;
			/** The day document it happened on. */
			docId: string;
			orderId: string;
			/** What the counter held, and what the decrement asked for. */
			held: number;
			delta: number;
	  }
	| {
			kind: "tainted";
			/** The day document it happened on. */
			docId: string;
			/** The order whose event found it. */
			orderId: string;
			/** The guards the tainted document carried when it was found. */
			epoch: number;
			seq: number;
	  };

/** What a recompute did — the numbers a scheduled sweep logs. */
export interface ReportingReconcileResult {
	/** How many UTC days the range covered. */
	days: number;
	/** How many day documents were actually rewritten (an already-exact one is not). */
	documentsWritten: number;
	/** How many orders the recompute read. */
	ordersScanned: number;
	/** How many claims it absorbed — created or stamped, having counted their events. */
	claimsAbsorbed: number;
}

/** A paging budget shared by every scan inside one call. */
interface PageBudget {
	readonly limit: number;
	used: number;
	scanned: number;
	readonly option: string;
}

export class EmdashReportingStore implements ReportingStore {
	readonly #daily: StorageCollection<ReportingDailyStoredDoc>;
	readonly #applied: StorageCollection<ReportingAppliedDoc>;
	readonly #orders: StorageCollection<OrderDoc>;
	readonly #inventory: StorageCollection<InventoryDoc>;
	readonly #products: StorageCollection<ProductCommerceDoc>;
	readonly #skuOwners: StorageCollection<SkuOwnerDoc>;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxReportPages: number;
	readonly #maxReconcilePages: number;
	readonly #onAnomaly: (anomaly: ReportingAnomaly) => void;

	constructor(options: EmdashReportingStoreOptions) {
		this.#daily = collectionOf<ReportingDailyStoredDoc>(
			options.storage,
			REPORTING_DAILY_COLLECTION,
		);
		this.#applied = collectionOf<ReportingAppliedDoc>(
			options.storage,
			REPORTING_APPLIED_COLLECTION,
		);
		this.#orders = collectionOf<OrderDoc>(options.storage, ORDERS_COLLECTION);
		this.#inventory = collectionOf<InventoryDoc>(options.storage, INVENTORY_COLLECTION);
		this.#products = collectionOf<ProductCommerceDoc>(options.storage, PRODUCT_COMMERCE_COLLECTION);
		this.#skuOwners = collectionOf<SkuOwnerDoc>(options.storage, SKU_OWNERS_COLLECTION);
		this.#clock = options.clock;
		this.#maxReportPages = options.maxReportPages ?? MAX_REPORT_PAGES;
		this.#maxReconcilePages = options.maxReconcilePages ?? MAX_RECONCILE_PAGES;
		this.#onAnomaly = options.onAnomaly ?? (() => undefined);
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
	}

	// -- the write surface ------------------------------------------------------

	/**
	 * Fold one order event into the day document the order was CREATED in.
	 *
	 * Two documents, in this order and for this reason:
	 *
	 * ```
	 * epoch    reporting_daily/{currency}:{day} read (created or migrated if need be)
	 * claim    reporting_applied/{claim} create-if-absent — the once-only gate
	 * counters reporting_daily/{currency}:{day} ONE guarded numeric delta — the value
	 * stamp    the claim's `appliedAt`, best-effort, as a diagnostic
	 * ```
	 *
	 * **The counters are one statement, not a read-modify-write loop.** Every order
	 * created on a day in a currency shares one document, so a compare-and-set here made
	 * every checkout that day contend with every other one, and nothing ever refused a
	 * writer: retry depth grew with the crowd until the typed contention error, and each
	 * checkout paid the backoff inline. The delta is `updateIf` with the arithmetic done
	 * in SQL, which the database serializes on the row lock instead of refusing, so a
	 * busy day costs each event one write however many peers it has.
	 *
	 * **Why the epoch is read BEFORE the claim is made.** The delta is guarded on that
	 * epoch, and a recompute bumps it when it commits. So if a recompute counts this event
	 * absolutely (which it can only do after the claim exists, and it absorbs the claim to
	 * say so) and commits before the delta lands, the delta is refused in the same statement
	 * that would have double-counted, and re-checks its claim. See {@link #applyEvent}.
	 *
	 * **The claim is first, so the residue is an under-count.** A crash between the two
	 * leaves an event spent and its counters unmoved: the report says less revenue than
	 * came in and leaves the order in the state bucket it has already left, and
	 * {@link reconcile} repairs it. The other order — counters first — would leave an
	 * event unclaimed whose delta had already landed, and its redelivery would count the
	 * same money twice. Between an under-count that heals and an over-count that
	 * compounds, this tier resolves toward the first every time.
	 *
	 * **A transition MOVES an order between buckets.** The state it leaves is
	 * decremented and the state it enters incremented, and revenue follows the same
	 * rule through the allow-list — which is why the event carries the order's net
	 * total: leaving `paid` for `refunded` has to take that number back out. A refund is
	 * not a transition and is not driven by one: it adds to the day's refunded total
	 * whatever the order's state is, which is what makes a fully refunded order's money
	 * reportable at all.
	 *
	 * Calling it twice is calling it once. A second delivery finds the claim and returns
	 * without a write.
	 */
	async recordOrderEvent(event: ReportingOrderEvent): Promise<void> {
		const claimId = claimIdFor(event);
		// The fast path: a spent event costs one read and nothing else.
		if ((await this.#applied.get(claimId)) !== null) return;

		const day = dayKeyOf(event.orderCreatedAt);
		const now = this.#clock.now().toISOString();
		const docId = reportingDailyDocId(event.currency, day);
		// Read (creating or migrating the document if it must) BEFORE the claim: the epoch
		// in hand has to predate the claim check the delta is relying on.
		const snapshot = await this.#currentDay(docId, event, day, now, null);
		const claim: ReportingAppliedDoc = {
			orderId: event.orderId,
			kind: event.kind,
			date: day,
			currency: event.currency,
			fromState: event.kind === "transition" ? event.fromState : null,
			toState: event.kind === "transition" ? event.toState : null,
			refundId: event.kind === "refund" ? event.refundId : null,
			amountCents: event.kind === "refund" ? event.refundedCents : null,
			claimedAt: now,
			appliedAt: null,
			absorbedAt: null,
		};
		const created = await this.#applied.compareAndSet(claimId, null, claim);
		// A refused create means a peer holds this event. Its delta is that caller's to
		// apply, and applying it here as well is precisely the double count the claim
		// exists to prevent.
		if (!created.applied) return;

		if (!(await this.#applyEvent(event, docId, day, claimId, snapshot, now))) return;

		// The stamp is a DIAGNOSTIC and never a gate (see `ReportingAppliedDoc`): it is
		// what makes a claim-only residue legible. A lost stamp changes no answer, so the
		// result is not inspected — and a recompute that absorbed this claim in the
		// meantime is exactly such a loss.
		await this.#applied.compareAndSet(claimId, created.revision, { ...claim, appliedAt: now });
	}

	/**
	 * Move the day document's counters: ONE guarded numeric delta, retried only when its
	 * guard genuinely failed.
	 *
	 * The write is `updateIf` guarded on the `epoch` read before the claim was last
	 * checked, plus a floor guard per decremented counter, and it bumps `seq`:
	 *
	 * - **A peer's delta never refuses it.** Deltas do not guard on each other at all;
	 *   the database applies them one after another on the row lock. That is the whole
	 *   point: the crowd costs nothing but lock queueing, and the retry depth is 1.
	 * - **A recompute's commit does.** It bumps `epoch`, so a delta computed against a
	 *   claim the recompute has since absorbed is refused atomically rather than applied
	 *   on top of an absolute count. ADR-0019's cross-cutting rule (a) (the right to write
	 *   is re-asserted before every write it guards) is kept, and tightened: the old loop
	 *   re-read the claim and then wrote in a separate statement, while here the check and
	 *   the write are one statement. When the epoch has moved, the claim is re-read and the
	 *   delta dropped if it was absorbed.
	 * - **A floor guard failing means drift.** A decrement whose counter is below it has
	 *   lost its matching increment; the plan is recomputed from a fresh read and the
	 *   counter floored at zero (announced through `onAnomaly`), as before.
	 *
	 * The retry budget therefore only ever runs on a recompute committing mid-flight or
	 * on drift, never on the crowd. Returns whether the delta was applied, so the caller
	 * knows whether the `appliedAt` stamp still means anything.
	 */
	async #applyEvent(
		event: ReportingOrderEvent,
		docId: string,
		day: string,
		claimId: string,
		first: CurrentReportingDailyDoc,
		now: string,
	): Promise<boolean> {
		let snapshot = first;
		// Whether the epoch in hand is newer than the last claim check. The first attempt's
		// epoch was read before the claim was created, so it needs none.
		let recheck = false;
		return withCasRetry<boolean>(
			"recordReportingEvent",
			async () => {
				if (recheck) {
					const claim = await this.#applied.get(claimId);
					if (claim !== null && isAbsorbed(claim)) return casDone(false);
					recheck = false;
				}
				const plan = planDelta(snapshot, event);
				const written = await this.#daily.updateIf(docId, {
					where: { ...plan.where, epoch: snapshot.epoch },
					set: { updatedAt: now },
					delta: { ...plan.delta, seq: { inc: 1 } },
				});
				if (written.applied) {
					for (const anomaly of plan.floored) {
						this.#onAnomaly({ ...anomaly, docId, orderId: event.orderId });
					}
					return casDone(true);
				}
				// Refused: a recompute committed (the epoch moved), or a floor guard failed.
				// Re-read to find out which, and plan again against what is there now. The
				// epoch only increases (outside a mixed-version window, see
				// `ReportingDailyStoredDoc`), so an unchanged one proves no recompute committed
				// since the claim was last checked, and that check still stands. The epoch in
				// hand is passed down so a migration or un-taint moves past it.
				const next = await this.#currentDay(docId, event, day, now, snapshot.epoch);
				if (next.epoch !== snapshot.epoch) recheck = true;
				snapshot = next;
				return CAS_RETRY;
			},
			this.#retry,
		);
	}

	/**
	 * The day document in its CURRENT shape, creating it, migrating a legacy one forward,
	 * or un-tainting a hybrid one first if it has to.
	 *
	 * The create and the migration are revision compare-and-sets, so both are race-safe: a
	 * create-if-absent can only lose to a peer that created the document, and a migration
	 * only to a peer that moved it (another migration, or a recompute rewriting it), and in
	 * both cases the next read finds the current shape. No delta lands on a legacy
	 * document, since a delta is guarded on `epoch`, so the migration's revision cannot
	 * miss one. Once a document is current, this is one read.
	 *
	 * **A hybrid (tainted) document is un-tainted, never recomputed here.** This runs on the
	 * checkout, settle and refund path, once per event, so a day recompute here would be N
	 * concurrent full-day scans fighting over the same claims and commit, and a day past the
	 * page budget would refuse every event on it. Instead ONE `updateIf` guarded on the
	 * `epoch` and `seq` just read clears the nested map and moves the epoch, and the event
	 * proceeds against the flat fields, which are authoritative (see
	 * `isHybridReportingDailyDoc`). Moving the epoch makes any delta parked across the
	 * un-taint re-check its claim. What the old writer discarded stays missing, which is
	 * the under-count residue `reconcile` heals, and `onAnomaly` says so.
	 *
	 * `knownEpoch` is the highest epoch the caller has already seen on this document (the
	 * delta path's snapshot on a retry), or `null`. A migration or un-taint writes an epoch
	 * past both it and the one it read, so the epoch does not move backwards past anything
	 * this writer relied on, even when an older writer has rewound it.
	 */
	async #currentDay(
		docId: string,
		event: ReportingOrderEvent,
		day: string,
		now: string,
		knownEpoch: number | null,
	): Promise<CurrentReportingDailyDoc> {
		return withCasRetry<CurrentReportingDailyDoc>(
			"ensureReportingDay",
			async () => {
				const held = await this.#daily.getVersioned(docId);
				if (held !== null && isCurrentReportingDailyDoc(held.value)) return casDone(held.value);
				if (
					held !== null &&
					hasReportingDailyGuards(held.value) &&
					isHybridReportingDailyDoc(held.value)
				) {
					const tainted = held.value;
					const untainted = await this.#daily.updateIf(docId, {
						where: { epoch: tainted.epoch, seq: tainted.seq },
						// `updateIf` can set a field but not remove one, so the map is set to null,
						// which every reader treats as absent.
						set: {
							stateCounts: null,
							epoch: Math.max(tainted.epoch, knownEpoch ?? tainted.epoch) + 1,
							updatedAt: now,
						},
					});
					// A peer moved it first (a delta, another un-taint, a recompute): re-read.
					if (!untainted.applied || !isCurrentReportingDailyDoc(untainted.data)) {
						return CAS_RETRY;
					}
					this.#onAnomaly({
						kind: "tainted",
						docId,
						orderId: event.orderId,
						epoch: tainted.epoch,
						seq: tainted.seq,
					});
					return casDone(untainted.data);
				}
				const epoch = knownEpoch === null ? 0 : knownEpoch + 1;
				const next = toStoredReportingDailyDoc(
					held === null
						? newReportingDailyDoc(event.currency, day, now)
						: { ...normalizeReportingDailyDoc(held.value), updatedAt: now },
					epoch,
					0,
				);
				const written = await this.#daily.compareAndSet(docId, held?.revision ?? null, next);
				return written.applied ? casDone(next) : CAS_RETRY;
			},
			this.#retry,
		);
	}

	/**
	 * Recompute every day document in the range from the ORDERS, and absorb the claims
	 * for the events it folded in.
	 *
	 * This is the routine a periodic heal runs, and it is the definition the delta stream
	 * is a cache of: a day's counters are whatever a scan of the orders created that day
	 * says they are.
	 *
	 * **It is safe to run while events are landing, and three things make it so.** They
	 * are stated in the order the code does them, because the order is the argument:
	 *
	 * 1. **Pin before scanning.** Every day document this attempt may write has its guards
	 *    (`epoch`, `seq`; the revision for a legacy or absent one) read BEFORE the orders
	 *    are scanned, and the commit is guarded on them. Any delta that lands after that
	 *    bumps `seq`, so the commit is refused and the whole day is re-scanned. Reading the
	 *    orders first and pinning afterwards would do the opposite: a transition landing in
	 *    between would be committed away, because the value in hand predates it and the
	 *    pin would not say so. (The pin cannot be the revision here: the host's `updateIf`
	 *    never moves it, so it would not see a delta at all.)
	 * 2. **Absorb the claims the scan folded in, before committing.** A claim is the
	 *    right to move these counters; once a recompute has counted the event
	 *    absolutely, that right is spent, and `absorbedAt` is how the claim says so. The
	 *    claims absorbed are exactly the ones RECONSTRUCTED from the scanned orders —
	 *    never every claim an order has — because a claim whose transition is not in the
	 *    scanned document describes something the recompute did not count, and absorbing
	 *    that one would drop its delta.
	 * 3. **The commit bumps `epoch`, and every delta is guarded on the epoch it read
	 *    before its claim was checked** (`#applyEvent`). So an event whose order this
	 *    recompute already counted, and whose own delta had not landed yet, is refused by
	 *    the delta's own statement, re-reads its claim, and becomes a SKIP rather than a
	 *    second increment. That is why a commit bumps the epoch even over an exact document
	 *    when the attempt absorbed claims.
	 *
	 * What is left is one residue, and it is in the safe direction: a transition that
	 * lands after the scan read its order but before the absorb reaches its claim is
	 * absorbed without having been counted, and its delta is then skipped — an
	 * UNDER-count, healed by the next run. A process that dies between the absorb and the
	 * commit leaves the same shape. Neither can double-count, because nothing here ever
	 * applies a delta whose claim is absorbed.
	 *
	 * A failed attempt can leave claims absorbed that this attempt never committed
	 * counters for; the next successful run absorbs nothing new and commits the absolute
	 * value, which lifts them. That is the same under-counting residue in another dress,
	 * and it is why a CLOSED day is the cheap and safe thing to reconcile: yesterday and
	 * older have no live events to race, so an attempt cannot lose its pin. **Reconcile a
	 * closed day as a matter of course, and a live day only on demand** — a live day's
	 * events are still arriving, so a recompute over it is a race it may have to re-run.
	 *
	 * The page budget is per DAY, so a long range is safe by construction; a caller
	 * sweeping a large history should still chunk it (a month at a time keeps one call's
	 * work, and one call's retries, bounded).
	 */
	async reconcile(range: DateRange): Promise<ReportingReconcileResult> {
		const fromDay = dayKeyOf(range.from);
		const toDay = dayKeyOf(range.to);
		const days = dayKeysBetween(fromDay, toDay);
		let documentsWritten = 0;
		let claimsAbsorbed = 0;
		let ordersScanned = 0;
		for (const day of days) {
			const done = await this.#reconcileDay(day);
			documentsWritten += done.written;
			claimsAbsorbed += done.claims;
			ordersScanned += done.scanned;
		}
		return { days: days.length, documentsWritten, ordersScanned, claimsAbsorbed };
	}

	/** One day, recomputed: pin, scan, absorb, commit. See `reconcile` for the order. */
	async #reconcileDay(day: string): Promise<{
		written: number;
		claims: number;
		scanned: number;
	}> {
		return withCasRetry<{ written: number; claims: number; scanned: number }>(
			"reconcileReportingDay",
			async () => {
				// A FRESH budget per attempt: a budget carried across attempts would spend a
				// re-scan's pages against the same ceiling and refuse a day that is well
				// inside it, and would report a scan count that counts the same orders twice.
				const budget: PageBudget = {
					limit: this.#maxReconcilePages,
					used: 0,
					scanned: 0,
					option: "maxReconcilePages",
				};
				const now = this.#clock.now().toISOString();

				// 1. PIN: the currencies this day already has, and each document's value (whose
				//    `epoch` and `seq` are the pin) and revision, read before anything is scanned.
				//    One read serves as both, so the "already exact" short-circuit below and the
				//    pin agree on ONE snapshot — re-reading the document there would let a commit be skipped
				//    against a value newer than the one this attempt is pinned to.
				// The per-currency pin reads are deliberately EXEMPT from the budget: there is one
				// per currency the day holds, which is the store's currency count and not a
				// function of its traffic, so charging them would buy nothing but noise.
				const pinned = new Map<string, Versioned<ReportingDailyStoredDoc> | null>();
				for (const currency of await this.#dayCurrencies(day, budget)) {
					pinned.set(currency, await this.#daily.getVersioned(reportingDailyDocId(currency, day)));
				}

				// 2. SCAN.
				const orders = await this.#scanOrders(
					{ createdAt: { gte: dayStartOf(day), lte: dayEndOf(day) } },
					budget,
					"reconcileReporting",
				);
				const computed = computeDay(day, orders, now);

				// 3. ABSORB, before a single counter is committed.
				const absorbed = await this.#absorbDayClaims(day, orders, budget, now);
				// A claim moved under us — a peer created or stamped one between the read and
				// the write — so this day's premises are stale. Re-run it.
				if (absorbed === "retry") return CAS_RETRY;

				// 4. COMMIT, each document against what was pinned in step 1.
				let written = 0;
				for (const currency of [...new Set([...computed.keys(), ...pinned.keys()])].toSorted()) {
					const docId = reportingDailyDocId(currency, day);
					// A currency the scan found that the pin did not see is a create-if-absent:
					// `null` is a real pin, and a peer creating it first loses this commit.
					const held = pinned.get(currency) ?? null;
					// A day that has lost every order keeps a ZEROED document rather than being
					// deleted: a live event racing this write needs a guard to lose to, and
					// an all-zero document is read as no bucket at all.
					const target = {
						...(computed.get(currency) ?? newReportingDailyDoc(currency, day, now)),
						updatedAt: now,
					};
					const exact =
						held !== null && sameCounters(normalizeReportingDailyDoc(held.value), target);
					// An exact document is left alone unless this attempt absorbed claims. Then
					// the epoch is still bumped, so a delta that passed its claim check before the
					// absorb, and has not landed yet, is refused rather than applied on top.
					// A tainted (hybrid) document is always rewritten: its counters may agree by
					// accident, but its nested map has to go.
					const tainted = held !== null && isHybridReportingDailyDoc(held.value);
					if (exact && absorbed.claims === 0 && !tainted) continue;
					const applied = await this.#commitDay(docId, held, target);
					// A peer moved this day after it was pinned. Re-scan: the value in hand was
					// derived from an older snapshot of the orders.
					if (!applied) return CAS_RETRY;
					if (!exact || tainted) written++;
				}

				return casDone({ written, claims: absorbed.claims, scanned: budget.scanned });
			},
			this.#retry,
		);
	}

	/**
	 * Commit a recomputed day document against its pin, bumping the epoch.
	 *
	 * - **Absent at the pin:** a create-if-absent, which a peer's creation refuses.
	 * - **Legacy at the pin:** a revision compare-and-set that writes the current shape.
	 *   No delta lands on a legacy document, so the revision sees every peer that could
	 *   have moved it.
	 * - **Current at the pin:** `updateIf` guarded on the pinned `epoch` AND `seq`. A delta
	 *   never moves the revision (the host's `updateIf` leaves it alone), so the revision
	 *   cannot be the pin. `seq` moves on every delta, so any delta landing after the pin
	 *   refuses the commit, and `epoch` moves on every commit, so two recomputes pinned to
	 *   the same value cannot both win. Every state field the pinned document carried is
	 *   written, zeroed if the recompute no longer counts it; since `seq` proves nothing
	 *   landed in between, those are all the fields there are.
	 */
	async #commitDay(
		docId: string,
		held: Versioned<ReportingDailyStoredDoc> | null,
		target: ReportingDailyDoc,
	): Promise<boolean> {
		if (held === null || !hasReportingDailyGuards(held.value)) {
			const epoch = held === null ? 1 : 1 + (held.value.epoch ?? 0);
			const written = await this.#daily.compareAndSet(
				docId,
				held?.revision ?? null,
				toStoredReportingDailyDoc(target, epoch, 0),
			);
			return written.applied;
		}
		const pinned = held.value;
		const next = toStoredReportingDailyDoc(target, pinned.epoch + 1, pinned.seq);
		for (const state of Object.keys(storedStateCounts(pinned))) {
			const field = stateCountField(state);
			next[field] ??= 0;
		}
		const { currency: _currency, date: _date, seq: _seq, ...set } = next;
		const written = await this.#daily.updateIf(docId, {
			where: { epoch: pinned.epoch, seq: pinned.seq },
			// Clearing the nested map is what un-taints a hybrid (`updateIf` can set a field
			// but not remove one, so it is set to null). Harmless on a current document.
			set: isHybridReportingDailyDoc(pinned) ? { ...set, stateCounts: null } : set,
		});
		return written.applied;
	}

	/**
	 * Absorb the claims a day's scanned orders PROVE, as pages of one indexed read.
	 *
	 * The shape matters as much as the effect. A read per reconstructed event would be a
	 * round trip per transition an order has ever made, every attempt and every sweep, and
	 * every one of them widens the window in which a live delta invalidates the pin — a
	 * busy day could spend the whole retry budget losing that race, and each failed attempt
	 * leaves absorbed-but-uncommitted claims behind, which deepens the very under-count the
	 * recompute is there to lift. A query PER ORDER is the same mistake one step up: it
	 * makes the cost a function of how many orders the day holds, so a large day exhausts
	 * its budget and can never heal.
	 *
	 * So a day's claims are read by the axis they are filed under — `date`, which is the
	 * order's creation day and therefore the day being recomputed — and the pass costs **one
	 * unit per claim-index page and one unit per claim absorbed**, the same unit a page of
	 * orders costs. A claim an earlier run already absorbed costs neither: it is skipped
	 * before any spend and before any write, which is what makes a steady-state recompute
	 * cheap and a first heal the only expensive one.
	 *
	 * A budget refusal from this pass is a `ScanPageLimitError` naming operation
	 * `absorbReportingClaims` and option `maxReconcilePages` — the pair an operator sees, and
	 * the reason the two are worth stating together: the operation says it was the CLAIMS
	 * rather than the orders that ran the budget out, while the option is the same knob
	 * either way.
	 */
	async #absorbDayClaims(
		day: string,
		orders: OrderDoc[],
		budget: PageBudget,
		now: string,
	): Promise<{ claims: number } | "retry"> {
		// The day's claims, as pages of ONE indexed query. A query per order would make the
		// cost a function of the day's ORDER COUNT rather than of its size, and a day past a
		// few hundred orders would then exhaust its budget and never heal again.
		const present = new Map<string, ReportingAppliedDoc>();
		let cursor: string | undefined;
		for (;;) {
			this.#spend(budget, "absorbReportingClaims", present.size);
			const page = await this.#applied.query({ where: { date: day }, limit: PAGE_SIZE, cursor });
			for (const { id, data } of page.items) present.set(id, data);
			if (!page.hasMore || page.cursor === undefined) break;
			cursor = page.cursor;
		}

		let claims = 0;
		for (const event of reconstructEvents(orders)) {
			const claimId = claimIdFor(event);
			const seen = present.get(claimId);
			// Already absorbed by an earlier run — nothing to pay and nothing to write.
			if (seen !== undefined && isAbsorbed(seen)) continue;
			// `present.size` in both of this pass's refusals, so the number in the error means
			// one thing: how many of the day's claims had been read when the budget ran out.
			this.#spend(budget, "absorbReportingClaims", present.size);
			const outcome = await this.#absorbClaim(event, claimId, now);
			if (outcome === "retry") return "retry";
			if (outcome === "absorbed") claims++;
		}
		return { claims };
	}

	/**
	 * Absorb one reconstructed event's claim: the recompute has counted it absolutely, so
	 * no delta for it may ever move these counters again.
	 *
	 * Creating the claim when it is absent is what makes a rollup collection restored from
	 * nothing safe to run events against: the event is already counted, so its redelivery
	 * must find a claim that says so. A LOST create is not a failure — it means a live
	 * event claimed this id a moment ago — so the claim is re-read and absorbed in place;
	 * `"retry"` is reserved for a guarded write that lost against a revision that moved,
	 * which is the case where this day's premises really have changed underneath it.
	 */
	async #absorbClaim(
		event: ReportingOrderEvent,
		claimId: string,
		now: string,
	): Promise<"absorbed" | "already" | "retry"> {
		const held = await this.#applied.getVersioned(claimId);
		if (held === null) {
			const created = await this.#applied.compareAndSet(claimId, null, {
				orderId: event.orderId,
				kind: event.kind,
				date: dayKeyOf(event.orderCreatedAt),
				currency: event.currency,
				fromState: event.kind === "transition" ? event.fromState : null,
				toState: event.kind === "transition" ? event.toState : null,
				refundId: event.kind === "refund" ? event.refundId : null,
				// DIAGNOSTIC only on a reconstructed claim: the amount is read back off the
				// order's own ledger, and nothing recomputes from the claim.
				amountCents: event.kind === "refund" ? event.refundedCents : null,
				claimedAt: now,
				appliedAt: now,
				absorbedAt: now,
			});
			if (created.applied) return "absorbed";
			// A live event won the id between the read and the create. Its claim is what must
			// carry the marker, so absorb THAT one rather than re-running the whole day.
			const live = await this.#applied.getVersioned(claimId);
			if (live === null) return "retry";
			return this.#stampAbsorbed(claimId, live, now);
		}
		if (isAbsorbed(held.value)) return "already";
		return this.#stampAbsorbed(claimId, held, now);
	}

	/** Mark one claim absorbed at the revision just read. */
	async #stampAbsorbed(
		claimId: string,
		held: Versioned<ReportingAppliedDoc>,
		now: string,
	): Promise<"absorbed" | "already" | "retry"> {
		if (isAbsorbed(held.value)) return "already";
		const marked = await this.#applied.compareAndSet(claimId, held.revision, {
			...held.value,
			appliedAt: held.value.appliedAt ?? now,
			absorbedAt: now,
		});
		return marked.applied ? "absorbed" : "retry";
	}

	/** Spend one budget unit, or refuse loudly. The unit is one storage round trip. */
	#spend(budget: PageBudget, operation: string, collected: number): void {
		if (budget.used >= budget.limit) {
			throw new ScanPageLimitError(operation, budget.limit, collected, budget.option);
		}
		budget.used++;
	}

	// -- the read surface ------------------------------------------------------

	async revenueByPeriod(range: DateRange, interval: ReportInterval): Promise<PeriodBucket[]> {
		const groups = new Map<
			string,
			{
				bucketStart: string;
				currency: string;
				revenueOrders: number;
				revenueCents: number;
				refundEntries: number;
				refundedCents: number;
			}
		>();
		for (const doc of await this.#windowDays(range, "revenueByPeriod")) {
			const bucketStart = bucketStartOf(doc.date, interval);
			const key = `${bucketStart}${KEY_SEP}${doc.currency}`;
			const group = groups.get(key) ?? {
				bucketStart,
				currency: doc.currency,
				revenueOrders: 0,
				revenueCents: 0,
				refundEntries: 0,
				refundedCents: 0,
			};
			group.revenueOrders += doc.revenueOrders;
			group.revenueCents = addAggregate(group.revenueCents, doc.revenueCents);
			group.refundEntries += doc.refundEntries;
			group.refundedCents = addAggregate(group.refundedCents, doc.refundedCents);
			groups.set(key, group);
		}
		return (
			[...groups.values()]
				// A bucket exists when EITHER half contributed, which is the SQL's union
				// semantics: a day whose only activity was a refund is a row at revenue 0, and a
				// genuinely zero-total order is a row rather than an absence. The MONEY is part
				// of the test as well as the contributor counts — a floored `revenueOrders` over
				// a non-zero `revenueCents` is drift, and dropping that bucket would hide money.
				.filter(
					(group) =>
						group.revenueOrders > 0 ||
						group.refundEntries > 0 ||
						group.revenueCents !== 0 ||
						group.refundedCents !== 0,
				)
				.toSorted((a, b) =>
					a.bucketStart === b.bucketStart
						? a.currency.localeCompare(b.currency)
						: a.bucketStart.localeCompare(b.bucketStart),
				)
				.map((group) => ({
					bucketStart: group.bucketStart,
					currency: toCurrency(group.currency),
					revenueCents: cents(group.revenueCents),
					refundedCents: cents(group.refundedCents),
				}))
		);
	}

	async ordersByStatus(range: DateRange): Promise<StatusCount[]> {
		const counts = new Map<string, number>();
		for (const doc of await this.#windowDays(range, "ordersByStatus")) {
			for (const [state, count] of Object.entries(doc.stateCounts)) {
				counts.set(state, (counts.get(state) ?? 0) + count);
			}
		}
		return [...counts.entries()]
			.filter(([, count]) => count > 0)
			.toSorted((a, b) => a[0].localeCompare(b[0]))
			.map(([status, orderCount]) => ({ status, orderCount }));
	}

	/**
	 * Top products over the FROZEN line snapshots (never a live product join), for the
	 * orders in the window whose current state is revenue-counting.
	 *
	 * Computed on read, by scanning the window's orders: a per-product-per-day rollup
	 * would put the whole catalogue inside one day document. The group is
	 * `(productId, title)` rather than the product alone, exactly as the SQL's `GROUP
	 * BY oi.product_id, oi.title` was — two snapshots of the same product under
	 * different titles are two rows, because the title is a fact about the sale.
	 */
	async topProducts(
		range: DateRange,
		metric: TopProductsMetric,
		limit: number,
	): Promise<TopProduct[]> {
		const budget: PageBudget = {
			limit: this.#maxReportPages,
			used: 0,
			scanned: 0,
			option: "maxReportPages",
		};
		// The EXACT window, not the day-widened one: this report scans the orders
		// themselves, so it can compare instants the way the statement's `BETWEEN` did.
		const orders = await this.#scanOrders(
			{ createdAt: { gte: range.from, lte: range.to } },
			budget,
			"topProducts",
		);
		const groups = new Map<
			string,
			{ productId: string; title: string; qtySold: number; revenueCents: number }
		>();
		for (const order of orders) {
			if (!REVENUE_STATES.has(order.state)) continue;
			for (const item of order.items) {
				const key = `${item.productId}${KEY_SEP}${item.title}`;
				const group = groups.get(key) ?? {
					productId: item.productId,
					title: item.title,
					qtySold: 0,
					revenueCents: 0,
				};
				group.qtySold += item.quantity;
				group.revenueCents = addAggregate(group.revenueCents, item.quantity * item.unitPrice);
				groups.set(key, group);
			}
		}
		return [...groups.values()]
			.toSorted((a, b) => {
				const av = metric === "quantity" ? a.qtySold : a.revenueCents;
				const bv = metric === "quantity" ? b.qtySold : b.revenueCents;
				return bv === av ? a.productId.localeCompare(b.productId) : bv - av;
			})
			.slice(0, limit)
			.map((group) => ({
				productId: group.productId,
				titleSnapshot: group.title,
				qtySold: group.qtySold,
				revenueCents: cents(group.revenueCents),
			}));
	}

	/**
	 * Low stock, driven from `inventory` and titled through the LIVE sku claim.
	 *
	 * `inventory` declares no index (every other access to it is by sku), so the
	 * threshold is applied in memory over a paged scan rather than as a range query —
	 * the collection is the size of the sku list and the report has no window to narrow
	 * it by, so a scan is what the SQL's own sequential read over `inventory` was.
	 *
	 * **The title comes from `sku_owners`, and only from a LIVE product claim.** The SQL
	 * joined `product_commerce` on the sku with `deleted_at IS NULL` as a JOIN
	 * condition, because live-sku uniqueness there is a PARTIAL index: a tombstone may
	 * share a live sku, and joining without the predicate would duplicate the row and
	 * could win the title. Here the claim document IS that predicate — it names the one
	 * live owner of a sku — so the pairing is at most 1:1 by construction and a
	 * tombstone can neither duplicate nor title a row. A released claim, a claim held by
	 * a VARIANT (whose sku is not the product row's own sku, which is what the SQL
	 * joined), an absent product, or a product whose own title is null all yield
	 * `title: null` — and `null` is the only fallback: the sku is NEVER substituted, or
	 * "the product is called SKU-42" would be indistinguishable from "we don't know its
	 * name".
	 *
	 * A missing claim over a product that really is live therefore reads as an untitled
	 * row rather than a wrong one — the safe direction, and the reason the claim being a
	 * fast path rather than the definition of existence (rule (b)) costs nothing here.
	 */
	async lowStock(threshold: number): Promise<LowStockRow[]> {
		const budget: PageBudget = {
			limit: this.#maxReportPages,
			used: 0,
			scanned: 0,
			option: "maxReportPages",
		};
		const low: InventoryDoc[] = [];
		let cursor: string | undefined;
		for (;;) {
			if (budget.used >= budget.limit) {
				throw new ScanPageLimitError("lowStock", budget.limit, low.length, budget.option);
			}
			budget.used++;
			const page = await this.#inventory.query({ limit: PAGE_SIZE, cursor });
			for (const { data } of page.items) {
				if (data.onHand <= threshold) low.push(data);
			}
			if (!page.hasMore || page.cursor === undefined) break;
			cursor = page.cursor;
		}
		const rows: LowStockRow[] = [];
		for (const doc of low.toSorted((a, b) =>
			a.onHand === b.onHand ? a.sku.localeCompare(b.sku) : a.onHand - b.onHand,
		)) {
			rows.push({ sku: doc.sku, onHand: doc.onHand, title: await this.#liveTitleFor(doc.sku) });
		}
		return rows;
	}

	/** The live PRODUCT row's title for a sku, or null — never the sku. */
	async #liveTitleFor(sku: string): Promise<string | null> {
		const claim = await this.#skuOwners.get(sku);
		if (claim === null || !claim.live || claim.ownerKind !== "product") return null;
		const product = await this.#products.get(claim.ownerId);
		if (product === null || product.deletedAt !== null || product.lifecycle !== "live") return null;
		return product.title;
	}

	// -- the scans -------------------------------------------------------------

	/**
	 * The day counters a window is made of — EXACTLY, whatever instants it names.
	 *
	 * A day document is the counters for a WHOLE day, so it can only answer for a day the
	 * window covers whole. The interior of the window is therefore read from the
	 * documents, and each EDGE day the window truncates (at most two, and only when the
	 * bound is not midnight) is computed from an instant-filtered scan of that day's
	 * orders — the same machinery `topProducts` uses, over a single day's worth of rows.
	 *
	 * So the window means what the statement this replaced meant: `created_at BETWEEN from
	 * AND to`, to the instant. The cost of a ragged window is bounded and visible: two
	 * extra order scans, paid only by the caller that asks for one.
	 *
	 * One consequence is worth stating, because it is easy to misread a ragged report: an
	 * edge day is computed from the ORDERS and is therefore exact even when the rollups
	 * have drifted, while an interior day is read from its document and carries whatever
	 * that document holds. A single report can mix the two — an exact edge beside an
	 * interior day that is reading low until the next recompute.
	 */
	async #windowDays(range: DateRange, operation: string): Promise<ReportingDailyDoc[]> {
		if (range.to < range.from) return [];
		const fromDay = dayKeyOf(range.from);
		const toDay = dayKeyOf(range.to);
		// An edge day is one the window cuts: its start is before `from`, or its end is
		// after `to`. Both bounds are inclusive, matching the statement's `BETWEEN`.
		const partialFrom = range.from > dayStartOf(fromDay);
		const partialTo = range.to < dayEndOf(toDay);

		const docs: ReportingDailyDoc[] = [];
		const budget: PageBudget = {
			limit: this.#maxReportPages,
			used: 0,
			scanned: 0,
			option: "maxReportPages",
		};
		for (const edge of edgeWindows(range, fromDay, toDay, partialFrom, partialTo)) {
			const orders = await this.#scanOrders(
				{ createdAt: { gte: edge.from, lte: edge.to } },
				budget,
				operation,
			);
			docs.push(...computeDay(edge.day, orders, edge.from).values());
		}

		const wholeFrom = partialFrom ? nextDay(fromDay) : fromDay;
		const wholeTo = partialTo ? previousDay(toDay) : toDay;
		if (wholeTo < wholeFrom) return docs;
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxReportPages; page++) {
			const result = await this.#daily.query({
				where: { date: { gte: wholeFrom, lte: wholeTo } },
				orderBy: { date: "asc" },
				limit: PAGE_SIZE,
				cursor,
			});
			for (const { data } of result.items) docs.push(normalizeReportingDailyDoc(data));
			if (!result.hasMore || result.cursor === undefined) return docs;
			cursor = result.cursor;
		}
		throw new ScanPageLimitError(operation, this.#maxReportPages, docs.length, "maxReportPages");
	}

	/** The currencies a day already has a document for. */
	async #dayCurrencies(day: string, budget: PageBudget): Promise<string[]> {
		const currencies: string[] = [];
		let cursor: string | undefined;
		for (;;) {
			if (budget.used >= budget.limit) {
				throw new ScanPageLimitError(
					"reconcileReporting",
					budget.limit,
					budget.scanned,
					budget.option,
				);
			}
			budget.used++;
			const page = await this.#daily.query({ where: { date: day }, limit: PAGE_SIZE, cursor });
			for (const { data } of page.items) currencies.push(data.currency);
			if (!page.hasMore || page.cursor === undefined) return currencies;
			cursor = page.cursor;
		}
	}

	/** One paged scan of `orders`, against the declared `createdAt` index. */
	async #scanOrders(
		where: WhereClause,
		budget: PageBudget,
		operation: string,
	): Promise<OrderDoc[]> {
		const collected: OrderDoc[] = [];
		let cursor: string | undefined;
		for (;;) {
			if (budget.used >= budget.limit) {
				throw new ScanPageLimitError(operation, budget.limit, collected.length, budget.option);
			}
			budget.used++;
			const page = await this.#orders.query({
				where,
				orderBy: { createdAt: "asc" },
				limit: PAGE_SIZE,
				cursor,
			});
			for (const { data } of page.items) {
				collected.push(normalizeOrderDoc(data));
				budget.scanned++;
			}
			if (!page.hasMore || page.cursor === undefined) return collected;
			cursor = page.cursor;
		}
	}
}

/**
 * The instant-bounded sub-windows a ragged window needs computing from orders — the
 * truncated first day, the truncated last day, or the single day when the window sits
 * inside one.
 */
function edgeWindows(
	range: DateRange,
	fromDay: string,
	toDay: string,
	partialFrom: boolean,
	partialTo: boolean,
): { day: string; from: string; to: string }[] {
	if (fromDay === toDay) {
		return partialFrom || partialTo ? [{ day: fromDay, from: range.from, to: range.to }] : [];
	}
	const edges: { day: string; from: string; to: string }[] = [];
	if (partialFrom) edges.push({ day: fromDay, from: range.from, to: dayEndOf(fromDay) });
	if (partialTo) edges.push({ day: toDay, from: dayStartOf(toDay), to: range.to });
	return edges;
}

/** The UTC day after this one. */
function nextDay(dayKey: string): string {
	return new Date(new Date(dayStartOf(dayKey)).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** The UTC day before this one. */
function previousDay(dayKey: string): string {
	return new Date(new Date(dayStartOf(dayKey)).getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every rollup event a set of scanned orders PROVES has happened.
 *
 * Read off the orders themselves: the append-only audit log carries every
 * `(fromState → toState)` pair the flips wrote, the refunds ledger every finalized
 * refund, and the arrival into the order's ORIGINAL state — the one the creating write
 * set, which the log records as its first event's `fromState` — is the event creation
 * owes. An order with no log is one whose current state is the state it arrived in.
 *
 * Only these events may be absorbed. A claim whose transition is NOT here describes
 * something these documents do not show, so a recompute over them has not counted it.
 */
function reconstructEvents(orders: OrderDoc[]): ReportingOrderEvent[] {
	const events: ReportingOrderEvent[] = [];
	for (const order of orders) {
		const origin = order.events[0]?.fromState ?? order.state;
		if (origin !== null) {
			events.push({
				kind: "transition",
				orderId: order.orderId,
				orderCreatedAt: order.createdAt,
				currency: order.currency,
				fromState: null,
				toState: origin,
				orderTotalCents: order.totals.total,
			});
		}
		for (const event of order.events) {
			if (event.toState === null) continue;
			events.push({
				kind: "transition",
				orderId: order.orderId,
				orderCreatedAt: order.createdAt,
				currency: order.currency,
				fromState: event.fromState,
				toState: event.toState,
				// DIAGNOSTIC only here: a reconstructed event is used to identify a CLAIM, never
				// to move a counter, so this is the order's total today rather than whatever it
				// was when that transition happened — and nothing recomputes from it.
				orderTotalCents: order.totals.total,
			});
		}
		for (const refund of order.refunds) {
			if (refund.status !== FINALIZED_REFUND_STATUS) continue;
			events.push({
				kind: "refund",
				orderId: order.orderId,
				orderCreatedAt: order.createdAt,
				currency: refund.currency,
				refundId: refund.id,
				refundedCents: refund.amount,
			});
		}
	}
	return events;
}

/** Which claim an event is filed under. */
function claimIdFor(event: ReportingOrderEvent): string {
	return event.kind === "transition"
		? reportingTransitionClaimId(event.orderId, event.fromState, event.toState)
		: reportingRefundClaimId(event.orderId, event.refundId);
}

/** One counter the delta floors, reported through `onAnomaly` once the write lands. */
interface FlooredCounter {
	kind: "floored";
	counter: string;
	held: number;
	delta: number;
}

/** One event's delta: the floor guards, the per-field amounts, and what it floors. */
interface DeltaPlan {
	where: WhereClause;
	delta: Partial<Record<keyof ReportingDailyStoredDoc, NumericDelta>>;
	floored: FlooredCounter[];
}

/**
 * Plan one event as a guarded numeric delta against the document it was read from.
 *
 * **A transition MOVES an order between buckets.** The state it leaves is decremented
 * and the state it enters incremented, and revenue follows the same rule through the
 * allow-list. A refund adds to the day's returned money whatever the order's state.
 *
 * **Every decrement is FLOORED at zero**, which is the one place this adapter tolerates
 * being wrong: a decrement whose matching increment was lost would otherwise drive a
 * counter negative and report a negative revenue. Per counter the result is exactly the
 * read-modify-write's, `max(held - dec, 0) + inc`, expressed so it stays correct under
 * peers' deltas:
 *
 * - `held >= dec` (the healthy case): the delta is `inc - dec`, guarded on `>= dec`, so
 *   peers' deltas landing first can only keep the guard true or, if they drain the
 *   counter, refuse the write so it is planned again.
 * - `held < dec` (drift): the delta is `inc - held`, guarded on the counter still being
 *   exactly `held` (or absent), so the floor is taken against the value it was judged on.
 *   It is announced, because flooring is proof that something was lost. That exact-value
 *   guard DOES couple the writer to its peers: any peer delta moving that counter first
 *   refuses it, and it re-plans once per such write. That is accepted because it only
 *   runs on drift, which is rare and already a case for a recompute.
 *
 * Increments are checked against the safe-integer ceiling here, from the value read,
 * so an overflow is the `RangeError` it always was rather than a guard refusal the
 * retry loop could not tell from contention.
 */
function planDelta(doc: CurrentReportingDailyDoc, event: ReportingOrderEvent): DeltaPlan {
	const moves = new Map<
		keyof ReportingDailyStoredDoc,
		{ counter: string; dec: number; inc: number }
	>();
	const move = (
		field: keyof ReportingDailyStoredDoc,
		counter: string,
		dec: number,
		inc: number,
	): void => {
		const held = moves.get(field) ?? { counter, dec: 0, inc: 0 };
		held.dec += dec;
		held.inc += inc;
		moves.set(field, held);
	};
	if (event.kind === "transition") {
		if (event.fromState !== null) {
			move(stateCountField(event.fromState), `stateCounts.${event.fromState}`, 1, 0);
			if (REVENUE_STATES.has(event.fromState)) {
				move("revenueOrders", "revenueOrders", 1, 0);
				move("revenueCents", "revenueCents", event.orderTotalCents, 0);
			}
		}
		move(stateCountField(event.toState), `stateCounts.${event.toState}`, 0, 1);
		if (REVENUE_STATES.has(event.toState)) {
			move("revenueOrders", "revenueOrders", 0, 1);
			move("revenueCents", "revenueCents", 0, event.orderTotalCents);
		}
	} else {
		move("refundEntries", "refundEntries", 0, 1);
		move("refundedCents", "refundedCents", 0, event.refundedCents);
	}

	const plan: DeltaPlan = { where: {}, delta: {}, floored: [] };
	for (const [field, { counter, dec, inc }] of moves) {
		const raw = doc[field];
		const held = typeof raw === "number" ? raw : 0;
		let net: number;
		if (dec === 0) {
			net = inc;
		} else if (held >= dec) {
			net = inc - dec;
			plan.where[field] = { gte: dec };
		} else {
			net = inc - held;
			// Absent reads as 0, and an absent field is matched by `null`, not by `0`.
			plan.where[field] = typeof raw === "number" ? raw : null;
			plan.floored.push({ kind: "floored", counter, held, delta: dec });
		}
		// The safe-integer refusal, from the value in hand (see the docblock).
		if (net > 0) addAggregate(held, net);
		else addAggregate(0, -net);
		if (net > 0) plan.delta[field] = { inc: net };
		else if (net < 0) plan.delta[field] = { dec: -net };
	}
	return plan;
}

/**
 * The day's documents as the ORDERS define them — one per currency that contributed.
 *
 * A refund is filed under its OWN currency, which is what the SQL's union did (the
 * revenue half read `order_totals.currency`, the refund half `refunds.currency`), so a
 * refund in a currency the day has no revenue in is a document of its own.
 */
function computeDay(day: string, orders: OrderDoc[], now: string): Map<string, ReportingDailyDoc> {
	const docs = new Map<string, ReportingDailyDoc>();
	const at = (currency: string): ReportingDailyDoc => {
		const held = docs.get(currency) ?? newReportingDailyDoc(currency, day, now);
		docs.set(currency, held);
		return held;
	};
	for (const order of orders) {
		const doc = at(order.currency);
		const counts: Record<string, number> = { ...doc.stateCounts };
		counts[order.state] = (counts[order.state] ?? 0) + 1;
		doc.stateCounts = counts;
		if (REVENUE_STATES.has(order.state)) {
			doc.revenueOrders += 1;
			doc.revenueCents = addAggregate(doc.revenueCents, order.totals.total);
		}
		for (const refund of order.refunds) {
			if (refund.status !== FINALIZED_REFUND_STATUS) continue;
			const target = at(refund.currency);
			target.refundEntries += 1;
			target.refundedCents = addAggregate(target.refundedCents, refund.amount);
		}
	}
	for (const doc of docs.values()) doc.stateCounts = normalizeStateCounts(doc.stateCounts);
	return docs;
}

/** Do two day documents hold the same counters? The write stamp is not a counter. */
function sameCounters(a: ReportingDailyDoc, b: ReportingDailyDoc): boolean {
	return (
		a.revenueOrders === b.revenueOrders &&
		a.revenueCents === b.revenueCents &&
		a.refundEntries === b.refundEntries &&
		a.refundedCents === b.refundedCents &&
		JSON.stringify(a.stateCounts) === JSON.stringify(b.stateCounts)
	);
}
