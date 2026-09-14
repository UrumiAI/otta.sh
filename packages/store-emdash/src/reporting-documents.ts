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
 * the seven day documents from its ISO Monday and a month is its own days, so nothing
 * is keyed by a week or a month and no second aggregate can disagree with the first.
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
import { REVENUE_COUNTING_STATES, type ReportInterval } from "@otta-sh/domain";

/** Collection name: the precomputed day counters. */
export const REPORTING_DAILY_COLLECTION = "reporting_daily";
/** Collection name: one claim per applied rollup event. */
export const REPORTING_APPLIED_COLLECTION = "reporting_applied";

/** One collection as the plugin descriptor declares it. */
export interface ReportingCollectionIndexDeclaration {
	readonly indexes?: readonly string[];
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
 * `reporting_applied` declares `orderId`: a recompute re-establishes the claims for
 * the orders it folded in, and an operator asking "which rollup events have been
 * applied to this order" is the diagnostic that makes an under-count legible.
 */
export const REPORTING_COLLECTIONS: Readonly<Record<string, ReportingCollectionIndexDeclaration>> =
	{
		[REPORTING_DAILY_COLLECTION]: { indexes: ["currency", "date"] },
		[REPORTING_APPLIED_COLLECTION]: { indexes: ["orderId"] },
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
 * So the recompute stamps it before it commits its counters, and the delta path re-reads
 * the claim immediately before EVERY bucket write and drops the delta when it is stamped
 * (ADR-0019's cross-cutting rule (a): the token is re-asserted before every write it
 * guards, on every attempt, because a writer parked past the moment its right was revoked
 * must not wake up and commit anyway).
 */
export interface ReportingAppliedDoc {
	/** INDEXED — which order this event belongs to. */
	orderId: string;
	kind: ReportingEventKind;
	/** The `YYYY-MM-DD` bucket the event was applied to — the order's creation day. */
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

/** Read a stored document back with its containers present. */
export function normalizeReportingDailyDoc(doc: ReportingDailyDoc): ReportingDailyDoc {
	return {
		...doc,
		stateCounts: normalizeStateCounts(doc.stateCounts ?? {}),
		revenueOrders: doc.revenueOrders ?? 0,
		revenueCents: doc.revenueCents ?? 0,
		refundEntries: doc.refundEntries ?? 0,
		refundedCents: doc.refundedCents ?? 0,
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
