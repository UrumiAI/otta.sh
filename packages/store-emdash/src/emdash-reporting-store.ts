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
 * **The window is resolved to whole UTC days**, because the day is the grain. A window
 * whose bounds are day-aligned — which is what every caller of this port issues, and
 * what the domain's own contract windows are — is therefore EXACT against the SQL's
 * `created_at BETWEEN from AND to`. A window that cuts a day in half cannot be: this
 * adapter includes the whole of both edge days, where the statement would have counted
 * only the orders inside the instants. That is the one read divergence from the SQL
 * tier, it is in the direction of reporting more of an edge day rather than less, and
 * it is a property of the grain rather than a bug to fix — resolving it would mean
 * keeping a document per order, which is the read-time scan this design replaced.
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
	newReportingDailyDoc,
	normalizeReportingDailyDoc,
	normalizeStateCounts,
	REPORTING_APPLIED_COLLECTION,
	REPORTING_DAILY_COLLECTION,
	reportingDailyDocId,
	reportingRefundClaimId,
	reportingTransitionClaimId,
	REVENUE_STATES,
	type ReportingAppliedDoc,
	type ReportingDailyDoc,
	type ReportingOrderEvent,
} from "./reporting-documents.js";
import type { StorageAccess, StorageCollection, WhereClause } from "./storage-access.js";

/** The host clamps `limit` at 100, so that is the page every scan here reads. */
const PAGE_SIZE = 100;

/** Page ceiling for one report read. A year of daily buckets is four pages. */
const MAX_REPORT_PAGES = 1000;

/** Page ceiling for one recompute, across every day in its range. */
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
	/** Page ceiling for a recompute scan. Raised independently of the read budget:
	 *  the two are bounded by different things (documents versus orders). */
	maxReconcilePages?: number;
}

/** What a recompute did — the numbers a scheduled sweep logs. */
export interface ReportingReconcileResult {
	/** How many UTC days the range covered. */
	days: number;
	/** How many day documents were actually rewritten (an already-exact one is not). */
	documentsWritten: number;
	/** How many orders the recompute read. */
	ordersScanned: number;
	/** How many claims it created or stamped, having folded their events in. */
	claimsMarked: number;
}

/** A paging budget shared by every scan inside one call. */
interface PageBudget {
	readonly limit: number;
	used: number;
	scanned: number;
	readonly option: string;
}

export class EmdashReportingStore implements ReportingStore {
	readonly #daily: StorageCollection<ReportingDailyDoc>;
	readonly #applied: StorageCollection<ReportingAppliedDoc>;
	readonly #orders: StorageCollection<OrderDoc>;
	readonly #inventory: StorageCollection<InventoryDoc>;
	readonly #products: StorageCollection<ProductCommerceDoc>;
	readonly #skuOwners: StorageCollection<SkuOwnerDoc>;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxReportPages: number;
	readonly #maxReconcilePages: number;

