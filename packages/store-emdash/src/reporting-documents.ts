/**
 * The reporting documents: one precomputed counter set per (currency, UTC day), and
 * one claim per rollup event.
 *
 * The SQL computed every report on READ — one statement over `orders`,
 * `order_totals`, `order_items` and `refunds`, with the period bucket as a
 * dialect-branched `date_trunc`. A plugin has no join, no `GROUP BY` and no raw SQL,
 * so two of the four reports move to WRITE time and become documents:
 *
 * | Document | What it is |
 * |---|---|
 * | `reporting_daily/{currency}:{YYYY-MM-DD}` | the orders CREATED that UTC day in that currency: how many sit in each state, how much of it counts as revenue, and how much came back |
 * | `reporting_applied/{claim}` | one rollup event's claim — what makes a redelivered event a no-op |
 *
 * **The day is the grain, and the other two intervals are folds over it.** A week is
 * the seven day documents from its ISO Monday and a month is its own days. The one
 * document keyed by a month, `reporting_monthly`, is a CACHE of those days that a
 * reader uses only while it is provably their sum (see {@link ReportingMonthlyDoc}).
 * That is only sound because every boundary here is UTC and every coarser bucket is a
 * union of whole UTC days — which is exactly what the SQL's `date_trunc(…, AT TIME
 * ZONE 'UTC')` and `strftime(…)` computed, so the fold and the statement agree by
 * construction rather than by testing.
 *
 * **The bucket is keyed on the order's CREATION day, never on the day anything
 * happened to it.** A transition on an order created three months ago moves
 * three-month-old counters, and a refund issued today lands in the day the order was
 * placed. Both follow from the port: revenue is bucketed on `orders.created_at` and
 * counts only orders whose CURRENT state is revenue-counting, and a bucket's
 * `refundedCents` answers "what did the orders placed in this period give back",
 * which is the only reading under which the two figures in one row are comparable.
 *
 * **Why the state counts are a map and the revenue is two numbers beside it.**
 * `ordersByStatus` needs every state, including the excluded ones, so a transition is
 * a MOVE: decrement the state the order is leaving, increment the one it enters. The
 * revenue figure cannot be derived from that map, because it sums totals rather than
 * counting orders, so it moves with it — in when a state in the allow-list is entered,
 * out when one is left. `revenueOrders` is not decoration either: it is what
 * distinguishes "no order in this bucket counts as revenue" from "an order whose total
 * really is zero", and the SQL distinguishes them (a zero-total row still produces a
 * bucket), so the document has to.
 */
import { REVENUE_COUNTING_STATES, type ReportInterval } from "@urumi.ai/otta-domain";
import { codeUnitAsc } from "./product-commerce-documents.js";

/** Collection name: the precomputed day counters. */
export const REPORTING_DAILY_COLLECTION = "reporting_daily";
/** Collection name: one claim per applied rollup event. */
export const REPORTING_APPLIED_COLLECTION = "reporting_applied";
/**
 * Collection name: one document per UTC calendar month, the sum of that month's day
 * documents in every currency (issue #572). See {@link ReportingMonthlyDoc}.
 */
export const REPORTING_MONTHLY_COLLECTION = "reporting_monthly";

