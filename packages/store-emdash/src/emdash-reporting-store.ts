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
 * revenueByPeriod  reporting_daily, paged by the `date` range, folded to day/week/month;
 *                  by month, a clean reporting_monthly document per whole month (#572)
 * ordersByStatus   the same documents (months included), folded over `stateCounts`
 * topProducts      the product lines those documents carry, BUILT from the orders;
 *                  a day whose lines are dirty or unbuilt is a scan of its `orders`
 * lowStock         a scan of `inventory`, titled through the live sku claim
 * ```
 *
 * **Why top products are built rather than counted.** One event can move any number of
 * products, and a guarded delta can address only a bounded number of fields, so a
 * day's product lines are written whole — by a recompute, or by the rollup sweep's
 * product build — and a delta that moves an order into or out of the revenue set only
 * marks them dirty (issue #572). `lowStock` has no window at all — it is a
 * current-state question about stock, which is one scan of a collection that is the
 * size of the sku list.
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
} from "@urumi.ai/otta-domain";
import {
	CAS_RETRY,
	casDone,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import { ScanPageLimitError } from "./errors.js";
import type { InventoryDoc } from "./inventory-documents.js";
import { INVENTORY_COLLECTION } from "./inventory-documents.js";
import type { OrderDoc } from "./order-documents.js";
import { normalizeOrderDoc, ORDERS_COLLECTION } from "./order-documents.js";
import type { ProductCommerceDoc, SkuOwnerDoc } from "./product-commerce-documents.js";
import {
	codeUnitAsc,
	PRODUCT_COMMERCE_COLLECTION,
	SKU_OWNERS_COLLECTION,
} from "./product-commerce-documents.js";
import {
	addAggregate,
	addProductLine,
	canonicalJson,
	compareProductLines,
	PRODUCTS_UNBUILDABLE,
	REPORTING_MONTHLY_FORMAT,
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
	isCleanMonthlyDoc,
	monthDays,
	monthKeyOf,
	REPORTING_MONTHLY_COLLECTION,
	REVENUE_STATES,
	sortedProductLines,
	stateCountField,
	storedProductLines,
	storedStateCounts,
	toStoredReportingDailyDoc,
	type CurrentReportingDailyDoc,
	type ReportingAppliedDoc,
	type ReportingDailyDoc,
	type ReportingDailyStoredDoc,
	type ReportingMonthCurrency,
	type ReportingMonthlyDoc,
	type ReportingOrderEvent,
	type ReportingProductLine,
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
 * Values per `in` query. Each value is a bound parameter, D1 allows 100 per
 * statement, and the host spends some on the plugin, the collection and the
 * cursor — so a batch stays well under the limit rather than at it. The host's
 * own precedent is the same number: emdash's `SQL_BATCH_SIZE = 50`
 * (`src/utils/chunks.ts`), there "to keep SQL `IN (?, ?, …)` clauses within
 * Cloudflare D1's bound-parameter limit".
 */
const IN_BATCH = 50;

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
	 * The most `(productId, title)` groups a month document keeps per currency (default
	 * {@link MAX_MONTH_PRODUCT_LINES}); past it the month's lines are `null` and top
	 * products read that month's days.
	 */
	maxMonthProductLines?: number;
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

/** A sku's live claim and the not-soft-deleted document it names. */
interface LiveSkuOwner {
	readonly claim: SkuOwnerDoc;
	readonly product: ProductCommerceDoc;
}

/**
 * Whether the owner document really holds the claimed sku. A claim is written one
 * round trip before its owner, so a crashed writer can leave a live claim nothing
 * backs (`getProductIdsBySku` guards the same way). Such an owner must neither
 * title the row nor hide it by its kind, so the row lists untitled.
 */
function holdsClaimedSku(product: ProductCommerceDoc, claim: SkuOwnerDoc): boolean {
	if (claim.ownerKind === "product") return product.sku === claim.sku;
	return claim.variantKey !== null && product.variants?.[claim.variantKey]?.sku === claim.sku;
}

/** The live PRODUCT row's title for a sku, or null — never the sku. */
function liveTitleOf(owner: LiveSkuOwner | undefined): string | null {
	if (owner === undefined || owner.claim.ownerKind !== "product") return null;
	return owner.product.lifecycle === "live" ? owner.product.title : null;
}

/**
 * Every document whose indexed `field` is one of `values`, {@link IN_BATCH}
 * values per `in` query, each query paged to its end.
 */
async function queryIn<T extends object>(
	collection: StorageCollection<T>,
	field: string,
	values: readonly string[],
): Promise<T[]> {
	const docs: T[] = [];
	for (let start = 0; start < values.length; start += IN_BATCH) {
		const chunk = values.slice(start, start + IN_BATCH);
		let cursor: string | undefined;
		do {
			const page = await collection.query({
				where: { [field]: { in: [...chunk] } },
				limit: PAGE_SIZE,
				cursor,
			});
			for (const { data } of page.items) docs.push(data);
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor !== undefined);
	}
	return docs;
}

/**
 * The default cap on a month document's product lines per currency. A line is about a
 * hundred bytes of JSON, so a thousand keeps the row near 100 KB per currency — well
 * inside a D1 row and cheap to parse on every long report.
 */
export const MAX_MONTH_PRODUCT_LINES = 1000;

export class EmdashReportingStore implements ReportingStore {
	readonly #daily: StorageCollection<ReportingDailyStoredDoc>;
	readonly #applied: StorageCollection<ReportingAppliedDoc>;
	readonly #monthly: StorageCollection<ReportingMonthlyDoc>;
	readonly #orders: StorageCollection<OrderDoc>;
	readonly #inventory: StorageCollection<InventoryDoc>;
	readonly #products: StorageCollection<ProductCommerceDoc>;
	readonly #skuOwners: StorageCollection<SkuOwnerDoc>;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxReportPages: number;
	readonly #maxReconcilePages: number;
	readonly #maxMonthProductLines: number;
	readonly #onAnomaly: (anomaly: ReportingAnomaly) => void;
	/** The window reads in flight, by grain and window — see {@link EmdashReportingStore.#window}. */
	readonly #windowReads = new Map<string, Promise<readonly RollupSlice[]>>();

	constructor(options: EmdashReportingStoreOptions) {
		this.#daily = collectionOf<ReportingDailyStoredDoc>(
			options.storage,
			REPORTING_DAILY_COLLECTION,
		);
		this.#applied = collectionOf<ReportingAppliedDoc>(
			options.storage,
			REPORTING_APPLIED_COLLECTION,
		);
		this.#monthly = collectionOf<ReportingMonthlyDoc>(
			options.storage,
			REPORTING_MONTHLY_COLLECTION,
		);
		this.#orders = collectionOf<OrderDoc>(options.storage, ORDERS_COLLECTION);
		this.#inventory = collectionOf<InventoryDoc>(options.storage, INVENTORY_COLLECTION);
		this.#products = collectionOf<ProductCommerceDoc>(options.storage, PRODUCT_COMMERCE_COLLECTION);
		this.#skuOwners = collectionOf<SkuOwnerDoc>(options.storage, SKU_OWNERS_COLLECTION);
		this.#clock = options.clock;
		this.#maxReportPages = options.maxReportPages ?? MAX_REPORT_PAGES;
		this.#maxReconcilePages = options.maxReconcilePages ?? MAX_RECONCILE_PAGES;
		this.#maxMonthProductLines = options.maxMonthProductLines ?? MAX_MONTH_PRODUCT_LINES;
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
	 * Calling it twice is calling it once. A second delivery is refused at the claim and
	 * moves no counter (it reads the day first, as every delivery does: five calls for a
	 * first delivery — the day, the claim, the month touch, the delta, the stamp — and two
	 * for a spent one).
	 */
	async recordOrderEvent(event: ReportingOrderEvent): Promise<void> {
		const claimId = claimIdFor(event);
		// No "already spent?" read first (QA2 M2). The claim below is a create-if-absent,
		// so it refuses a spent event on its own; a pre-read only spared a REDELIVERY one
		// call while costing every FIRST delivery — every order transition, the expiry
		// sweep's included — one more. A redelivery now costs the day read and a refused
		// claim, and moves nothing.

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

		// The month's cache is dirtied BEFORE the day moves (issue #572; see
		// `ReportingMonthlyDoc`). This event's "after" mark is the claim's own `appliedAt`
		// stamp below: a rebuild refuses to commit while a claim of the month is unstamped.
		await this.#touchMonth(monthKeyOf(day), now);

		if (!(await this.#applyEvent(event, docId, day, claimId, snapshot, now))) return;

		// The stamp is a DIAGNOSTIC for the counters (see `ReportingAppliedDoc`): it is
		// what makes a claim-only residue legible. It is also this event's "after" mark for
		// the month cache — and a REFUSED stamp means a recompute stamped the claim first
		// (absorbing it) while this delta was still in flight. Only the epoch guard decides
		// whether the delta landed, and here it did: so a month rebuild that saw the claim
		// stamped may have read the day without it. Touch the month again, after the day
		// write, so such a rebuild is undone (issue #572 review).
		const stamped = await this.#applied.compareAndSet(claimId, created.revision, {
			...claim,
			appliedAt: now,
		});
		if (!stamped.applied) await this.#touchMonth(monthKeyOf(day), now);
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
					// An order entering or leaving the revenue set changes the day's top
					// products, which no delta can move: the built lines stop describing it.
					set: plan.movesProducts ? { updatedAt: now, productsDirty: 1 } : { updatedAt: now },
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
							// The epoch moves past any lines' `productsEpoch`: list it for a build.
							productsDirty: 1,
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
				// A new day's product lines are UNKNOWN, not empty, as a migrated legacy one's
				// are: it may be created by an event on an order whose earlier events were
				// lost (the under-count residue `reconcile` heals), and "no lines" would then
				// read as clean. The sweep builds them once the day closes (issue #572).
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
				const lines = productLinesByCurrency(orders);

				// 3. ABSORB, before a single counter is committed. Absorbing a live event's
				// claim stamps it, which a month rebuild reads as "its day write is done"
				// although its delta may still land: so from the first claim absorbed, this
				// attempt touches the month again on its way out, however it leaves (a
				// retry, a budget refusal, a failed commit) — see `ReportingMonthlyDoc`.
				const month = monthKeyOf(day);
				const progress = { absorbed: 0 };
				let touchOnExit = false;
				const touchNeeded = (): boolean => touchOnExit || progress.absorbed > 0;
				let step: CasStep<{ written: number; claims: number; scanned: number }>;
				try {
					step = await this.#absorbAndCommit({
						day,
						orders,
						computed,
						lines,
						pinned,
						budget,
						now,
						month,
						progress,
						committing: () => {
							touchOnExit = true;
						},
					});
				} catch (err) {
					if (touchNeeded()) {
						// The attempt's own failure is the one to report: a touch that fails too is
						// dropped, leaving the month to the verifier (see `ReportingMonthlyDoc`).
						await this.#touchMonth(month, now).catch(() => undefined);
					}
					throw err;
				}
				if (touchNeeded()) await this.#touchMonth(month, now);
				return step;
			},
			this.#retry,
		);
	}

	/** Steps 3 and 4 of a day's recompute — see {@link #reconcileDay}. */
	async #absorbAndCommit({
		day,
		orders,
		computed,
		lines,
		pinned,
		budget,
		now,
		month,
		progress,
		committing,
	}: {
		day: string;
		orders: OrderDoc[];
		computed: Map<string, ReportingDailyDoc>;
		lines: Map<string, ReportingProductLine[]>;
		pinned: Map<string, Versioned<ReportingDailyStoredDoc> | null>;
		budget: PageBudget;
		now: string;
		month: string;
		progress: { absorbed: number };
		committing: () => void;
	}): Promise<CasStep<{ written: number; claims: number; scanned: number }>> {
		const absorbed = await this.#absorbDayClaims(day, orders, budget, now, progress);
		// A claim moved under us — a peer created or stamped one between the read and
		// the write — so this day's premises are stale. Re-run it.
		if (absorbed === "retry") return CAS_RETRY;

		// 4. COMMIT, each document against what was pinned in step 1.
		const commits: {
			docId: string;
			held: Versioned<ReportingDailyStoredDoc> | null;
			target: ReportingDailyDoc;
			products: ReportingProductLine[];
			counts: boolean;
		}[] = [];
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
			const exact = held !== null && sameCounters(normalizeReportingDailyDoc(held.value), target);
			// An exact document is left alone unless this attempt absorbed claims. Then
			// the epoch is still bumped, so a delta that passed its claim check before the
			// absorb, and has not landed yet, is refused rather than applied on top.
			// A tainted (hybrid) document is always rewritten: its counters may agree by
			// accident, but its nested map has to go.
			const tainted = held !== null && isHybridReportingDailyDoc(held.value);
			// The day's top-products lines are written with its counters, so a document
			// whose lines are dirty, unknown or stale is rewritten too (issue #572).
			const products = lines.get(currency) ?? [];
			const linesCurrent = held !== null && sameLines(storedProductLines(held.value), products);
			if (exact && absorbed.claims === 0 && !tainted && linesCurrent) continue;
			commits.push({ docId, held, target, products, counts: !exact || tainted });
		}
		if (commits.length === 0) {
			return casDone({ written: 0, claims: absorbed.claims, scanned: budget.scanned });
		}

		// The month's cache is bracketed around the day's writes (`ReportingMonthlyDoc`):
		// a touch before, and the caller's touch on the way out after.
		let written = 0;
		await this.#touchMonth(month, now);
		committing();
		for (const commit of commits) {
			const applied = await this.#commitDay(
				commit.docId,
				commit.held,
				commit.target,
				commit.products,
			);
			// A peer moved this day after it was pinned. Re-scan: the value in hand was
			// derived from an older snapshot of the orders.
			if (!applied) return CAS_RETRY;
			if (commit.counts) written++;
		}

		return casDone({ written, claims: absorbed.claims, scanned: budget.scanned });
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
		products: readonly ReportingProductLine[],
	): Promise<boolean> {
		if (held === null || !hasReportingDailyGuards(held.value)) {
			const epoch = held === null ? 1 : 1 + (held.value.epoch ?? 0);
			const written = await this.#daily.compareAndSet(
				docId,
				held?.revision ?? null,
				toStoredReportingDailyDoc(target, epoch, 0, products),
			);
			return written.applied;
		}
		const pinned = held.value;
		const next = toStoredReportingDailyDoc(target, pinned.epoch + 1, pinned.seq, products);
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
		progress: { absorbed: number },
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
			if (outcome === "absorbed") {
				claims++;
				progress.absorbed++;
			}
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

	// -- the month grain and the product lines (issue #572) ---------------------

	/**
	 * Bump a month document's `gen` and mark it dirty — the bracket every day write sits
	 * in (see `ReportingMonthlyDoc`). One unguarded numeric delta, which never contends;
	 * the first touch of a month creates its document, dirty and unbuilt.
	 */
	async #touchMonth(month: string, now: string): Promise<void> {
		await withCasRetry<undefined>(
			"touchReportingMonth",
			async () => {
				const bumped = await this.#monthly.updateIf(month, {
					where: {},
					set: { dirty: 1, touchedAt: now, updatedAt: now },
					delta: { gen: { inc: 1 } },
				});
				if (bumped.applied) return casDone(undefined);
				// Absent (an unconditional `updateIf` refuses nothing else): create it. A peer
				// creating it first loses this create, and the retry bumps theirs.
				const created = await this.#monthly.compareAndSet(month, null, {
					month,
					gen: 1,
					dirty: 1,
					currencies: null,
					touchedAt: now,
					builtAt: null,
					updatedAt: now,
				});
				return created.applied ? casDone(undefined) : CAS_RETRY;
			},
			this.#retry,
		);
	}

	/**
	 * Build one CLOSED day's top-products lines from its orders, leaving its counters
	 * alone (issue #572) — what the rollup sweep runs for a day whose lines are dirty
	 * (an order of it entered or left the revenue set) or unknown (a document from
	 * before product lines existed: the upgrade backfill).
	 *
	 * Returns how many documents it wrote, and how many of those had CLEAN lines that were
	 * still wrong (`repaired`) — what the sweep's verifier announces.
	 *
	 * It is the recompute without the claims: pin each document's `epoch` and `seq`,
	 * scan the day's orders, and commit the lines guarded on that pin, so a delta landing
	 * after the pin refuses the commit and the day is scanned again. A delta that lands
	 * after the commit and moves the revenue set dirties the lines again, in its own
	 * statement. The commit is bracketed in the month's bumps like every day write.
	 *
	 * A day with a legacy or tainted document gets the full {@link reconcile} instead,
	 * which migrates it and writes its lines with its counters. Spends the reconcile page
	 * budget (`maxReconcilePages`).
	 */
	async rebuildDayProducts(
		day: string,
	): Promise<{ written: number; repaired: number; ordersScanned: number }> {
		const result = await withCasRetry<
			{ written: number; repaired: number; ordersScanned: number } | "reconcile"
		>(
			"buildReportingProducts",
			async () => {
				const budget: PageBudget = {
					limit: this.#maxReconcilePages,
					used: 0,
					scanned: 0,
					option: "maxReconcilePages",
				};
				const held = await this.#queryDays(day, day, budget, "buildReportingProducts");
				if (held.some(({ data }) => !isCurrentReportingDailyDoc(data))) {
					return casDone("reconcile");
				}
				const orders = await this.#scanOrders(
					{ createdAt: { gte: dayStartOf(day), lte: dayEndOf(day) } },
					budget,
					"buildReportingProducts",
				);
				const lines = productLinesByCurrency(orders);
				const stale = held.filter(
					({ data }) => !sameLines(storedProductLines(data), lines.get(data.currency) ?? []),
				);
				// Lines that were CLEAN and still wrong are drift the verifier exists to find.
				const repaired = stale.filter(({ data }) => storedProductLines(data) !== null).length;
				if (stale.length === 0) {
					return casDone({ written: 0, repaired: 0, ordersScanned: budget.scanned });
				}
				const now = this.#clock.now().toISOString();
				const month = monthKeyOf(day);
				await this.#touchMonth(month, now);
				try {
					for (const { id, data } of stale) {
						const pinned = data as CurrentReportingDailyDoc;
						const written = await this.#daily.updateIf(id, {
							where: { epoch: pinned.epoch, seq: pinned.seq },
							set: {
								products: lines.get(pinned.currency) ?? [],
								productsDirty: 0,
								productsEpoch: pinned.epoch,
								updatedAt: now,
							},
						});
						if (!written.applied) return CAS_RETRY;
					}
				} finally {
					await this.#touchMonth(month, now);
				}
				return casDone({ written: stale.length, repaired, ordersScanned: budget.scanned });
			},
			this.#retry,
		);
		if (result !== "reconcile") return result;
		const healed = await this.reconcile({ from: dayStartOf(day), to: dayEndOf(day) });
		return { written: healed.documentsWritten, repaired: 0, ordersScanned: healed.ordersScanned };
	}

	/**
	 * Rebuild one month document from the month's day documents, clearing `dirty` —
	 * guarded on the `gen` read before the days were, so a day write that raced the
	 * rebuild leaves it dirty (see `ReportingMonthlyDoc`). A currency's product lines
	 * are summed only when every one of its day documents has clean ones, and kept only
	 * up to `maxMonthProductLines` groups; otherwise they are `null` and a reader takes
	 * that month's days. Returns whether the month is now built (written, or already
	 * exactly what its days say).
	 *
	 * It does not build while any claim of the month is unstamped (that event may not
	 * have moved its day yet), nor — given `touchedBefore` — while the month's last touch
	 * is at or after it: a sweep writer between its two touches may not have written its
	 * day yet. The rollup sweep passes its settle window; a caller that knows no writer
	 * is in flight (a test, an operator) may omit it.
	 *
	 * Rebuilding a CLEAN month is the verifier: if its sums still match its days nothing
	 * is written; if they do not, they are repaired, and `"repaired"` says so.
	 */
	async rebuildMonth(month: string, options: { touchedBefore?: string } = {}): Promise<boolean> {
		const outcome = await this.buildMonth(month, options);
		return outcome === "built" || outcome === "unchanged" || outcome === "repaired";
	}

	/** {@link rebuildMonth}, saying what it found. */
	async buildMonth(
		month: string,
		options: { touchedBefore?: string } = {},
	): Promise<"built" | "unchanged" | "repaired" | "held" | "settling" | "empty"> {
		return withCasRetry<"built" | "unchanged" | "repaired" | "held" | "settling" | "empty">(
			"rebuildReportingMonth",
			async () => {
				const budget: PageBudget = {
					limit: this.#maxReconcilePages,
					used: 0,
					scanned: 0,
					option: "maxReconcilePages",
				};
				const pinned = await this.#monthly.getVersioned(month);
				if (
					options.touchedBefore !== undefined &&
					pinned?.value.touchedAt !== undefined &&
					pinned.value.touchedAt >= options.touchedBefore
				) {
					return casDone("settling");
				}
				const { first, last } = monthDays(month);
				// An event between its claim and its stamp may or may not have moved its day yet,
				// and its "before" touch may predate the pin: wait for it (see `ReportingMonthlyDoc`).
				const inFlight = await this.#applied.count({
					date: { gte: first, lte: last },
					appliedAt: null,
				});
				if (inFlight > 0) return casDone("held");
				const days = await this.#queryDays(first, last, budget, "rebuildReportingMonth");
				if (pinned === null && days.length === 0) return casDone("empty");
				// Lines marked clean but built at an epoch the document has moved past (a writer
				// unaware of lines recomputed the day): flag them dirty, so the refresh lists the
				// day and builds them again. Guarded on the epoch and seq just read; a lost race
				// leaves it to the verifier.
				for (const { id, data } of days) {
					if (
						isCurrentReportingDailyDoc(data) &&
						data.productsDirty === 0 &&
						storedProductLines(data) === null
					) {
						await this.#daily.updateIf(id, {
							where: { epoch: data.epoch, seq: data.seq },
							set: { productsDirty: 1 },
						});
					}
				}
				const currencies = capMonthLines(sumMonth(days), this.#maxMonthProductLines);
				const now = this.#clock.now().toISOString();
				if (pinned === null) {
					const created = await this.#monthly.compareAndSet(month, null, {
						month,
						gen: 0,
						dirty: 0,
						currencies,
						format: REPORTING_MONTHLY_FORMAT,
						builtAt: now,
						updatedAt: now,
					});
					return created.applied ? casDone("built") : CAS_RETRY;
				}
				const wasClean = isCleanMonthlyDoc(pinned.value);
				const same =
					wasClean && canonicalJson(pinned.value.currencies) === canonicalJson(currencies);
				if (same) return casDone("unchanged");
				const written = await this.#monthly.updateIf(month, {
					where: { gen: pinned.value.gen },
					set: {
						dirty: 0,
						currencies,
						format: REPORTING_MONTHLY_FORMAT,
						builtAt: now,
						updatedAt: now,
					},
				});
				if (!written.applied) return CAS_RETRY;
				return casDone(wasClean ? "repaired" : "built");
			},
			this.#retry,
		);
	}

	/**
	 * Closed days before `beforeDay` whose product lines need building, NEWEST first —
	 * so the trailing year a report reads is built before older history: the dirty ones,
	 * then the never-built ones (the upgrade backfill). At most `limit`, in at most two
	 * queries, each served by the `(productsDirty, date)` index. An unbuildable day
	 * (`PRODUCTS_UNBUILDABLE`) is not listed.
	 *
	 * `notBefore` (a `YYYY-MM-DD`) leaves out days before it: the history floor past which
	 * no report reads lines worth building. `unbuilt: false` lists only the dirty days —
	 * what the sweep asks for once the day's backfill allowance is spent.
	 */
	async staleProductDays(
		beforeDay: string,
		limit: number,
		options: { notBefore?: string; unbuilt?: boolean } = {},
	): Promise<string[]> {
		const days = new Set<string>();
		const date =
			options.notBefore === undefined
				? { lt: beforeDay }
				: { gte: options.notBefore, lt: beforeDay };
		for (const dirty of options.unbuilt === false ? [1] : [1, null]) {
			if (days.size >= limit) break;
			const page = await this.#daily.query({
				where: { productsDirty: dirty, date },
				orderBy: { date: "desc" },
				limit: Math.min(PAGE_SIZE, limit),
			});
			for (const { data } of page.items) {
				if (days.size < limit) days.add(data.date);
			}
		}
		return [...days].toSorted().toReversed();
	}

	/** How many orders were created on a day: one count, for sizing a build before it. */
	async dayOrderCount(day: string): Promise<number> {
		return this.#orders.count({ createdAt: { gte: dayStartOf(day), lte: dayEndOf(day) } });
	}

	/**
	 * The fewest reconcile page units ({@link EmdashReportingStoreOptions.maxReconcilePages})
	 * a {@link rebuildDayProducts} of this day can spend, claims to absorb left out — what a
	 * caller compares with the most it could ever give the build, to tell a day that is
	 * merely unlucky this tick from one that can never be built. Two reads: the day's
	 * documents and a count of its orders.
	 *
	 * A current-shape day is a page of its documents and a page per hundred orders. A day
	 * with a legacy or tainted document is rebuilt by the full {@link reconcile}, which also
	 * reads the day's claims in pages, and a day has at least one claim per order (its
	 * creation), so that is as many pages again. A claim still to absorb costs one more unit
	 * each, but absorbing is progress a later build keeps, so it is not counted here.
	 */
	async dayBuildPages(day: string): Promise<number> {
		const docs = await this.#daily.query({ where: { date: day }, limit: PAGE_SIZE });
		const orderPages = Math.ceil((await this.dayOrderCount(day)) / PAGE_SIZE);
		const legacy = docs.items.some(({ data }) => !isCurrentReportingDailyDoc(data));
		return 1 + orderPages + (legacy ? orderPages : 0);
	}

	/**
	 * Mark a day's product lines unbuildable (`PRODUCTS_UNBUILDABLE`): the sweep could
	 * not read its orders within the most a tick could give it. Each of the day's
	 * documents whose lines are not clean is marked, guarded on the `epoch` and `seq`
	 * just read, so a delta racing it wins and the day is simply listed again. A legacy or
	 * tainted document (which the build would have handed to the full {@link reconcile})
	 * is marked by a revision compare-and-set instead, exactly as the delta path migrates
	 * one: the mark is a field nothing else on that shape reads, and the first write that
	 * migrates the document drops it, which lists the day again. Returns how many were
	 * marked.
	 */
	async markProductsUnbuildable(day: string): Promise<number> {
		const budget: PageBudget = {
			limit: this.#maxReconcilePages,
			used: 0,
			scanned: 0,
			option: "maxReconcilePages",
		};
		let marked = 0;
		for (const { id, data } of await this.#queryDays(day, day, budget, "markProductsUnbuildable")) {
			if (storedProductLines(data) !== null) continue;
			if (!isCurrentReportingDailyDoc(data)) {
				const held = await this.#daily.getVersioned(id);
				if (held === null || isCurrentReportingDailyDoc(held.value)) continue;
				const legacy = await this.#daily.compareAndSet(id, held.revision, {
					...held.value,
					productsDirty: PRODUCTS_UNBUILDABLE,
				});
				if (legacy.applied) marked++;
				continue;
			}
			const written = await this.#daily.updateIf(id, {
				where: { epoch: data.epoch, seq: data.seq },
				set: { productsDirty: PRODUCTS_UNBUILDABLE },
			});
			if (written.applied) marked++;
		}
		return marked;
	}

	/**
	 * The days of a month's claims that are still unstamped though they were claimed
	 * before `claimedBefore` — events a crash stopped between their claim and their
	 * stamp, which hold the month's rebuild off until a recompute of the day absorbs
	 * them (or {@link stampSettledClaims} settles them). At most `limit` claims are
	 * looked at: one query.
	 */
	async unstampedClaimDays(month: string, claimedBefore: string, limit: number): Promise<string[]> {
		const { first, last } = monthDays(month);
		const page = await this.#applied.query({
			where: { date: { gte: first, lte: last }, appliedAt: null },
			orderBy: { date: "asc" },
			limit: Math.min(PAGE_SIZE, limit),
		});
		const days = new Set<string>();
		for (const { data } of page.items) {
			if (data.claimedAt < claimedBefore) days.add(data.date);
		}
		return [...days].toSorted();
	}

	/**
	 * Stamp a day's claims that are still unstamped though they were claimed before
	 * `claimedBefore` — to run AFTER a recompute of that day has committed. A recompute
	 * absorbs (and so stamps) only the claims its scanned orders prove; a claim whose
	 * transition the order no longer shows (it moved on, or the event was for a state it
	 * never reached) is left unstamped, and would hold its month's rebuild off forever.
	 * The day's counters are what its orders say, and an event that old is dead, so its
	 * claim is settled: stamped, NOT absorbed (a delta that somehow still lands is guarded
	 * on the epoch the recompute moved, and re-checks).
	 *
	 * BOUNDED: at most `limit` claims are looked at (one query, then a read and a write per
	 * claim stamped), and `more` says whether the day has unstamped claims past them.
	 */
	async stampSettledClaims(
		day: string,
		claimedBefore: string,
		limit: number,
	): Promise<{ stamped: number; more: boolean }> {
		// No room for a single claim's read and write: look at none, and say there may be
		// more, so the caller comes back rather than stamping past the budget it was given.
		if (limit < 1) return { stamped: 0, more: true };
		const now = this.#clock.now().toISOString();
		// ONE page, read whole before anything is written: the writes change the field the
		// query filters on, so paging on past them could skip claims. A stamped claim drops
		// out of the filter, so the next call (the next run) starts on what is left.
		const page = await this.#applied.query({
			where: { date: day, appliedAt: null },
			// Ordered on an indexed field, not left to the host's default (`created_at`):
			// with that, SQLite (no statistics) walks the host's list index over every claim
			// in the store to skip a sort, rather than search `(appliedAt, date)` for the
			// day's few (`reporting-index-plan.test.ts`).
			orderBy: { date: "asc" },
			limit: Math.min(PAGE_SIZE, limit),
		});
		let stamped = 0;
		for (const { id, data } of page.items) {
			if (data.claimedAt >= claimedBefore) continue;
			const held = await this.#applied.getVersioned(id);
			if (held === null || held.value.appliedAt !== null) continue;
			const written = await this.#applied.compareAndSet(id, held.revision, {
				...held.value,
				appliedAt: now,
			});
			if (written.applied) stamped++;
		}
		return { stamped, more: page.hasMore };
	}

	/**
	 * Dirty months before `beforeMonth` (`YYYY-MM`), newest first, at most `limit`. Given
	 * `touchedBefore`, a month touched at or after it is left out: it is settling, and
	 * {@link rebuildMonth} would refuse it.
	 *
	 * Read by `month`, newest first, with `dirty` filtered here rather than by an index:
	 * there is one document per calendar month, so a page of {@link PAGE_SIZE} is eight
	 * years of them and this is one query on any store younger than that. It pages on
	 * until `limit` dirty months are found or the months run out.
	 */
	async staleMonths(beforeMonth: string, limit: number, touchedBefore?: string): Promise<string[]> {
		const months: string[] = [];
		let cursor: string | undefined;
		for (;;) {
			const page = await this.#monthly.query({
				where: { month: { lt: beforeMonth } },
				orderBy: { month: "desc" },
				limit: PAGE_SIZE,
				cursor,
			});
			for (const { data } of page.items) {
				if (months.length >= limit) break;
				if (data.dirty !== 1) continue;
				if (
					touchedBefore === undefined ||
					data.touchedAt === undefined ||
					data.touchedAt < touchedBefore
				) {
					months.push(data.month);
				}
			}
			if (months.length >= limit || !page.hasMore || page.cursor === undefined) return months;
			cursor = page.cursor;
		}
	}

	/**
	 * The verifier's round robin over built months: up to `limit` month documents after
	 * `after` (exclusive; `null` from the start) and before `beforeMonth`, in month
	 * order. Fewer than `limit` means the walk reached the end and wraps. One query.
	 */
	async monthsAfter(after: string | null, beforeMonth: string, limit: number): Promise<string[]> {
		const page = await this.#monthly.query({
			where: { month: after === null ? { lt: beforeMonth } : { gt: after, lt: beforeMonth } },
			orderBy: { month: "asc" },
			limit: Math.min(PAGE_SIZE, limit),
		});
		return page.items.map(({ data }) => data.month);
	}

	/**
	 * The verifier's round robin over closed days, NEWEST first (as the backfill builds
	 * them): the latest day before `before` (exclusive; `null` starts at `beforeDay`, also
	 * exclusive) that has a day document, or `null` when there is none — the walk wraps.
	 * One query.
	 */
	async dayBefore(before: string | null, beforeDay: string): Promise<string | null> {
		const bound = before === null || before > beforeDay ? beforeDay : before;
		const page = await this.#daily.query({
			where: { date: { lt: bound } },
			orderBy: { date: "desc" },
			limit: 1,
		});
		return page.items[0]?.data.date ?? null;
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
		// A month bucketing can take a clean month document whole; a day or week cannot.
		const grain = interval === "month" ? "coarse" : "day";
		for (const doc of await this.#window(range, grain, "revenueByPeriod")) {
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
					revenueOrderCount: group.revenueOrders,
					refundedCents: cents(group.refundedCents),
				}))
		);
	}

	async ordersByStatus(range: DateRange): Promise<StatusCount[]> {
		const counts = new Map<string, number>();
		for (const doc of await this.#window(range, "coarse", "ordersByStatus")) {
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
	 * Read from the rollups (issue #572): each day document carries its day's product
	 * lines and each clean month document its month's, so a year is the same few reads
	 * as its revenue and costs nothing per order. Lines are BUILT rather than moved by a
	 * delta (see `ReportingDailyStoredDoc.products`), so a document whose lines are dirty
	 * or were never built is not trusted: that day's orders are scanned instead, exactly
	 * as this report always did, and a month whose lines are incomplete is taken from
	 * its days. A store upgraded across #572 therefore reports the same products before
	 * the sweep has built its lines as after; only the cost differs.
	 *
	 * The group is `(productId, title)` rather than the product alone, exactly as the
	 * SQL's `GROUP BY oi.product_id, oi.title` was — two snapshots of the same product
	 * under different titles are two rows, because the title is a fact about the sale.
	 */
	async topProducts(
		range: DateRange,
		metric: TopProductsMetric,
		limit: number,
	): Promise<TopProduct[]> {
		const slices = await this.#window(range, "coarse", "topProducts");
		const budget: PageBudget = {
			limit: this.#maxReportPages,
			used: 0,
			scanned: 0,
			option: "maxReportPages",
		};
		// A month whose lines are incomplete in any currency is taken from its days.
		const expand = new Set<string>();
		for (const slice of slices) {
			if (slice.grain === "month" && slice.products === null) expand.add(monthKeyOf(slice.date));
		}
		const daySlices: RollupSlice[] = [];
		for (const month of [...expand].toSorted()) {
			const { first, last } = monthDays(month);
			for (const { data } of await this.#queryDays(first, last, budget, "topProducts")) {
				daySlices.push(sliceOfDay(data));
			}
		}
		const trusted: RollupSlice[] = [];
		for (const slice of slices) {
			if (slice.grain === "month" && expand.has(monthKeyOf(slice.date))) continue;
			(slice.grain === "day" ? daySlices : trusted).push(slice);
		}
		// A day with an untrusted document in ANY currency is scanned whole: the scan
		// answers for every currency of the day, so its clean documents are not added too.
		const scan = new Set<string>();
		for (const slice of daySlices) if (slice.products === null) scan.add(slice.date);
		for (const slice of daySlices) if (!scan.has(slice.date)) trusted.push(slice);

		const groups = new Map<string, ReportingProductLine>();
		for (const slice of trusted) {
			for (const line of slice.products ?? []) addProductLine(groups, line);
		}
		for (const [from, to] of dayRuns([...scan])) {
			const orders = await this.#scanOrders(
				{ createdAt: { gte: dayStartOf(from), lte: dayEndOf(to) } },
				budget,
				"topProducts",
			);
			for (const lines of productLinesByCurrency(orders).values()) {
				for (const line of lines) addProductLine(groups, line);
			}
		}
		return [...groups.values()]
			.toSorted((a, b) => {
				const av = metric === "quantity" ? a.qty : a.cents;
				const bv = metric === "quantity" ? b.qty : b.cents;
				if (bv !== av) return bv - av;
				return compareProductLines(a, b);
			})
			.slice(0, limit)
			.map((group) => ({
				productId: group.productId,
				titleSnapshot: group.title,
				qtySold: group.qty,
				revenueCents: cents(group.cents),
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
	 *
	 * **A sku whose live claim names a live DIGITAL product is omitted** (issue #158).
	 * Digital goods never reserve and are never restocked, yet every sku'd product is
	 * seeded an inventory row at 0, so listing one would park it in the report at 0
	 * forever. The kind is read off the same owner document the title comes from, for
	 * a product's claim and a variant's alike (a variant sells as its product's kind).
	 * Without a live claim the kind is unknown and the row lists, untitled — the
	 * orphan rule above, unchanged.
	 *
	 * The claims and their owners are read in BATCHES — one `sku in [...]` query and
	 * one `productId in [...]` query per fifty low skus — never a read per row.
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
		const owners = await this.#liveOwnersOf(low.map((doc) => doc.sku));
		const rows: LowStockRow[] = [];
		for (const doc of low.toSorted((a, b) =>
			a.onHand === b.onHand ? a.sku.localeCompare(b.sku) : a.onHand - b.onHand,
		)) {
			const owner = owners.get(doc.sku);
			if (owner?.product.productKind === "digital") continue;
			rows.push({ sku: doc.sku, onHand: doc.onHand, title: liveTitleOf(owner) });
		}
		return rows;
	}

	/**
	 * Each sku's LIVE claim paired with the not-soft-deleted document it names, in
	 * batches. A sku with no live claim, or whose owner is gone, tombstoned or no
	 * longer holds the sku, is absent from the map.
	 */
	async #liveOwnersOf(skus: readonly string[]): Promise<Map<string, LiveSkuOwner>> {
		const claims = (await queryIn(this.#skuOwners, "sku", [...new Set(skus)])).filter(
			(claim) => claim.live,
		);
		const products = new Map(
			(await queryIn(this.#products, "productId", [...new Set(claims.map((c) => c.ownerId))]))
				.filter((product) => product.deletedAt === null)
				.map((product) => [product.productId, product]),
		);
		const owners = new Map<string, LiveSkuOwner>();
		for (const claim of claims) {
			const product = products.get(claim.ownerId);
			if (product !== undefined && holdsClaimedSku(product, claim)) {
				owners.set(claim.sku, { claim, product });
			}
		}
		return owners;
	}

	// -- the scans -------------------------------------------------------------

	/**
	 * The rollup slices a window is made of — EXACTLY, whatever instants it names.
	 *
	 * A day document is the counters for a WHOLE day, so it can only answer for a day the
	 * window covers whole. The interior of the window is therefore read from the
	 * documents, and each EDGE day the window truncates (at most two, and only when the
	 * bound is not midnight) is computed from an instant-filtered scan of that day's
	 * orders.
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
	 *
	 * **Two grains** (issue #572). A `"day"` read returns day slices only, which is what a
	 * day or week bucketing needs. A `"coarse"` read returns a CLEAN month document's
	 * sums in place of the days of every calendar month the window covers whole, and day
	 * documents for the partial months at its ends and for any month whose document is
	 * dirty or missing — so a year is one page of months plus its two edge months, and a
	 * month the sweep has not caught up with costs its days, never a wrong number. Every
	 * report except a day or week bucketing reads coarse.
	 *
	 * **Concurrent reads of one window share one read** (issue #572). The Reports page asks
	 * for revenue, statuses and top products over the same window at once, and they fold
	 * the same slices, so a later caller joins a read already in flight rather than paging
	 * the rollup again. A coarse caller joins a day read too (day slices answer it as
	 * well); a day caller joins only a day read. Only a read IN FLIGHT is shared: the
	 * entry is dropped when it settles, so a later call always reads afresh and nothing
	 * here can serve a stale window. The slices are shared too, so they are typed
	 * read-only, and a caller must not mutate them.
	 */
	#window(
		range: DateRange,
		grain: "day" | "coarse",
		operation: string,
	): Promise<readonly RollupSlice[]> {
		const keyOf = (g: "day" | "coarse"): string =>
			`${g}${KEY_SEP}${range.from}${KEY_SEP}${range.to}`;
		const inFlight =
			this.#windowReads.get(keyOf("day")) ??
			(grain === "coarse" ? this.#windowReads.get(keyOf("coarse")) : undefined);
		if (inFlight !== undefined) {
			// A budget refusal names the operation that hit it; the joiner's is its own, with
			// the original as its cause so the stack of the scan that stopped survives.
			return inFlight.catch((err: unknown) => {
				throw err instanceof ScanPageLimitError
					? new ScanPageLimitError(operation, err.pages, err.collected, err.budgetOption, {
							cause: err,
						})
					: err;
			});
		}
		const key = keyOf(grain);
		const read = this.#readWindow(range, grain, operation).finally(() => {
			this.#windowReads.delete(key);
		});
		this.#windowReads.set(key, read);
		return read;
	}

	/** One read of a window's slices — {@link EmdashReportingStore.#window}'s body. */
	async #readWindow(
		range: DateRange,
		grain: "day" | "coarse",
		operation: string,
	): Promise<RollupSlice[]> {
		if (range.to < range.from) return [];
		const fromDay = dayKeyOf(range.from);
		const toDay = dayKeyOf(range.to);
		// An edge day is one the window cuts: its start is before `from`, or its end is
		// after `to`. Both bounds are inclusive, matching the statement's `BETWEEN`.
		const partialFrom = range.from > dayStartOf(fromDay);
		const partialTo = range.to < dayEndOf(toDay);

		const slices: RollupSlice[] = [];
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
			const lines = productLinesByCurrency(orders);
			for (const doc of computeDay(edge.day, orders, edge.from).values()) {
				slices.push(sliceOf("day", doc.date, doc, lines.get(doc.currency) ?? []));
			}
		}

		const wholeFrom = partialFrom ? nextDay(fromDay) : fromDay;
		const wholeTo = partialTo ? previousDay(toDay) : toDay;
		if (wholeTo < wholeFrom) return slices;

		// The day runs to read: everything, or — coarse — everything but the clean months.
		const runs: [string, string][] = [];
		const months = grain === "coarse" ? wholeMonthsBetween(wholeFrom, wholeTo) : [];
		if (months.length === 0) {
			runs.push([wholeFrom, wholeTo]);
		} else {
			const first = monthDays(months[0]!).first;
			const last = monthDays(months.at(-1)!).last;
			if (wholeFrom < first) runs.push([wholeFrom, previousDay(first)]);
			const held = await this.#queryMonths(months[0]!, months.at(-1)!, budget, operation);
			for (const month of months) {
				const doc = held.get(month);
				if (doc === undefined || !isCleanMonthlyDoc(doc)) {
					const days = monthDays(month);
					runs.push([days.first, days.last]);
					continue;
				}
				for (const [currency, sums] of Object.entries(doc.currencies).toSorted((a, b) =>
					codeUnitAsc(a[0], b[0]),
				)) {
					slices.push(sliceOf("month", `${month}-01`, { currency, ...sums }, sums.products));
				}
			}
			if (last < wholeTo) runs.push([nextDay(last), wholeTo]);
		}
		for (const [from, to] of mergeRuns(runs)) {
			for (const { data } of await this.#queryDays(from, to, budget, operation)) {
				slices.push(sliceOfDay(data));
			}
		}
		return slices;
	}

	/** Every day document from `fromDay` to `toDay`, inclusive, in date order. */
	async #queryDays(
		fromDay: string,
		toDay: string,
		budget: PageBudget,
		operation: string,
	): Promise<{ id: string; data: ReportingDailyStoredDoc }[]> {
		const docs: { id: string; data: ReportingDailyStoredDoc }[] = [];
		let cursor: string | undefined;
		for (;;) {
			this.#spend(budget, operation, docs.length);
			const page = await this.#daily.query({
				where: fromDay === toDay ? { date: fromDay } : { date: { gte: fromDay, lte: toDay } },
				orderBy: { date: "asc" },
				limit: PAGE_SIZE,
				cursor,
			});
			for (const item of page.items) docs.push({ id: item.id, data: item.data });
			if (!page.hasMore || page.cursor === undefined) return docs;
			cursor = page.cursor;
		}
	}

	/** Every month document from `fromMonth` to `toMonth`, inclusive, by month. */
	async #queryMonths(
		fromMonth: string,
		toMonth: string,
		budget: PageBudget,
		operation: string,
	): Promise<Map<string, ReportingMonthlyDoc>> {
		const docs = new Map<string, ReportingMonthlyDoc>();
		let cursor: string | undefined;
		for (;;) {
			this.#spend(budget, operation, docs.size);
			const page = await this.#monthly.query({
				where: { month: { gte: fromMonth, lte: toMonth } },
				orderBy: { month: "asc" },
				limit: PAGE_SIZE,
				cursor,
			});
			for (const { data } of page.items) docs.set(data.month, data);
			if (!page.hasMore || page.cursor === undefined) return docs;
			cursor = page.cursor;
		}
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

/**
 * One piece of a window, as every report folds it: a day document, a computed edge
 * day, or a clean month document's sums for one currency (issue #572). `date` is the
 * day, or the month's first day, so a month bucketing folds a month slice to its own
 * month. `products` is `null` when its lines cannot be trusted (see `topProducts`).
 */
interface RollupSlice {
	readonly grain: "day" | "month";
	readonly date: string;
	readonly currency: string;
	readonly stateCounts: Readonly<Record<string, number>>;
	readonly revenueOrders: number;
	readonly revenueCents: number;
	readonly refundEntries: number;
	readonly refundedCents: number;
	readonly products: readonly ReportingProductLine[] | null;
}

function sliceOf(
	grain: "day" | "month",
	date: string,
	sums: Omit<ReportingMonthCurrency, "products"> & { currency: string },
	products: readonly ReportingProductLine[] | null,
): RollupSlice {
	return {
		grain,
		date,
		currency: sums.currency,
		stateCounts: sums.stateCounts,
		revenueOrders: sums.revenueOrders,
		revenueCents: sums.revenueCents,
		refundEntries: sums.refundEntries,
		refundedCents: sums.refundedCents,
		products,
	};
}

/** A stored day document as a slice: its value, and its lines if they are clean. */
function sliceOfDay(stored: ReportingDailyStoredDoc): RollupSlice {
	const doc = normalizeReportingDailyDoc(stored);
	return sliceOf("day", doc.date, doc, storedProductLines(stored));
}

/**
 * Each currency's top-products lines over a set of orders: the orders in a
 * revenue-counting state, grouped by `(productId, title)` off the frozen line
 * snapshots, `quantity × unitPrice` each — what `topProducts` folded on read before
 * #572, now what a day document's lines are built from.
 */
function productLinesByCurrency(orders: readonly OrderDoc[]): Map<string, ReportingProductLine[]> {
	const byCurrency = new Map<string, Map<string, ReportingProductLine>>();
	for (const order of orders) {
		if (!REVENUE_STATES.has(order.state)) continue;
		const groups = byCurrency.get(order.currency) ?? new Map<string, ReportingProductLine>();
		byCurrency.set(order.currency, groups);
		for (const item of order.items) {
			addProductLine(groups, {
				productId: item.productId,
				title: item.title,
				qty: item.quantity,
				cents: addAggregate(0, item.quantity * item.unitPrice),
			});
		}
	}
	return new Map(
		[...byCurrency].map(([currency, groups]) => [currency, sortedProductLines(groups)]),
	);
}

/** Are these stored lines (or `null`: untrusted) exactly the lines given? */
function sameLines(
	held: readonly ReportingProductLine[] | null,
	want: readonly ReportingProductLine[],
): boolean {
	// Key order is not compared: Postgres reads a guarded write back through jsonb.
	return held !== null && canonicalJson(held) === canonicalJson(want);
}

/** A month's day documents summed by currency — what `rebuildMonth` stores. */
function sumMonth(
	days: readonly { data: ReportingDailyStoredDoc }[],
): Record<string, ReportingMonthCurrency> {
	const sums = new Map<
		string,
		ReportingMonthCurrency & { lines: Map<string, ReportingProductLine> | null }
	>();
	for (const { data } of days) {
		const doc = normalizeReportingDailyDoc(data);
		const held = sums.get(doc.currency) ?? {
			stateCounts: {},
			revenueOrders: 0,
			revenueCents: 0,
			refundEntries: 0,
			refundedCents: 0,
			products: null,
			lines: new Map<string, ReportingProductLine>(),
		};
		for (const [state, count] of Object.entries(doc.stateCounts)) {
			held.stateCounts[state] = (held.stateCounts[state] ?? 0) + count;
		}
		held.revenueOrders += doc.revenueOrders;
		held.revenueCents = addAggregate(held.revenueCents, doc.revenueCents);
		held.refundEntries += doc.refundEntries;
		held.refundedCents = addAggregate(held.refundedCents, doc.refundedCents);
		const lines = storedProductLines(data);
		if (lines === null) held.lines = null;
		else if (held.lines !== null) for (const line of lines) addProductLine(held.lines, line);
		sums.set(doc.currency, held);
	}
	const out: Record<string, ReportingMonthCurrency> = {};
	for (const [currency, { lines, ...sum }] of [...sums].toSorted((a, b) =>
		codeUnitAsc(a[0], b[0]),
	)) {
		out[currency] = {
			...sum,
			stateCounts: normalizeStateCounts(sum.stateCounts),
			products: lines === null ? null : sortedProductLines(lines),
		};
	}
	return out;
}

/**
 * A month's sums with any currency's product lines past `max` groups dropped to
 * `null`: a month document is one row, and a catalogue that sells thousands of
 * distinct `(productId, title)` groups in a month would make it a large one to store
 * and to parse on every long report. A reader then takes that month's days.
 */
function capMonthLines(
	currencies: Record<string, ReportingMonthCurrency>,
	max: number,
): Record<string, ReportingMonthCurrency> {
	const out: Record<string, ReportingMonthCurrency> = {};
	for (const [currency, sums] of Object.entries(currencies)) {
		out[currency] =
			sums.products !== null && sums.products.length > max ? { ...sums, products: null } : sums;
	}
	return out;
}

/** The `YYYY-MM` months whose every day lies in `[fromDay, toDay]`, in order. */
function wholeMonthsBetween(fromDay: string, toDay: string): string[] {
	const months: string[] = [];
	for (let month = monthKeyOf(fromDay); ; month = nextMonth(month)) {
		const { first, last } = monthDays(month);
		if (last > toDay) return months;
		if (first >= fromDay) months.push(month);
	}
}

/** The calendar month after a `YYYY-MM` month. */
function nextMonth(month: string): string {
	return monthKeyOf(nextDay(monthDays(month).last));
}

/** Day runs sorted and joined where one ends the day before the next begins. */
function mergeRuns(runs: readonly (readonly [string, string])[]): [string, string][] {
	const merged: [string, string][] = [];
	for (const [from, to] of runs.toSorted((a, b) => codeUnitAsc(a[0], b[0]))) {
		const tail = merged.at(-1);
		if (tail !== undefined && nextDay(tail[1]) >= from) {
			if (to > tail[1]) tail[1] = to;
		} else {
			merged.push([from, to]);
		}
	}
	return merged;
}

/** A set of days as the runs of consecutive days it is made of. */
function dayRuns(days: readonly string[]): [string, string][] {
	return mergeRuns(days.map((day) => [day, day] as const));
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
	/** Does the event move an order into or out of the revenue set (issue #572)? */
	movesProducts: boolean;
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

	const plan: DeltaPlan = {
		where: {},
		delta: {},
		floored: [],
		movesProducts:
			event.kind === "transition" &&
			(event.fromState !== null && REVENUE_STATES.has(event.fromState)) !==
				REVENUE_STATES.has(event.toState),
	};
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