	constructor(options: EmdashReportingStoreOptions) {
		this.#daily = collectionOf<ReportingDailyDoc>(options.storage, REPORTING_DAILY_COLLECTION);
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
	 * claim   reporting_applied/{claim} create-if-absent — the once-only gate
	 * counters reporting_daily/{currency}:{day} compare-and-set — the value
	 * stamp   the claim's `appliedAt`, best-effort, as a diagnostic
	 * ```
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
		};
		const created = await this.#applied.compareAndSet(claimId, null, claim);
		// A refused create means a peer holds this event. Its delta is that caller's to
		// apply, and applying it here as well is precisely the double count the claim
		// exists to prevent.
		if (!created.applied) return;

		await this.#applyEvent(event, day, now);

		// The stamp is a DIAGNOSTIC and never a gate (see `ReportingAppliedDoc`): it is
		// what makes a claim-only residue legible. A lost stamp changes no answer, so the
		// result is not inspected.
		await this.#applied.compareAndSet(claimId, created.revision, { ...claim, appliedAt: now });
	}

	/** Move the day document's counters, under the compare-and-set retry budget. */
	async #applyEvent(event: ReportingOrderEvent, day: string, now: string): Promise<void> {
		const docId = reportingDailyDocId(event.currency, day);
		await withCasRetry<void>(
			"recordReportingEvent",
			async () => {
				const held = await this.#daily.getVersioned(docId);
				const base =
					held === null
						? newReportingDailyDoc(event.currency, day, now)
						: normalizeReportingDailyDoc(held.value);
				const next =
					event.kind === "transition"
						? applyTransition(base, event, now)
						: applyRefund(base, event, now);
				const written = await this.#daily.compareAndSet(docId, held?.revision ?? null, next);
				return written.applied ? casDone(undefined) : CAS_RETRY;
			},
			this.#retry,
		);
	}

	/**
	 * Recompute every day document in the range from the ORDERS, and re-establish the
	 * claims for the events it folded in.
	 *
	 * This is the routine a scheduled sweep runs, and it is the definition the delta
	 * stream is a cache of: a day's counters are whatever a scan of the orders created
	 * that day says they are.
	 *
	 * **It is safe to run while events are landing, and the day document's revision is
	 * what makes it so.** Each day is recomputed and committed under one compare-and-set
	 * pinned to the revision the recompute read; if a live event commits first the
	 * recompute loses that write, RE-SCANS the day and recomputes. That is what makes the
	 * re-attempt sound rather than a clobber: the hook writes the ORDER before it writes
	 * the rollup, so any delta that has landed is a state the next scan can see, and a
	 * delta that has not landed yet will be applied on top of a value that already
	 * counts it — which is a no-op, because the claim it holds makes it once-only. The
	 * one interleaving left is an event whose order write landed and whose rollup did
	 * not: that is the under-count this routine exists for, and the next run takes it.
	 *
	 * The claims are marked AFTER the counters, and each is marked applied: the counters
	 * are absolute at that point, so an event already reflected in them must not be able
	 * to move them again.
	 */
	async reconcile(range: DateRange): Promise<ReportingReconcileResult> {
		const fromDay = dayKeyOf(range.from);
		const toDay = dayKeyOf(range.to);
		const days = dayKeysBetween(fromDay, toDay);
		const budget: PageBudget = {
			limit: this.#maxReconcilePages,
			used: 0,
			scanned: 0,
			option: "maxReconcilePages",
		};
		let documentsWritten = 0;
		let claimsMarked = 0;
		for (const day of days) {
			const done = await this.#reconcileDay(day, budget);
			documentsWritten += done.written;
			claimsMarked += done.claims;
		}
		return { days: days.length, documentsWritten, ordersScanned: budget.scanned, claimsMarked };
	}

	async #reconcileDay(
		day: string,
		budget: PageBudget,
	): Promise<{ written: number; claims: number }> {
		return withCasRetry<{ written: number; claims: number }>(
			"reconcileReportingDay",
			async () => {
				const now = this.#clock.now().toISOString();
				const orders = await this.#scanOrders(
					{ createdAt: { gte: dayStartOf(day), lte: dayEndOf(day) } },
					budget,
					"reconcileReporting",
				);
				const computed = computeDay(day, orders, now);
				const existing = await this.#dayDocIds(day, budget);

				let written = 0;
				for (const currency of [...new Set([...computed.keys(), ...existing])].toSorted()) {
					const docId = reportingDailyDocId(currency, day);
					const held = await this.#daily.getVersioned(docId);
					// A day that has lost every order keeps a ZEROED document rather than
					// being deleted: a live event racing this write needs a revision to lose
					// to, and an all-zero document is read as no bucket at all.
					const target = {
						...(computed.get(currency) ?? newReportingDailyDoc(currency, day, now)),
						updatedAt: now,
					};
					if (held !== null && sameCounters(normalizeReportingDailyDoc(held.value), target)) {
						continue;
					}
					const applied = await this.#daily.compareAndSet(docId, held?.revision ?? null, target);
					// A peer moved this day while the recompute was reading it. Re-scan: the
					// value in hand was derived from an older snapshot of the orders.
					if (!applied.applied) return CAS_RETRY;
					written++;
				}

				const claims = await this.#markClaims(orders, now);
				return casDone({ written, claims });
			},
			this.#retry,
		);
	}

	/**
	 * Create-or-stamp the claim for every event the recompute just folded in, so a
	 * redelivery after a heal cannot move a counter that already counts it.
	 *
	 * The events are read off the order itself: its append-only audit log carries every
	 * `(fromState → toState)` pair the flips wrote, its refunds ledger carries every
	 * finalized refund, and the arrival into its ORIGINAL state — the one the creating
	 * write set, which the log records as the first event's `fromState` — is the event
	 * creation owes. An order with no log at all is one whose current state is the state
	 * it arrived in.
	 */
	async #markClaims(orders: OrderDoc[], now: string): Promise<number> {
		let marked = 0;
		for (const order of orders) {
			const events: ReportingOrderEvent[] = [];
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
			for (const event of events) {
				if (await this.#markApplied(event, now)) marked++;
			}
		}
		return marked;
	}

	/** One claim, created or stamped. `false` when it was already stamped. */
	async #markApplied(event: ReportingOrderEvent, now: string): Promise<boolean> {
		const claimId = claimIdFor(event);
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
				amountCents: event.kind === "refund" ? event.refundedCents : null,
				claimedAt: now,
				appliedAt: now,
			});
			return created.applied;
		}
		if (held.value.appliedAt !== null) return false;
		// Guarded on the revision that still had a null stamp, so a concurrent applier
		// is never overwritten.
		const stamped = await this.#applied.compareAndSet(claimId, held.revision, {
			...held.value,
			appliedAt: now,
		});
		return stamped.applied;
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
		for (const doc of await this.#scanDays(range, "revenueByPeriod")) {
			const bucketStart = bucketStartOf(doc.date, interval);
			const key = `${bucketStart} ${doc.currency}`;
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
				// semantics: a day whose only activity was a refund is a row at revenue 0, and
				// a genuinely zero-total order is a row rather than an absence.
				.filter((group) => group.revenueOrders > 0 || group.refundEntries > 0)
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
		for (const doc of await this.#scanDays(range, "ordersByStatus")) {
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
				const key = `${item.productId} ${item.title}`;
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
	 * Every day document in the window, in ascending date order, paged at the host's
	 * clamp.
	 *
	 * A year of daily buckets in one currency is four pages, which is why the budget is
	 * a budget rather than an assumption — and why exceeding it is a typed refusal. A
	 * report that silently stopped at its last page would be a wrong number rather than
	 * a missing one.
	 */
	async #scanDays(range: DateRange, operation: string): Promise<ReportingDailyDoc[]> {
		const fromDay = dayKeyOf(range.from);
		const toDay = dayKeyOf(range.to);
		if (toDay < fromDay) return [];
		const docs: ReportingDailyDoc[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxReportPages; page++) {
			const result = await this.#daily.query({
				where: { date: { gte: fromDay, lte: toDay } },
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
	async #dayDocIds(day: string, budget: PageBudget): Promise<string[]> {
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

/** Which claim an event is filed under. */
function claimIdFor(event: ReportingOrderEvent): string {
	return event.kind === "transition"
		? reportingTransitionClaimId(event.orderId, event.fromState, event.toState)
		: reportingRefundClaimId(event.orderId, event.refundId);
}

/**
 * Move an order between state buckets, and revenue with it.
 *
 * Every decrement is FLOORED at zero, which is the one place this adapter tolerates
 * being wrong: a decrement whose matching increment was lost (a rollup that never
 * landed, an event redelivered after a restore) would otherwise drive a counter
 * negative and report a negative revenue — a number no report should ever be able to
 * show. Flooring resolves it as an under-count instead, and the recompute is what makes
 * it exact.
 */
function applyTransition(
	base: ReportingDailyDoc,
	event: Extract<ReportingOrderEvent, { kind: "transition" }>,
	now: string,
): ReportingDailyDoc {
	const counts: Record<string, number> = { ...base.stateCounts };
	let revenueOrders = base.revenueOrders;
	let revenueCents = base.revenueCents;
	if (event.fromState !== null) {
		counts[event.fromState] = Math.max(0, (counts[event.fromState] ?? 0) - 1);
		if (REVENUE_STATES.has(event.fromState)) {
			revenueOrders = Math.max(0, revenueOrders - 1);
			revenueCents = Math.max(0, revenueCents - event.orderTotalCents);
		}
	}
	counts[event.toState] = (counts[event.toState] ?? 0) + 1;
	if (REVENUE_STATES.has(event.toState)) {
		revenueOrders += 1;
		revenueCents = addAggregate(revenueCents, event.orderTotalCents);
	}
	return {
		...base,
		stateCounts: normalizeStateCounts(counts),
		revenueOrders,
		revenueCents,
		updatedAt: now,
	};
}

/** Add a finalized refund to the day's returned money. No state allow-list applies. */
function applyRefund(
	base: ReportingDailyDoc,
	event: Extract<ReportingOrderEvent, { kind: "refund" }>,
	now: string,
): ReportingDailyDoc {
	return {
		...base,
		refundEntries: base.refundEntries + 1,
		refundedCents: addAggregate(base.refundedCents, event.refundedCents),
		updatedAt: now,
	};
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