/** One collection as the plugin descriptor declares it. */
export interface ReportingCollectionIndexDeclaration {
	readonly indexes?: readonly (string | readonly string[])[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The two reporting collections, with the indexes each must declare. A declared
 * index is a **read contract**, not a performance knob: `where`/`orderBy` on an
 * undeclared field is a runtime `StorageQueryError`, so this list and the
 * descriptor's must not drift.
 *
 * `date` is what every report binds — a range plus an `orderBy`, which is how a
 * window is paged in ascending bucket order. `currency` is declared because a
 * single-currency read is a legitimate narrowing of the same scan, and because the
 * document id is `{currency}:{date}` rather than the date alone, so a date-only
 * query cannot be answered by an id prefix.
 *
 * `reporting_applied` declares `date` and `orderId`. `date` is the one a recompute reads:
 * a day's claims are exactly the claims whose `date` is that day, so they come back as
 * pages of one indexed query rather than as a query per order — which is what keeps the
 * recompute's cost a function of the day's SIZE rather than of its order count. `orderId`
 * is the diagnostic axis: "which rollup events have been applied to this order" is the
 * question that makes an under-count legible.
 */
export const REPORTING_COLLECTIONS: Readonly<Record<string, ReportingCollectionIndexDeclaration>> =
	{
		// `(productsDirty, date)` is what the rollup sweep finds a day whose product lines
		// need building by (issue #572): `productsDirty` is `1` when an order of the day
		// entered or left the revenue set and absent on a document written before product
		// lines existed, and the sweep lists them newest first below a date. A COMPOSITE,
		// not a lone `productsDirty`: the host never runs `ANALYZE`, so SQLite (and D1)
		// would plan `{ productsDirty: null, date < X } ORDER BY date DESC LIMIT 10` on the
		// date range alone and read every day document in it, built or not; the composite
		// reads only the unbuilt ones (`reporting-index-plan.test.ts` pins the plans). The
		// dirty page (`productsDirty: 1`, a number) cannot use it — the host's numeric type
		// guard matches no expression index — and is bounded by the sweep's history floor.
		// Its fields are queryable on their own: the host folds a composite into the
		// allow-list field by field.
		[REPORTING_DAILY_COLLECTION]: { indexes: ["currency", "date", ["productsDirty", "date"]] },
		// `(appliedAt, date)` (issue #572): a month rebuild counts the month's claims still
		// unstamped (`appliedAt: null` over the month's dates) — events that may not have
		// moved their day yet — and the claim heal lists and stamps them by day. The same
		// composite reasoning as above: equality first, then the date range.
		[REPORTING_APPLIED_COLLECTION]: { indexes: ["date", "orderId", ["appliedAt", "date"]] },
		// `month` is what a long window binds and what the verifier walks in order. The
		// sweep's dirty-month list reads the same index and filters `dirty` in memory: the
		// collection holds one document per calendar month (about a hundred over eight
		// years), so a `dirty` index would buy nothing but an index row on every
		// `_plugin_storage` write, every plugin's included (DEPLOYMENT.md §5).
		[REPORTING_MONTHLY_COLLECTION]: { indexes: ["month"] },
	};

/** The revenue-counting allow-list as a set — built once from the domain constant. */
export const REVENUE_STATES: ReadonlySet<string> = new Set(REVENUE_COUNTING_STATES);

/**
 * The ONE refund status that is money which actually came back — the finalized set,
 * the same rows the order's refunded badge and the `→ refunded` flip are based on.
 * Deliberately an equality rather than "not voided": the active set is the refund
 * CEILING's arbitration rule, and reusing it here would report an in-flight attempt
 * as a completed refund.
 */
export const FINALIZED_REFUND_STATUS = "recorded";

/**
 * `reporting_daily/{currency}:{YYYY-MM-DD}` — the orders created that UTC day.
 *
 * Every counter is an integer, and every one of them is a DERIVED value: the orders
 * are the truth and this document is a cache of an aggregate over them, which is what
 * makes a recompute possible at all (see `EmdashReportingStore.reconcile`).
 */
export interface ReportingDailyDoc {
	/** INDEXED — the currency half of the document id, repeated as a field. */
	currency: string;
	/** INDEXED — `YYYY-MM-DD`, the UTC day. What every window range binds. */
	date: string;
	/**
	 * How many of the day's orders sit in each state RIGHT NOW, by
	 * `orders.state`. Zero-valued states are dropped rather than stored, and the keys
	 * are kept in sorted order, so a document written by a delta stream and the same
	 * document written by a recompute are byte-identical.
	 */
	stateCounts: Record<string, number>;
	/**
	 * How many of the day's orders are currently in a revenue-counting state. A bucket
	 * EXISTS for a report when this is above zero (or a refund landed), which is how a
	 * genuinely zero-total order stays a row rather than vanishing.
	 */
	revenueOrders: number;
	/** The summed net totals of those orders, in minor units. */
	revenueCents: number;
	/** How many FINALIZED refunds have landed against the day's orders. */
	refundEntries: number;
	/** The summed amount of those refunds, in minor units. */
	refundedCents: number;
	/** When this document last moved. Not part of its value. */
	updatedAt: string;
}

/**
 * The name of the top-level field a state's count is STORED under: `state_<state>`.
 *
 * The counts are stored flat, one numeric field per state, rather than as the nested
 * `stateCounts` map {@link ReportingDailyDoc} presents, because the host's guarded
 * numeric delta (`updateIf`'s `delta`) addresses a top-level field and nothing deeper.
 * That is what lets an event land as ONE atomic statement instead of a read-modify-write
 * loop (see `ReportingDailyStoredDoc`). A state that could not be a field name is a
 * programming error rather than data, since the states are the domain's fixed enum, so
 * it is refused loudly rather than escaped.
 */
export function stateCountField(state: string): StateCountField {
	if (!STATE_NAME.test(state)) {
		throw new RangeError(`order state '${state}' cannot be stored as a reporting counter field`);
	}
	return `${STATE_FIELD_PREFIX}${state}`;
}

/** A stored per-state counter field. */
export type StateCountField = `state_${string}`;

const STATE_FIELD_PREFIX = "state_";

/** What the host accepts as a field name, less the prefix: `^[a-zA-Z][a-zA-Z0-9_]*$`. */
const STATE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * `reporting_daily/{currency}:{YYYY-MM-DD}` AS STORED. {@link ReportingDailyDoc} is the
 * value every reader works with, and {@link normalizeReportingDailyDoc} is the only way
 * from this shape to that one.
 *
 * **Two shapes exist, and both are read.**
 *
 * - **Current (`epoch` is a number).** Every counter is a top-level integer field and
 *   the state counts are `state_<state>` fields, so a live event is a single guarded
 *   numeric delta. Zero-valued state fields may be present (a delta decrements to 0 and
 *   leaves the field) and are dropped on read.
 * - **Legacy (no `epoch`).** The nested `stateCounts` map that the first rollup wrote.
 *   It is read as it stands, and migrated forward by a revision compare-and-set the
 *   first time anything writes it (the delta path, or a recompute that has something to
 *   commit). No delta ever lands on a legacy document, because every delta is guarded on
 *   `epoch` and a legacy document has none.
 *
 * **`epoch` and `seq` are the two guards that make a delta and a recompute safe
 * together, and they move independently:**
 *
 * - `epoch` is moved ONLY by a recompute's commit, a migration or an un-taint. A delta
 *   is guarded on the epoch it read before its claim was last checked, so a delta whose
 *   event a recompute has since counted absolutely is refused atomically, and re-checks
 *   its claim. It only ever increases EXCEPT across a mixed-version window: an older
 *   version of this adapter can write back the epoch it read (a hybrid) or drop it (a
 *   legacy rewrite), and a first migration with nothing known starts it at 0. Every write
 *   of this version moves it past the highest epoch it knows of, and `reconcile` heals
 *   whatever a rewound epoch let through.
 * - `seq` is bumped by EVERY delta. A recompute commits guarded on the `(epoch, seq)` it
 *   pinned before scanning, so a delta landing after the pin costs it the commit.
 *
 * The host's `updateIf` never moves a document's revision, so neither guard could be the
 * revision: a revision pin would not see a delta at all.
 */
export interface ReportingDailyStoredDoc {
	currency: string;
	date: string;
	/** Bumped by a recompute's commit only. Absent on a legacy document. */
	epoch?: number;
	/** Bumped by every delta. Absent on a legacy document. */
	seq?: number;
	revenueOrders?: number;
	revenueCents?: number;
	refundEntries?: number;
	refundedCents?: number;
	/**
	 * LEGACY only: the nested per-state map the first rollup stored. On a document that
	 * also carries `epoch` it is a TAINT (see {@link isHybridReportingDailyDoc}), and the
	 * next live event or recompute clears it to `null`.
	 */
	stateCounts?: Record<string, number> | null;
	updatedAt?: string;
	/**
	 * The day's top-products figures: one line per `(productId, title)` sold that day in
	 * this currency, over the orders currently in a revenue-counting state (issue #572).
	 * BUILT, never moved by a delta: a recompute or a product build writes it from the
	 * day's orders, because one event can touch any number of products and a guarded
	 * delta addresses a bounded number of fields. See {@link storedProductLines}.
	 */
	products?: ReportingProductLine[] | null;
	/**
	 * Whether {@link products} still describes the day. `0`: it does. `1`: an order of
	 * the day has entered or left the revenue set since it was built, so a reader scans
	 * the day's orders instead and the rollup sweep rebuilds it. ABSENT: the document
	 * predates product lines (a store upgraded across #572), which reads exactly like
	 * `1` and is what the sweep's backfill finds.
	 */
	productsDirty?: number;
	/**
	 * The `epoch` the {@link products} were built at. Every writer in this version that
	 * moves `epoch` (a recompute's commit) writes the lines with it, and a product build
	 * is guarded on the epoch it stamps — so a line set whose epoch is not the
	 * document's was left behind by a writer that does not know about lines: a
	 * recompute from a build older than #572 running in a rollback or mixed-version
	 * window. Such lines are untrusted, exactly as dirty ones are.
	 */
	productsEpoch?: number;
	/** The per-state counters, one field per state (current shape only). */
	[field: StateCountField]: number | undefined;
}

/** A current-shape stored document: its guards are present. */
export type CurrentReportingDailyDoc = ReportingDailyStoredDoc & { epoch: number; seq: number };

/** Does this stored document carry the two guards (current, or a hybrid)? */
export function hasReportingDailyGuards(
	doc: ReportingDailyStoredDoc,
): doc is CurrentReportingDailyDoc {
	return typeof doc.epoch === "number" && typeof doc.seq === "number";
}

/**
 * Is this a current-shape document that an OLDER version of this adapter has since
 * rewritten? The old write path spreads the document it read and adds a nested
 * `stateCounts` map built from nothing (it never knew the flat fields), so what it leaves
 * is the guards and flat counters it read, plus a map holding only its own increments,
 * and any delta that landed between its read and its write is gone. The only moment that
 * happens is a mixed-version deploy or a rollback. Such a document is TAINTED.
 *
 * It is read by its flat fields alone: the old writer's revenue landed in the top-level
 * fields, and its state move shows as an order left in the state it came from, which is
 * the under-count residue this tier already heals. The next live event UN-TAINTS it in one
 * guarded write (the map set to `null`, the epoch moved) and applies against the flat
 * fields, announcing a `tainted` anomaly (see the store's `#currentDay`). It does not
 * recompute the day inline: only `reconcile` recovers the discarded deltas.
 */
export function isHybridReportingDailyDoc(doc: ReportingDailyStoredDoc): boolean {
	return (
		hasReportingDailyGuards(doc) && typeof doc.stateCounts === "object" && doc.stateCounts !== null
	);
}

/** Is this stored document the current (flat, guarded, untainted) shape? */
export function isCurrentReportingDailyDoc(
	doc: ReportingDailyStoredDoc,
): doc is CurrentReportingDailyDoc {
	return hasReportingDailyGuards(doc) && !isHybridReportingDailyDoc(doc);
}

/** The state-count fields a stored document carries, by state name. */
export function storedStateCounts(doc: ReportingDailyStoredDoc): Record<string, number> {
	// A document with guards is read by its flat fields, hybrid or not (see above).
	if (!hasReportingDailyGuards(doc)) return { ...doc.stateCounts };
	const counts: Record<string, number> = {};
	for (const [field, value] of Object.entries(doc)) {
		if (!field.startsWith(STATE_FIELD_PREFIX) || typeof value !== "number") continue;
		counts[field.slice(STATE_FIELD_PREFIX.length)] = value;
	}
	return counts;
}

/**
 * A logical day document written out in the CURRENT stored shape, at the given guards.
 * This is what a creation, a migration and a recompute's full rewrite store.
 */
export function toStoredReportingDailyDoc(
	doc: ReportingDailyDoc,
	epoch: number,
	seq: number,
	products?: readonly ReportingProductLine[],
): CurrentReportingDailyDoc {
	const stored: CurrentReportingDailyDoc = {
		currency: doc.currency,
		date: doc.date,
		epoch,
		seq,
		revenueOrders: doc.revenueOrders,
		revenueCents: doc.revenueCents,
		refundEntries: doc.refundEntries,
		refundedCents: doc.refundedCents,
		updatedAt: doc.updatedAt,
	};
	// Lines given are lines BUILT from the day's orders (or a new, empty day): clean.
	// None given keeps the document's product lines unknown, which reads as dirty.
	if (products !== undefined) {
		stored.products = [...products];
		stored.productsDirty = 0;
		stored.productsEpoch = epoch;
	}
	for (const [state, count] of Object.entries(normalizeStateCounts(doc.stateCounts))) {
		stored[stateCountField(state)] = count;
	}
	return stored;
}

/** Which kind of event a claim records. */
export type ReportingEventKind = "transition" | "refund";

/**
 * `reporting_applied/{claim}` — one rollup event, claimed.
 *
 * **It is written BEFORE the counters, and that ordering is the design.** The claim is
 * what makes a redelivered event a no-op, so it has to be durable before the write it
 * guards; the cost is that a crash between the two leaves an event claimed and the
 * counters short. That residue is an UNDER-count — less revenue than came in, and
 * never an order counted in two state buckets at once — which is the direction this
 * tier resolves every residual in, and the recompute is what makes it exact again
 * (ADR-0019's cross-cutting rule (c)).
 *
 * `appliedAt` is therefore a DIAGNOSTIC, never a gate: a claim with a null stamp may
 * or may not have moved the counters (the crash could have landed on either side of
 * the write), so nothing reads it to decide whether to apply. It is what makes the
 * residue legible to an operator and to the recompute's own report.
 *
 * **`absorbedAt` IS a gate, and it is the only one.** A recompute that has counted this
 * event's effect absolutely — from the order document itself — takes away the right this
 * claim confers, because a delta applied on top of an absolute recount is a double count.
 * So the recompute stamps it before it commits its counters, and its commit bumps the day
 * document's `epoch`. The delta is guarded on the epoch it read before the claim was last
 * checked, so a delta parked past that commit is refused by its own write, re-reads the
 * claim, and drops itself when it is stamped (ADR-0019's cross-cutting rule (a): the token
 * is re-asserted before every write it guards, on every attempt, because a writer parked
 * past the moment its right was revoked must not wake up and commit anyway).
 */
export interface ReportingAppliedDoc {
	/** INDEXED — which order this event belongs to. */
	orderId: string;
	kind: ReportingEventKind;
	/**
	 * INDEXED — the `YYYY-MM-DD` bucket the event was applied to, which is the order's
	 * creation day. It is what a recompute pages a day's claims by.
	 */
	date: string;
	currency: string;
	/** The state left, or `null` when the order arrived (creation). Transitions only. */
	fromState: string | null;
	/** The state entered. Transitions only. */
	toState: string | null;
	/** Which refund this is. Refund events only. */
	refundId: string | null;
	/** The refund's amount in minor units. Refund events only. */
	amountCents: number | null;
	claimedAt: string;
	/** When the counter write was observed to land. Diagnostic — see the docblock. */
	appliedAt: string | null;
	/**
	 * When a recompute counted this event's effect absolutely, revoking the right to
	 * apply its delta. THE one gate — see the docblock.
	 */
	absorbedAt: string | null;
}

/**
 * One rollup event: an order's transition between states, or a finalized refund
 * against it.
 *
 * Both carry the order's own creation instant and currency, because the bucket they
 * belong to is a property of the ORDER, not of the event. A transition carries the
 * order's net total, because entering or leaving a revenue-counting state moves that
 * figure and re-reading the order to find it would race the next write.
 */
export type ReportingOrderEvent =
	| {
			readonly kind: "transition";
			readonly orderId: string;
			/** ISO-8601 UTC. The bucket is this instant's UTC day, always. */
			readonly orderCreatedAt: string;
			readonly currency: string;
			/** `null` when the order was just created — there is no bucket to leave. */
			readonly fromState: string | null;
			readonly toState: string;
			/** The order's net total in minor units (`order_totals.total_cents`). */
			readonly orderTotalCents: number;
	  }
	| {
			readonly kind: "refund";
			readonly orderId: string;
			readonly orderCreatedAt: string;
			/** The REFUND's currency, which is the bucket it lands in. */
			readonly currency: string;
			readonly refundId: string;
			readonly refundedCents: number;
	  };

/**
 * What the order store hands the rollups after an order write is durable.
 *
 * It is one method on purpose: the order store must be able to satisfy it with a
 * no-op, and must never depend on what the implementation does with the event. A
 * writer that throws is a reporting outage, not a failed transition.
 */
export interface ReportingRollupWriter {
	recordOrderEvent(event: ReportingOrderEvent): Promise<void>;
}

/** The day document's id. The currency is a fixed-width code and the date a fixed
 *  format, so neither half can contain the separator. */
export function reportingDailyDocId(currency: string, date: string): string {
	return `${currency}:${date}`;
}

/**
 * A transition's claim id.
 *
 * The key is `(orderId, fromState → toState)` because that is the unit the port makes
 * once-only: the same transition delivered twice is one move between buckets. The
 * order state machine never revisits a state, so a repeated `(from, to)` pair is
 * always a redelivery rather than a second, genuine move — and if that ever changed,
 * this id is where it would have to change with it.
 */
export function reportingTransitionClaimId(
	orderId: string,
	fromState: string | null,
	toState: string,
): string {
	return `${escapeIdPart(orderId)}:${fromState === null ? "" : escapeIdPart(fromState)}>${escapeIdPart(toState)}`;
}

/** A refund's claim id — one per refund ledger row, whatever else moves. */
export function reportingRefundClaimId(orderId: string, refundId: string): string {
	return `${escapeIdPart(orderId)}:refund:${escapeIdPart(refundId)}`;
}

/**
 * Escape the separators out of one id part.
 *
 * A document id assembled from two caller-supplied strings is only unique if neither
 * can spell the separator: without this, an order id containing a colon could collide
 * with another order's refund claim. Percent-encoding the escape character itself
 * first is what keeps the encoding reversible and therefore injective.
 */
function escapeIdPart(part: string): string {
	return part.replaceAll("%", "%25").replaceAll(":", "%3A").replaceAll(">", "%3E");
}

/** A fresh, empty day document. */
export function newReportingDailyDoc(
	currency: string,
	date: string,
	at: string,
): ReportingDailyDoc {
	return {
		currency,
		date,
		stateCounts: {},
		revenueOrders: 0,
		revenueCents: 0,
		refundEntries: 0,
		refundedCents: 0,
		updatedAt: at,
	};
}

/**
 * Drop the zero-valued states and sort what is left.
 *
 * Both halves are load-bearing rather than tidy: a state that has emptied must not
 * read as a bucket with no orders in it, and a document's JSON must not depend on the
 * ORDER counters happened to be touched in — otherwise the same aggregate written by
 * a delta stream and by a recompute would differ byte for byte while agreeing on every
 * number, and the equivalence that justifies the whole design would be uncheckable.
 */
export function normalizeStateCounts(counts: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const state of Object.keys(counts).toSorted()) {
		const count = counts[state] ?? 0;
		if (count > 0) out[state] = count;
	}
	return out;
}

/**
 * Has a recompute absorbed this claim — is its delta forbidden?
 *
 * Read through a function rather than by comparing the field, so the gate does not depend
 * on every writer of the collection having set it: a document written before the field
 * existed, or by any path that omits it, is NOT absorbed, and a bare `!== null` on an
 * absent field would have said the opposite and silently dropped that event's delta.
 */
export function isAbsorbed(claim: ReportingAppliedDoc): boolean {
	return (claim.absorbedAt ?? null) !== null;
}

/**
 * Read a stored document back as the value every reader works with, whichever shape it
 * was stored in (see {@link ReportingDailyStoredDoc}). Only the fields of the logical
 * value survive: the guards and the flat state fields are storage, not value, so a
 * document stored in either shape and holding the same counters reads identically.
 */
export function normalizeReportingDailyDoc(
	doc: ReportingDailyStoredDoc | ReportingDailyDoc,
): ReportingDailyDoc {
	const stored = doc as ReportingDailyStoredDoc;
	return {
		currency: stored.currency,
		date: stored.date,
		stateCounts: normalizeStateCounts(storedStateCounts(stored)),
		revenueOrders: stored.revenueOrders ?? 0,
		revenueCents: stored.revenueCents ?? 0,
		refundEntries: stored.refundEntries ?? 0,
		refundedCents: stored.refundedCents ?? 0,
		updatedAt: stored.updatedAt ?? "",
	};
}

/** The UTC day a timestamp falls in — `YYYY-MM-DD`. */
export function dayKeyOf(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) throw new RangeError(`reporting timestamp ${iso} is not a date`);
	return at.toISOString().slice(0, 10);
}

/** The canonical bucket start for a day — `YYYY-MM-DDT00:00:00.000Z`. */
export function dayStartOf(dayKey: string): string {
	return `${dayKey}T00:00:00.000Z`;
}

/** The last instant of a UTC day, inclusive — the `BETWEEN` upper bound for it. */
export function dayEndOf(dayKey: string): string {
	return `${dayKey}T23:59:59.999Z`;
}

/**
 * The bucket start a day belongs to, for one interval — the fold that replaces the
 * SQL's dialect-branched truncation.
 *
 * `week` truncates to the ISO-8601 Monday, matching Postgres `date_trunc('week')` and
 * SQLite's `'-6 days', 'weekday 1'`: both land on the Monday at or before the day, and
 * a Sunday therefore belongs to the week that STARTED six days earlier, not the one
 * about to begin.
 */
export function bucketStartOf(dayKey: string, interval: ReportInterval): string {
	if (interval === "month") return `${dayKey.slice(0, 7)}-01T00:00:00.000Z`;
	if (interval === "day") return dayStartOf(dayKey);
	const at = new Date(dayStartOf(dayKey));
	// `getUTCDay()` is 0 for Sunday, so the offset back to Monday is 6 for Sunday and
	// `day - 1` for every other day.
	const back = (at.getUTCDay() + 6) % 7;
	return new Date(at.getTime() - back * 86_400_000).toISOString();
}

/** Every UTC day from `fromDay` to `toDay`, inclusive. */
export function dayKeysBetween(fromDay: string, toDay: string): string[] {
	if (toDay < fromDay) return [];
	const days: string[] = [];
	for (let at = new Date(dayStartOf(fromDay)).getTime(); ; at += 86_400_000) {
		const day = new Date(at).toISOString().slice(0, 10);
		if (day > toDay) return days;
		days.push(day);
	}
}

/**
 * Add two aggregate parts, refusing to lose precision.
 *
 * Summing day documents in JS is exactly where a money figure would silently go wrong:
 * past `Number.MAX_SAFE_INTEGER` the addition rounds to a nearby representable
 * integer, and `cents()` would accept the result. So the guard is here rather than at
 * the boundary — it is the same refusal `parseAggregate` made of a Postgres bigint
 * string, kept because the arithmetic moved into the adapter (ADR-0019 §7.17).
 */
export function addAggregate(total: number, part: number): number {
	if (!Number.isSafeInteger(part)) {
		throw new RangeError(`reporting aggregate part ${String(part)} is not a safe integer`);
	}
	const sum = total + part;
	if (!Number.isSafeInteger(sum)) {
		throw new RangeError(
			`reporting aggregate ${String(total)} + ${String(part)} exceeds Number.MAX_SAFE_INTEGER — refusing to coerce`,
		);
	}
	return sum;
}

// -- top products and the month grain (issue #572) ----------------------------------

/**
 * One product's sales in a rollup document: the `(productId, title)` group the
 * `topProducts` report ranks, over the orders currently in a revenue-counting state.
 * `qty` is the units sold and `cents` the gross item revenue (`quantity × unitPrice`
 * off the frozen line snapshot), in the document's currency.
 */
export interface ReportingProductLine {
	readonly productId: string;
	readonly title: string;
	readonly qty: number;
	readonly cents: number;
}

/**
 * `productsDirty` on a day whose lines the rollup sweep could not build within the
 * most a tick could ever give it (its orders are too many to read in one): a reader
 * scans the day's orders, the backfill stops listing it, and a delta that moves its
 * revenue set marks it `1` again, which retries it.
 */
export const PRODUCTS_UNBUILDABLE = 2;

/**
 * A stored day document's product lines, or `null` when they cannot be trusted: never
 * built (a document from before #572), dirty or unbuildable since, or built at an
 * epoch a writer unaware of lines has since moved past (see `productsEpoch`).
 */
export function storedProductLines(
	doc: ReportingDailyStoredDoc,
): readonly ReportingProductLine[] | null {
	return doc.productsDirty === 0 &&
		Array.isArray(doc.products) &&
		doc.productsEpoch !== undefined &&
		doc.productsEpoch === doc.epoch
		? doc.products
		: null;
}

/**
 * Fold product lines into a running group map, keyed by `(productId, title)`: the
 * grouping the SQL's `GROUP BY oi.product_id, oi.title` made. The sums refuse to lose
 * precision exactly as every other reporting sum does.
 */
export function addProductLine(
	groups: Map<string, ReportingProductLine>,
	line: ReportingProductLine,
): void {
	const key = `${line.productId}\u0000${line.title}`;
	const held = groups.get(key);
	groups.set(
		key,
		held === undefined
			? { productId: line.productId, title: line.title, qty: line.qty, cents: line.cents }
			: {
					productId: held.productId,
					title: held.title,
					qty: addAggregate(held.qty, line.qty),
					cents: addAggregate(held.cents, line.cents),
				},
	);
}

/**
 * A group map as stored: sorted by product then title, so the same lines built twice
 * are the same JSON and a rebuild can tell "unchanged" from "moved".
 */
export function sortedProductLines(
	groups: ReadonlyMap<string, ReportingProductLine>,
): ReportingProductLine[] {
	return [...groups.values()].toSorted(compareProductLines);
}

/**
 * The stored order of product lines, and `topProducts`' tie-break: product, then
 * title, by plain code units — never `localeCompare`, whose ICU collation differs
 * between runtimes and would make the same lines serialize differently (and a
 * rebuild see a change that is not one).
 */
export function compareProductLines(
	a: Pick<ReportingProductLine, "productId" | "title">,
	b: Pick<ReportingProductLine, "productId" | "title">,
): number {
	return a.productId === b.productId
		? codeUnitAsc(a.title, b.title)
		: codeUnitAsc(a.productId, b.productId);
}

/**
 * A JSON value serialized with every object's keys sorted — the comparison form for a
 * cache read back from storage. On Postgres a guarded write round-trips the document
 * through `jsonb`, which does not keep key order (it orders keys by length, then
 * bytewise), so a plain `JSON.stringify` of an unchanged document read back differs
 * from the one built, and a rebuild would see a change that is not one. Arrays keep
 * their order: stored product lines are already sorted.
 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	const keys = Object.keys(value as Record<string, unknown>)
		.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
		.toSorted(codeUnitAsc);
	return `{${keys
		.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
		.join(",")}}`;
}

/** The `YYYY-MM` calendar month a day key falls in. */
export function monthKeyOf(dayKey: string): string {
	return dayKey.slice(0, 7);
}

/** The first and last UTC days of a `YYYY-MM` month. */
export function monthDays(month: string): { first: string; last: string } {
	const [year, mon] = month.split("-").map(Number) as [number, number];
	const last = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
	return { first: `${month}-01`, last };
}

/**
 * One currency's month, summed from its day documents — the same counters a day
 * holds, plus the month's product lines when every day of it had trustworthy ones.
 */
export interface ReportingMonthCurrency {
	stateCounts: Record<string, number>;
	revenueOrders: number;
	revenueCents: number;
	refundEntries: number;
	refundedCents: number;
	/** `null` when a day of the month had no clean product lines at build time, or the
	 *  month sold more `(productId, title)` groups than a month document keeps
	 *  (`maxMonthProductLines`): a reader then takes the month's days for top products. */
	products: ReportingProductLine[] | null;
}

/** The month-document format readers accept; a document of any other is rebuilt. */
export const REPORTING_MONTHLY_FORMAT = 1;

/**
 * `reporting_monthly/{YYYY-MM}` — a calendar month's day documents, summed, for every
 * currency at once (issue #572; ADR-0041).
 *
 * **It is a CACHE of the day documents, rebuilt from them, never moved by a delta.**
 * A long report reads one of these for each whole month it covers instead of the
 * month's thirty-odd day documents per currency, which is what keeps "Last 365 days"
 * inside the Workers Free query budget. The day documents stay the grain everything
 * else is defined on.
 *
 * **`gen`, `dirty` and `touchedAt` are how a reader knows it is current.** Every writer
 * of a day document "touches" the month BEFORE its day write — bumps `gen`, sets
 * `dirty`, stamps `touchedAt` — and marks the write done AFTER it: a recompute or a
 * product build (the sweep's writes) with a second touch, a live event with the
 * `appliedAt` stamp its claim already gets (which spares the checkout path a call), or
 * with a second touch when that stamp is refused because a recompute stamped the claim
 * first. A rebuild reads `gen`, refuses while the month was touched within the settle
 * window or while any of its claims is unstamped, reads the month's days, and commits
 * guarded on that `gen`, clearing `dirty`:
 *
 * - a day write that landed before the rebuild read the days is in what it read;
 * - a writer whose BEFORE touch comes after the rebuild read `gen` refuses its commit;
 * - one whose touch came before, and inside the settle window, holds the rebuild off
 *   (`touchedAt`); a live event's unstamped claim does the same however old it is;
 * - one whose touch is OLDER than the settle window and still has not finished its day
 *   write is a writer that died, and its write never lands: the window outlasts the
 *   longest invocation, a Cron Trigger's 15 minutes.
 *
 * What this does NOT survive, and what the sweep's round-robin verifier (which rebuilds
 * clean closed months and re-checks clean day lines) is the backstop for: a writer that
 * stalls past the settle window and THEN writes, a live event whose claim a recompute
 * stamped and which dies between its day write and its second touch, and writers from a
 * build older than #572 (a rollback or mixed-version window), which never touch a month
 * at all. See ADR-0041 and DEPLOYMENT.md.
 *
 * So a CLEAN document (`dirty === 0`, current `format`) is the sum of the month's day
 * documents up to those residues, and a dirty one is never read: the reader takes that
 * month's days instead. A touch is a single unguarded numeric delta that never
 * contends: one more write per order event.
 */
export interface ReportingMonthlyDoc {
	/** INDEXED — `YYYY-MM`. */
	month: string;
	/** Bumped before and after every write to one of the month's day documents. */
	gen: number;
	/** INDEXED — `1` until a rebuild over the current `gen` commits; then `0`. */
	dirty: number;
	/** The built sums by currency; `null` until the first rebuild. */
	currencies: Record<string, ReportingMonthCurrency> | null;
	/** The last touch: a rebuild waits for the settle window after it. Absent on a
	 *  document no writer has touched since its first build. */
	touchedAt?: string;
	/** {@link REPORTING_MONTHLY_FORMAT} the sums were built in; absent until built. */
	format?: number;
	/** When the sums were last rebuilt. Diagnostic. */
	builtAt: string | null;
	updatedAt: string;
}

/** Can a reader use this month document in place of its days? */
export function isCleanMonthlyDoc(
	doc: ReportingMonthlyDoc,
): doc is ReportingMonthlyDoc & { currencies: Record<string, ReportingMonthCurrency> } {
	return (
		doc.dirty === 0 &&
		doc.format === REPORTING_MONTHLY_FORMAT &&
		typeof doc.currencies === "object" &&
		doc.currencies !== null
	);
}
