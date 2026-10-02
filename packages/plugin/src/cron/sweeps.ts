/**
 * The scheduled sweep: nine legs, one tick (INC-C4).
 *
 * WHY THIS FILE EXISTS AT ALL. ADR-0019 §7 says it plainly — the aggregates are
 * one document each, a coupling that spans two of them is made *idempotently
 * completable by any replayer* rather than transactional, and **a missing sweeper
 * is a correctness bug**, not a missing optimization. Four of these legs are the
 * service worker's `scheduled()` handler moved in unchanged; the other five are
 * the completers ADR-0019's two-tier write strategy always owed and that nothing
 * had yet run on a schedule.
 *
 * EVERY LEG IN ITS OWN TRY/CATCH, WITH ITS OWN LABEL — mirroring the service's
 * `scheduled()` handler, and for its reason: a sweep that throws must not starve
 * the eight beside it. A tick therefore always returns a summary, and a failed
 * leg is a `{ ok: false, error }` row in it rather than a rejected hook.
 *
 * AND EVERY LEG LOGS, which is the other half of that mirror and was missing from
 * the first cut of this file. The summary is the hook's RETURN VALUE and the host's
 * cron executor does not persist it, so a leg that fails forever would otherwise be
 * indistinguishable from a leg that has nothing to do — exactly the failure mode an
 * unattended path must not have. Each leg emits one `[otta] cron sweep …` line on
 * success and one `console.error` with its own label on failure, matching the
 * format the standalone commerce service's `scheduled()` handler used before it
 * was folded into the plugin. An anomaly is louder
 * still: it is logged AND written to the order through `flagReconciliation`.
 *
 * EVERY LEG IS IDEMPOTENT, which is what makes running them every minute safe
 * and is the property the suite pins with two ticks and one effect. None of
 * them is a "do the work again" path: each finds outstanding work from the
 * documents themselves and completes it exactly once, because the completion is
 * always a guarded write the second caller loses.
 *
 * DISCOVERY IS INDEX-ONLY. A declared index is a READ CONTRACT (D3): filtering on
 * a field the collection never declared *throws* `StorageQueryError` rather than
 * running slowly. So every scan below filters on a declared field — `holdsPendingAt`
 * for the hold intents, `createdAt` for the index heal and the product scan,
 * `createdAt`+`holdsUse` for the coupon orphans — and anything else is decided
 * from the document once it is in hand.
 *
 * NO SCAN MAY STARVE, and this is the property the first cut got wrong. A sweep
 * that pages a collection `createdAt ASC` from a FIXED lower bound, capped at a
 * page budget, reads the same oldest rows on every tick forever: past that budget
 * the tail is unreachable and the gap never heals, silently. So every unbounded
 * collection here is walked behind an ADVANCING CURSOR kept in `ctx.kv` (the
 * plugin's own ungated store):
 *
 *  - `order_sku_index` and the coupon orphans walk FORWARD: the cursor is the last
 *    `createdAt` read, less a small overlap so a row written slightly out of order
 *    is still seen, and a tick that runs out of budget resumes where it stopped.
 *  - the product catalog ROTATES: there is no "swept" marker on a product to narrow
 *    by, so the cursor advances to the end and then wraps to the beginning. Every
 *    product is reached within one rotation regardless of catalog size.
 *  - the hold intents need no cursor: `holdsPendingAt` is null once the order owes
 *    nothing, so that predicate narrows by itself as the work completes.
 *
 * A LOST CURSOR IS ALWAYS SAFE. It costs a re-read, never correctness: every leg's
 * work is a guarded write, so re-reading a row it already handled does nothing.
 * That is why a `ctx.kv` failure is logged and shrugged off rather than failing the
 * leg — the sweep is strictly better off running without a cursor than not running.
 *
 * THE TWO HAZARDS, both named because both are easy to re-introduce:
 *
 *  1. `commitMany` SKIPS a reservation id already terminal in `reservation_index`,
 *     so a partial commit can never be healed by replaying the batch. The
 *     hold-intent leg therefore drives the ORDER STORE's per-id completers
 *     (`completeHoldAdoption`/`completeHoldCommit`/`completeHoldRelease`), which
 *     walk the order's own recorded intent one reservation at a time. Nothing here
 *     may reach for a batch method.
 *
 *  2. Those completers read a NON-VERSIONED `get`. Between that read and their
 *     per-id writes the order can legitimately move on — an order that expired
 *     mid-adoption has had its holds released by the expiry path, and the adoption
 *     completer will then report those ids as `lost`. That is normal, not an
 *     anomaly. So a non-empty `lost` set is RE-READ against the order's current
 *     `state` before it is counted: only a `lost` id on an order still sitting in
 *     the state that owns the intent is a real anomaly — and one that survives that
 *     filter is written to the order with `flagReconciliation`, because ADR-0019
 *     §7.13 says an anomaly must always be RECORDABLE and a return value nothing
 *     reads is not a record.
 *
 * THE TICK IS BUDGETED, AND THAT IS THE OTHER HALF OF "a leg must not starve
 * the others". A thrown leg was always contained; a SLOW one was not. The host
 * runs this whole tick inside one hook and abandons it after the hook's timeout
 * (`SWEEP_HOOK_TIMEOUT_MS`, declared on the hook in `plugin.ts`), and end-to-end
 * QA caught exactly that: `expire-holds 18`, `expire-orders 14`, then `Hook timeout
 * after 5000ms` — every leg after them, the outbox included, never ran on any tick.
 * So the tick carries a budget (`tick-budget.ts`) in two dimensions — wall time
 * (`SWEEP_TICK_BUDGET_MS`, started at hook ENTRY) and storage/kv/egress calls
 * (`SWEEP_TICK_QUERY_BUDGET`, sized for Workers Free's 50 D1 queries per
 * invocation) — and, precisely:
 *
 *  - every leg asks it before starting, and a leg it does not admit is reported
 *    `deferred` — `ok`, not failed — and runs on the next tick;
 *  - the loops ask it before each UNIT: each hold and order flip, each outbox
 *    claim, each scanned page and row, each reporting day. A unit is admitted only
 *    if the slowest unit seen so far in that loop still fits, with the trailing
 *    reserve kept back. A leg stops between two guarded units, never inside one,
 *    and an advancing cursor moves only past rows actually handled;
 *  - what is NOT checked inside: the expiry legs' candidate LIST (bounded instead,
 *    by asking the store for `batch + 1`), and the single calls of
 *    `prune-challenges` and the settings read. Each is one bounded read or write;
 *  - an email SEND is the one unit whose length someone else decides, so the
 *    whole send is raced against a timer at `SWEEP_EMAIL_SEND_TIMEOUT_MS` or at
 *    what is left of the leg, whichever is sooner, and the time is checked once
 *    more just before it. A send cut off either way is handed back WITHOUT
 *    counting an attempt (`releaseEmailClaim`): a timeout is not a provider
 *    failure, and a row must never be parked `failed` for our own deadline;
 *  - each of the three critical legs may use only a SHARE of the tick (never less
 *    than one unit of its own work), so a hung provider or a hold backlog cannot
 *    take it all;
 *  - the expiry legs take bounded bites (`expiryBatchLimit`), so a backlog drains
 *    over several ticks instead of eating one.
 *
 * The three CRITICAL legs — the outbox (a customer is waiting on it) and the two
 * expiry legs (stock back on sale) — run before everything else, and take turns
 * LEADING by minute: on the Free preset one unit of real work is most of the
 * budget, so under a backlog the leader is often the only one that can run, and
 * a fixed order would let one leg's backlog starve the other two. Then the
 * completers, then the scans.
 *
 * AND THE SCANS KEEP THEIR OLD CADENCE. The task is due every minute now (the
 * site's Worker cron's own resolution), which is what holds and mail need. The
 * four scan legs (`MAINTENANCE_LEGS`) are a different cost: each reads up to
 * `maxPages` pages of a collection, and `reporting-heal` re-reconciles the closed
 * day, on every run. Fifteen times the reads would buy nothing — they heal crash
 * residue, which is rare and not customer-visible within minutes — so each runs
 * only when `MAINTENANCE_LEG_INTERVAL_MS` has passed since it last COMPLETED (a
 * stamp in the cursor store). A scan the budget deferred or cut short is not
 * stamped, so it is due again on the very next tick. The other legs are not
 * free when idle — each issues its discovery read (one query, a little more for
 * the outbox claim and the settings read) — but that is a handful of queries a
 * minute, not a page budget.
 *
 * THE HOLD TTL IS THE ADMIN'S SETTING. One settings read per tick feeds
 * `expireHolds`' `ttlMs` — the same `holdTtlMinutes` the in-process client reads
 * on every cart call that stamps or measures a deadline (issue #127), so a hold's
 * deadline, its lazy expiry and this sweep all agree on one window.
 */
import {
	assertSweepLimit,
	DEFAULT_COUPON_GRACE_MS,
	dispatchOrderEmails,
	EmailSendTimeoutError,
	expireHoldsBatch,
	expireOrdersBatch,
	isEmailSendTimeoutError,
	orderId as toOrderId,
	type EmailSender,
	type OrderState,
} from "@otta-sh/domain";
import {
	collectionOf,
	COUPON_REDEMPTIONS_COLLECTION,
	ORDER_SKU_INDEX_COLLECTION,
	orderSkuIndexId,
	orderSkuKeys,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	type CouponRedemptionDoc,
	type OrderDoc,
	type OrderSkuIndexDoc,
	type ProductCommerceDoc,
	type StorageAccess as AdapterStorageAccess,
} from "@otta-sh/store-emdash";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
} from "../commerce/in-process-commerce-stores.js";
import { makeEmailSender } from "../email/ctx-http-email-sender.js";
import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import type { PluginContext } from "../types.js";
import { DEFAULT_BACKGROUND_WORK, readBackgroundWork } from "./background-work-setting.js";
import { type LegBudget, type LegShare, TickBudget, WHOLE_TICK } from "./tick-budget.js";

/** The nine legs in PRIORITY order, since a tick that runs out of budget defers
 *  whatever is left: the three critical legs (the outbox, then the two expiry
 *  legs — which of the three LEADS rotates by minute, see the head comment), then
 *  the self-narrowing completers, then the four scans. `coupon-orphans` must stay
 *  after `expire-orders`: its `expired` arm is that leg's retry. A summary always
 *  lists the legs in THIS order, whichever critical leg led. */
export const SWEEP_LEGS = [
	"order-emails",
	"expire-holds",
	"expire-orders",
	"hold-intents",
	"prune-challenges",
	"sku-transfers",
	"order-sku-index",
	"reporting-heal",
	"coupon-orphans",
] as const;

export type SweepLeg = (typeof SWEEP_LEGS)[number];

/**
 * The legs that run on the slow cadence rather than every tick: the four that walk
 * a collection (or a whole closed day) on every run. The other five find their
 * work from a predicate that narrows as the work completes, so an idle run is one
 * empty query — cheap enough for every minute.
 */
export const MAINTENANCE_LEGS: readonly SweepLeg[] = [
	"sku-transfers",
	"order-sku-index",
	"reporting-heal",
	"coupon-orphans",
];

/** How often a maintenance leg runs: the fifteen minutes the WHOLE sweep used to
 *  wait, kept for the legs whose read cost it was actually bounding. */
export const MAINTENANCE_LEG_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long one tick may spend, measured on the tick clock from HOOK ENTRY (so the
 * task bookkeeping before the legs is inside it).
 *
 * 9500 ms, 5.5 s under the hook's declared 15 s timeout. The gap is sized, not
 * guessed: it must hold one whole email send (`SWEEP_EMAIL_SEND_TIMEOUT_MS`) plus
 * the trailing reserve, because a send is the one unit whose length an outside
 * service decides — a test pins that inequality. Within the budget, every check
 * already keeps the slowest unit seen plus the reserve back, so the gap is
 * insurance against a single storage call that runs far longer than any before
 * it, not the main mechanism.
 *
 * WALL time, not CPU: a tick mostly waits on D1 and the email provider, so a
 * longer budget does not touch Workers Free's per-invocation CPU limit. On
 * Workers Free the QUERY budget, not this, is what ends a busy tick.
 */
export const SWEEP_TICK_BUDGET_MS = 9_500;

/**
 * Time kept back for the writes after the legs (the cadence state, a cursor) —
 * a check never admits a unit that would eat into it.
 */
export const SWEEP_TICK_RESERVE_MS = 250;

/**
 * The DEFAULT for the most storage, kv and egress calls one tick makes — each is
 * one D1 query or one subrequest on Cloudflare. The operator changes it with the
 * "Background work per minute" setting (`background-work-setting.ts`); this is
 * its Workers Free preset, and what a tick uses until it has read the setting.
 *
 * SIZED FOR WORKERS FREE, the plan DEPLOYMENT.md §2 builds for: 50 D1 queries
 * and 50 subrequests per Worker invocation (1000 and 10,000 on Workers Paid). The
 * scheduled event that runs this tick also runs the host's cron executor (its
 * claim and its bookkeeping update), its scheduled-publishing pass, and any other
 * plugin's due task, so the sweep keeps 20 of the 50 back for them.
 */
export const SWEEP_TICK_QUERY_BUDGET = DEFAULT_BACKGROUND_WORK;

/** Calls kept back for the writes after the legs (the cadence state, a cursor). */
const RESERVE_QUERIES = 2;

/**
 * The longest one email send may take from the sweep: the whole send is raced
 * against this, or what is left of the leg, whichever is sooner.
 *
 * Five seconds, so a slow-but-WORKING provider delivers. REQUIREMENT: the cap
 * must sit above a healthy provider's slowest normal round trip (a couple of
 * seconds), because a cap below it times out every send, and a row that only ever
 * times out is never sent. NOT the sender's general 30 s default
 * (`DEFAULT_EMAIL_TIMEOUT_MS`): a send outliving the hook would be abandoned
 * mid-flight. A send given LESS than this (the tick was short of time) and timing
 * out is the sweep's doing, not the provider's: it is handed back due at once,
 * with no backoff and no timeout recorded.
 *
 * A send that times out is NOT a failed attempt (`EmailSendTimeoutError`): the
 * row is handed back uncounted, with a forward backoff (one minute, doubling to
 * fifteen) so it falls behind the other due rows; after ten such timeouts the
 * sweep reports it (`console.error`) and further timeouts count as attempts, so a
 * provider that never answers in time does eventually park the row, with the
 * reason "provider kept timing out".
 */
export const SWEEP_EMAIL_SEND_TIMEOUT_MS = 5_000;

/** The outbox stops claiming, and hands a claimed row back untried, when less
 *  than this is left for the send: a send given less would mostly time out — not
 *  costing an attempt, but costing the row a backoff for nothing. */
const MIN_SEND_MS = 500;

/**
 * The legs that can meet a backlog may use only a share of the tick (a cap, not a
 * reservation: an idle leg's share goes to the legs after it). The outbox's time
 * share must hold one full send plus the reserve, which is why it is the larger.
 */
export const LEG_SHARES: Partial<Record<SweepLeg, LegShare>> = {
	// The outbox's QUERY share stays at 0.3 — about one email a tick on the Free
	// preset — rather than 0.5: at 0.5 a standing email backlog would leave the
	// expiry leg after it too few queries to start, and expired holds keep stock
	// off sale, which costs more than a queued email waiting a minute longer.
	"order-emails": { time: 0.6, queries: 0.3 },
	// A share is never smaller than one unit of the leg's own work (see `run`),
	// so on the Free preset these are effectively "one unit"; on Paid they keep a
	// backlog on one leg from taking the whole tick.
	"expire-holds": { time: 0.5, queries: 0.5 },
	"expire-orders": { time: 0.5, queries: 0.5 },
};

/** The legs a customer waits on: the outbox and the two expiry legs. Each has a
 *  share, and the setting's floor is sized so each can always start. */
export const CRITICAL_LEGS: readonly SweepLeg[] = ["order-emails", "expire-holds", "expire-orders"];

/**
 * What a leg's calls cost before its first checked unit (`entry`) and per unit
 * (`unit`), in storage/kv/egress calls. MEASURED — `cron-leg-costs.test.ts` runs
 * one real unit of each leg through the counting context against SQLite and
 * fails if any exceeds its figure here (one order expiry is 22 calls: the guarded
 * flip, the re-read, the adopted hold's release and the coupon release, each a
 * read plus a compare-and-set or two); they matter only until a loop has seen a real unit, after which
 * its gate uses the slowest observed. Without them a leg's first unit — and its
 * unchecked entry reads — would always be admitted, and on Workers Free one
 * `hold-intents` row alone is a third of the budget. `expire-holds` adds two calls
 * per listed candidate to its entry at run time (the cart page plus each cart's
 * reads).
 */
export const LEG_QUERY_COSTS: Record<SweepLeg, { readonly entry: number; readonly unit: number }> =
	{
		"order-emails": { entry: 0, unit: 8 },
		"expire-holds": { entry: 2, unit: 14 },
		"expire-orders": { entry: 1, unit: 22 },
		"hold-intents": { entry: 1, unit: 14 },
		"prune-challenges": { entry: 2, unit: 0 },
		"sku-transfers": { entry: 2, unit: 12 },
		"order-sku-index": { entry: 2, unit: 3 },
		"reporting-heal": { entry: 1, unit: 3 },
		"coupon-orphans": { entry: 2, unit: 7 },
	};

/** `expire-holds`' entry reads for a given bite: its fixed reads, plus two per
 *  listed candidate (it lists `batch + 1`). */
function expireHoldsEntry(expiryBatch: number): number {
	const listed = Number.isInteger(expiryBatch) && expiryBatch > 0 ? expiryBatch + 1 : 0;
	return LEG_QUERY_COSTS["expire-holds"].entry + 2 * listed;
}

/**
 * The per-tick bites a query budget can afford, from the MEASURED costs: as many
 * units as the leg's share holds, each with its list read (about two calls per
 * candidate) — between 2 and 50 for the expiry legs, 1 and 25 for the outbox.
 * Sized from the budget rather than left to the per-unit checks because the
 * expiry LIST (`batch + 1` candidates) is read before those checks run.
 *
 * Free (30): 2 holds/orders, 1 email. Paid (600): 18 holds/orders, 22 emails —
 * the time budget, not the count, usually ends a Paid tick first.
 */
export function batchesFor(queryBudget: number): { expiry: number; email: number } {
	const holds = LEG_QUERY_COSTS["expire-holds"].unit + 2;
	const emails = LEG_QUERY_COSTS["order-emails"].unit;
	const holdShare = LEG_SHARES["expire-holds"]?.queries ?? 1;
	const emailShare = LEG_SHARES["order-emails"]?.queries ?? 1;
	return {
		expiry: clampInt((queryBudget * holdShare) / holds, 2, 50),
		email: clampInt((queryBudget * emailShare) / emails, 1, 25),
	};
}

function clampInt(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Calls every tick makes before any leg: the setting read and the cadence-state
 *  read. */
const TICK_OVERHEAD_QUERIES = 2;

/**
 * The smallest query budget at which every critical leg can START when it leads
 * the tick (the rotation gives each the lead one minute in three): the tick's
 * fixed reads, the leg's entry reads, one unit, and the reserve — from the cost
 * table, at the bite the smallest budget gets.
 *
 * Below it a critical leg is refused on every tick, silently and forever — at 20,
 * an order expiry (23 calls with its list) can never start. That is why the
 * "Background work per minute" setting's floor (`MIN_BACKGROUND_WORK`) is pinned
 * against this by a test, and refused below it on save and on read.
 */
export function minimumQueryBudget(): number {
	const floorBatch = batchesFor(1).expiry; // the smallest bite any budget gets
	let needed = 0;
	for (const leg of CRITICAL_LEGS) {
		const costs = LEG_QUERY_COSTS[leg];
		const entry = leg === "expire-holds" ? expireHoldsEntry(floorBatch) : costs.entry;
		needed = Math.max(needed, entry + Math.max(1, costs.unit));
	}
	return TICK_OVERHEAD_QUERIES + needed + RESERVE_QUERIES;
}

/** Consecutive deferrals of one leg after which every further multiple is a
 *  warning: one deferral is normal, a leg that never runs is not. */
const DEFERRAL_WARN_EVERY = 5;

/** What one leg did. `count` is the leg's own unit of work — orders expired,
 *  pointers written, carries finished — and is `0` for a leg that found nothing. */
export interface SweepLegOutcome {
	readonly leg: SweepLeg;
	readonly ok: boolean;
	readonly count: number;
	/** Present and true for a leg this deployment cannot run yet (see
	 *  `order-emails`), which is NOT a failure and must not read as one. */
	readonly skipped?: boolean;
	/** Present and true for a leg this tick did not START — its time budget was
	 *  spent, or (for `coupon-orphans`) the leg it depends on did not finish. Not a
	 *  failure: the next tick runs it. */
	readonly deferred?: boolean;
	/** Present and true for a maintenance leg that ran recently enough that this
	 *  tick had no reason to (see `MAINTENANCE_LEG_INTERVAL_MS`). */
	readonly notDue?: boolean;
	/** Present and true for a leg that STOPPED EARLY — out of budget, or at its
	 *  per-tick batch — with work left over for the next tick. */
	readonly incomplete?: boolean;
	/** The failure message, when `ok` is false. */
	readonly error?: string;
	/** Loud, human-readable markers a leg wants surfaced (a genuinely lost hold).
	 *  Also logged, and — for a hold anomaly — written to the order itself. */
	readonly anomalies?: readonly string[];
}

/** One tick's report. Always returned — a leg that threw is a row in here. */
export interface CommerceSweepSummary {
	readonly task: string;
	readonly scheduledAt: string;
	readonly legs: readonly SweepLegOutcome[];
	/** What this tick was allowed and what it used — the budget follows the
	 *  "Background work per minute" setting, so an operator (and a suite) can see
	 *  which figure a tick actually ran under. */
	readonly budget: {
		readonly timeMs: number;
		readonly queries: number;
		readonly expiryBatch: number;
		readonly emailBatch: number;
		readonly queriesUsed: number;
	};
}

export interface CommerceSweepOptions {
	/**
	 * The outbox's sender — an OVERRIDE since INC-C5, not the only source. Left
	 * unset, the tick builds the in-process `CtxHttpEmailSender` from the context
	 * and this bundle's email API URL; a suite sets it to pin the outbox against a
	 * fake without any egress. Neither one existing (no injection, no configured
	 * URL) makes the `order-emails` leg report `skipped` rather than pretend to
	 * drain an outbox — a silent no-op here would look exactly like an empty one.
	 */
	readonly emailSender?: EmailSender;
	/** Deterministic time, for a suite that pins deadlines. Default: real time. */
	readonly now?: Date;
	/** Rows per scan page. The host clamps `limit` to 100, so this is a floor. */
	readonly pageSize?: number;
	/** Safety cap on scan pages per leg per tick — a sweep must never become an
	 *  unbounded table walk on a large store. Exhausting it is not a truncation
	 *  here: the leg's cursor resumes at the next tick. */
	readonly maxPages?: number;
	/** How far back the `order_sku_index` heal's cursor may be pulled when it has
	 *  none (first run, or a lost cursor). An older gap is a backfill, not a
	 *  sweep. Default: 48 hours. */
	readonly skuIndexLookbackMs?: number;
	/** How long a claimed redemption may sit before the coupon sweeper judges it
	 *  orphaned. Default: the DOMAIN's own `DEFAULT_COUPON_GRACE_MS`, so the sweep
	 *  and `reconcileCouponRedemptions` cannot disagree about what "stale" means. */
	readonly couponGraceMs?: number;
	/** How many CLOSED days back the reporting heal may reach when it has no
	 *  cursor, and how many days one tick may reconcile. Defaults: 7 and 7. */
	readonly reportingBackfillDays?: number;
	readonly reportingMaxDaysPerTick?: number;
	/**
	 * Cursor persistence. Defaults to `ctx.kv`; a suite injects its own to pin a
	 * leg's window instead of inheriting whatever the previous case left behind.
	 */
	readonly cursors?: SweepCursorStore;
	/** The tick's time budget in ms. Default: `SWEEP_TICK_BUDGET_MS`. */
	readonly budgetMs?: number;
	/** The tick's storage/kv/egress call budget. Default: the "Background work per
	 *  minute" setting (`background-work-setting.ts`), read once per tick. */
	readonly queryBudget?: number;
	/**
	 * The millisecond clock the budget is measured on. Default: `Date.now` — the
	 * wall clock, which is what the host's hook timeout is measured on. A suite
	 * injects one it can move, to stage a slow tick without sleeping. Deliberately
	 * separate from `now`, which pins DEADLINES and must not freeze the budget.
	 */
	readonly tickClock?: () => number;
	/** When the hook began, on `tickClock` — the cron handler passes its entry
	 *  instant so its own bookkeeping counts. Default: when this call began. */
	readonly startedAtMs?: number;
	/** Most holds, and most orders, each expiry leg attempts per tick. Default:
	 *  scaled from the query budget (`batchesFor`) — 2 on the Free preset, 50 on Paid. */
	readonly expiryBatchLimit?: number;
	/** Most outbox rows the email leg claims per tick. Default: scaled from the
	 *  query budget — 10 on the Free preset, 25 on Paid. */
	readonly emailBatchLimit?: number;
	/**
	 * Builds the outbox's sender, given the per-send timeout to apply at each send.
	 * Default: the in-process `CtxHttpEmailSender` over `ctx.http`, when this bundle
	 * carries an email API URL. A suite injects one to model a slow provider that
	 * honours the abort. Ignored when `emailSender` is set.
	 */
	readonly emailSenderFactory?: (
		requestTimeoutMs: () => number,
	) => Promise<EmailSender | undefined>;
}

/** Where an advancing scan keeps its place between ticks. */
export interface SweepCursorStore {
	read(name: string): Promise<string | null>;
	write(name: string, value: string): Promise<void>;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_SKU_INDEX_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const DEFAULT_REPORTING_BACKFILL_DAYS = 7;
const DEFAULT_REPORTING_MAX_DAYS_PER_TICK = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far BACK an advancing cursor is rewound from the newest row it read.
 *
 * Not a nicety: `createdAt` is stamped by the writer, so two rows can land in an
 * order the index does not agree with (a slow writer, a clock a few seconds off).
 * A cursor parked exactly on the newest row read would step over such a row
 * forever. Five minutes of deliberate overlap costs a handful of re-reads — each
 * of which is a guarded no-op — and closes that hole.
 */
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;

/** `ctx.kv` keys. Namespaced, because kv is shared with settings and display prefs. */
const CURSOR_KEY_PREFIX = "cron:sweep:cursor:";
const SKU_TRANSFER_CURSOR = "sku-transfers";
const SKU_INDEX_CURSOR = "order-sku-index";
const COUPON_CURSOR = "coupon-orphans";
const REPORTING_CURSOR = "reporting-heal";
/** One JSON document — each scan's last completion, each leg's consecutive
 *  deferrals — so the cadence costs one read per tick, and a write only when
 *  something changed. */
const STATE_CURSOR = "state";

/** The `ctx.kv` key the cadence state lives under. Exported for the sandbox suite,
 *  which clears it to drive a scan leg through the real hook. */
export const SWEEP_STATE_KV_KEY = `${CURSOR_KEY_PREFIX}${STATE_CURSOR}`;

/** The states in which an order still OWES the matching hold intent. A `lost`
 *  reservation reported against an order that has left these is the non-versioned
 *  read losing a race, not a lost hold (hazard 2). */
const INTENT_OWNER_STATE: Record<"adopt" | "commit" | "release", readonly OrderState[]> = {
	adopt: ["pending"],
	commit: ["paid", "processing", "shipped", "delivered", "completed", "refunded"],
	release: ["expired", "cancelled"],
};

/**
 * Run every leg of the commerce sweep once.
 *
 * Never rejects for a leg failure: the summary carries each leg's own outcome, so
 * a broken sweep is visible without taking the other eight down with it. It DOES
 * reject when the context carries no document store, because that is a wiring
 * fault rather than a sweep result.
 */
export async function runCommerceSweeps(
	baseCtx: PluginContext,
	task: string,
	options: CommerceSweepOptions = {},
): Promise<CommerceSweepSummary> {
	const tickClock = options.tickClock ?? (() => Date.now());
	const budget = new TickBudget(tickClock, options.startedAtMs ?? tickClock(), {
		ms: options.budgetMs ?? SWEEP_TICK_BUDGET_MS,
		// Provisional until the setting is read, below.
		queries: options.queryBudget ?? SWEEP_TICK_QUERY_BUDGET,
		reserveMs: SWEEP_TICK_RESERVE_MS,
		reserveQueries: RESERVE_QUERIES,
	});
	// Every storage, kv and egress call below goes through this context, and so is
	// counted against the query budget — the stores, the cursors, the sender alike.
	const ctx = countingContext(baseCtx, budget);
	const stores = createInProcessCommerceStores(ctx);
	// `createInProcessCommerceStores` already threw if this were undefined.
	const storage = ctx.storage as AdapterStorageAccess;
	const cursors = options.cursors ?? kvCursors(ctx);
	const now = options.now ?? stores.clock.now();
	const nowIso = now.toISOString();
	// The query budget is the operator's "Background work per minute" setting,
	// read ONCE per tick through the counted context — so the read is charged
	// against the provisional (Free) limit the budget was built with — unless a
	// caller pinned it. The bites scale from it; the time budget does not move.
	const queryBudget = options.queryBudget ?? (await readBackgroundWork(ctx));
	budget.setQueryLimit(queryBudget);
	const batches = batchesFor(queryBudget);
	const expiryLimit = options.expiryBatchLimit ?? batches.expiry;
	const emailLimit = options.emailBatchLimit ?? batches.email;
	const state = await readState(cursors);
	let stateChanged = false;
	const legs: SweepLegOutcome[] = [];
	const deferredByBudget: SweepLeg[] = [];

	const noteDeferral = (leg: SweepLeg): void => {
		const streak = (state.deferrals[leg] ?? 0) + 1;
		state.deferrals[leg] = streak;
		stateChanged = true;
		if (streak % DEFERRAL_WARN_EVERY === 0) {
			console.warn(
				`[otta] cron sweep ${leg} has been deferred ${String(streak)} ticks in a row` +
					" — the tick's budget is not reaching it; see DEPLOYMENT.md §5 (Cron)",
			);
		}
	};

	const run = async (
		leg: SweepLeg,
		body: (budget: LegBudget) => Promise<Omit<SweepLegOutcome, "leg" | "ok">>,
	): Promise<void> => {
		const maintenance = MAINTENANCE_LEGS.includes(leg);
		if (maintenance && !isDue(state.lastRun[leg], now)) {
			// Quiet on purpose: four "not due" lines a minute would bury the lines
			// that matter. The summary still lists the leg.
			legs.push({ leg, ok: true, count: 0, notDue: true });
			return;
		}
		const costs = LEG_QUERY_COSTS[leg];
		// A malformed limit adds nothing here, so the leg STARTS and its use-case
		// refuses the limit loudly — rather than a NaN quietly deferring it forever.
		const entry = leg === "expire-holds" ? expireHoldsEntry(expiryLimit) : costs.entry;
		// A share never shrinks a leg below ONE unit of its own work: on the Free
		// preset one order expiry is most of the budget, and a share smaller than
		// that would refuse the leg on every tick, silently, forever.
		const legBudget = budget.leg(LEG_SHARES[leg] ?? WHOLE_TICK, entry + costs.unit);
		if (!legBudget.canStart(entry, costs.unit)) {
			legs.push({ leg, ok: true, count: 0, deferred: true });
			deferredByBudget.push(leg);
			noteDeferral(leg);
			return;
		}
		try {
			const outcome = { leg, ok: true, ...(await body(legBudget)) };
			legs.push(outcome);
			if (outcome.deferred === true) {
				// Deferred by its own body (a dependency), which logged why.
				noteDeferral(leg);
				return;
			}
			if ((state.deferrals[leg] ?? 0) > 0) {
				delete state.deferrals[leg];
				stateChanged = true;
			}
			logOutcome(outcome);
			// A scan cut short is NOT stamped: it resumes on the very next tick, from
			// its cursor, rather than waiting out another interval.
			if (maintenance && outcome.incomplete !== true) {
				state.lastRun[leg] = nowIso;
				stateChanged = true;
			}
		} catch (err) {
			// One label, one catch — a leg that throws must not starve the rest.
			legs.push({
				leg,
				ok: false,
				count: 0,
				error: err instanceof Error ? err.message : String(err),
			});
			console.error(`[otta] cron sweep ${leg} FAILED:`, err);
			// A FAILED scan is stamped: retrying a broken full scan every minute would
			// multiply its cost and its error log by fifteen and fix nothing. It is
			// retried at its own cadence, and the failure above is loud every time.
			if (maintenance) {
				state.lastRun[leg] = nowIso;
				stateChanged = true;
			}
		}
	};

	const orderEmailsLeg = async (): Promise<void> =>
		await run("order-emails", async (legBudget) => {
			const emailSender = outboxSender(ctx, options, legBudget);
			// Still `undefined` on a deployment whose bundle carries no email API URL,
			// and that reports `skipped` rather than pretending to drain the outbox — an
			// undrained outbox and a silently discarded one look identical from here.
			if (emailSender === undefined) return { count: 0, skipped: true };
			const batchLimit = emailLimit;
			assertSweepLimit(batchLimit);
			// Checked before each CLAIM, so a stop never strands a leased row; and only
			// when a send could still finish inside the leg (`MIN_SEND_MS` at least).
			const gate = legBudget.gate(MIN_SEND_MS, LEG_QUERY_COSTS["order-emails"].unit);
			let claimsAllowed = 0;
			const count = await dispatchOrderEmails(
				{
					orderStore: stores.orderStore,
					emailSender,
					customerStore: stores.customerStore,
					clock: stores.clock,
				},
				{
					batchLimit,
					shouldContinue: () => {
						if (!gate()) return false;
						claimsAllowed++;
						return true;
					},
					// Asked again just before the send: the claim and the order/customer
					// reads take time of their own. Too little left, and the row goes back
					// untried — its attempt not counted — rather than being sent with a
					// timeout too short to succeed.
					canSend: () => {
						const ok = legBudget.remainingMs() >= MIN_SEND_MS;
						if (!ok) legBudget.stopped = true;
						return ok;
					},
					// Alertable: past ten timeouts a provider is not slow but not working,
					// and from here each timeout counts toward parking the row.
					onRepeatedTimeouts: (row) => {
						console.error(
							`[otta] cron sweep order-emails: the email provider has timed out ${String(row.timeouts)} times` +
								` on outbox row ${row.id} (order ${String(row.orderId)}); further timeouts now count as` +
								" failed attempts and the email will be parked — check the email provider",
						);
					},
				},
			);
			// The dispatcher reports only what it sent, so "more left" is inferred: the
			// budget stopped it, or every claim the batch allowed was taken. The second
			// can also mean the outbox emptied on exactly the last claim — reported as
			// `incomplete` then, harmlessly, since the next tick finds nothing.
			return legResult(count, legBudget.stopped || claimsAllowed >= batchLimit);
		});

	const expireHoldsLeg = async (): Promise<void> =>
		await run("expire-holds", async (legBudget) => {
			// The parity gap, closed: ONE settings read per tick drives the TTL that
			// both the cart hold and this sweep are measured against.
			const settings = await stores.settingsStore.get();
			return batchOutcome(
				await expireHoldsBatch(
					{
						cartStore: stores.cartStore,
						inventoryStore: stores.inventory,
						clock: stores.clock,
						ttlMs: settings.holdTtlMinutes * 60_000,
					},
					now,
					{
						limit: expiryLimit,
						shouldContinue: legBudget.gate(0, LEG_QUERY_COSTS["expire-holds"].unit),
						// The candidate list's own bound: each cart it examines costs a call
						// or two, and a run of carts that yield nothing must not be read in
						// full. Its own gate, so list rows are not mistaken for flips — and
						// sized to keep room for ONE flip after the next candidate, or the
						// list could spend the leg's whole share and expire nothing, every
						// tick.
						shouldContinueListing: legBudget.gate(0, 2 + LEG_QUERY_COSTS["expire-holds"].unit),
					},
				),
			);
		});
	const expireOrdersLeg = async (): Promise<void> =>
		await run("expire-orders", async (legBudget) =>
			batchOutcome(
				await expireOrdersBatch(
					{
						orderStore: stores.orderStore,
						inventoryStore: stores.inventory,
						couponStore: stores.couponStore,
						clock: stores.clock,
					},
					now,
					{
						limit: expiryLimit,
						shouldContinue: legBudget.gate(0, LEG_QUERY_COSTS["expire-orders"].unit),
					},
				),
			),
		);
	// ROTATE which critical leg leads. One unit of real work is most of the Free
	// preset's budget (an order expiry is ~23 calls of 30), so under a backlog the
	// leg that runs first is often the only one that can — and a fixed order would
	// let the first leg's backlog starve the other two forever. Rotating by minute
	// gives each the head of the tick one minute in three; a leg with nothing to do
	// costs only its discovery read, so an idle leader leaves the rest for the
	// others. (On the Paid preset all three usually run every tick.)
	const critical = [orderEmailsLeg, expireHoldsLeg, expireOrdersLeg];
	const lead = Math.floor(now.getTime() / 60_000) % critical.length;
	for (let k = 0; k < critical.length; k++) {
		await critical[(lead + k) % critical.length]!();
	}

	await run(
		"hold-intents",
		async (legBudget) => await completeHoldIntents(storage, stores, nowIso, options, legBudget),
	);

	await run("prune-challenges", async () => ({
		count: await stores.credentialVerifier.pruneChallenges(nowIso),
	}));

	await run(
		"sku-transfers",
		async (legBudget) => await sweepSkuTransfers(storage, stores, cursors, options, legBudget),
	);

	await run(
		"order-sku-index",
		async (legBudget) => await healOrderSkuIndex(storage, stores, now, cursors, options, legBudget),
	);

	await run(
		"reporting-heal",
		async (legBudget) => await healReportingRollups(stores, now, cursors, options, legBudget),
	);

	await run("coupon-orphans", async (legBudget) => {
		// The `expired` arm is the retry for a release `expire-orders` owed, and it
		// relies on that leg having run to the end in this same tick: a redemption it
		// judges while an overdue order is still `pending` is stepped over for good.
		// So a tick whose `expire-orders` did not finish defers this leg instead.
		const expiry = legs.find((entry) => entry.leg === "expire-orders");
		if (
			expiry === undefined ||
			!expiry.ok ||
			expiry.deferred === true ||
			expiry.incomplete === true
		) {
			console.log(
				"[otta] cron sweep coupon-orphans deferred: expire-orders did not finish this tick",
			);
			return { count: 0, deferred: true };
		}
		return await releaseOrphanedRedemptions(storage, stores, now, cursors, options, legBudget);
	});

	if (deferredByBudget.length > 0) {
		console.log(
			`[otta] cron sweep deferred to the next tick: ${deferredByBudget.join(", ")}` +
				` (${String(budget.elapsedMs())}ms of ${String(budget.limits.ms)}ms,` +
				` ${String(budget.queriesUsed())} of ${String(budget.limits.queries)} queries)`,
		);
	}
	if (stateChanged) await cursors.write(STATE_CURSOR, JSON.stringify(state));

	const order = (leg: SweepLeg): number => SWEEP_LEGS.indexOf(leg);
	legs.sort((x, y) => order(x.leg) - order(y.leg));
	return {
		task,
		scheduledAt: nowIso,
		legs,
		budget: {
			timeMs: budget.limits.ms,
			queries: budget.limits.queries,
			expiryBatch: expiryLimit,
			emailBatch: emailLimit,
			queriesUsed: budget.queriesUsed(),
		},
	};
}

// ── budget, cadence & logging ───────────────────────────────────────────────

/**
 * The context the tick runs on: the host's, with every storage, kv and egress
 * call counted against the query budget first. Built on the host context as a
 * PROTOTYPE so every other member (`cron`, and whatever a future host adds) reads
 * through unchanged.
 */
function countingContext(ctx: PluginContext, budget: TickBudget): PluginContext {
	const counted = <T extends object>(target: T): T =>
		new Proxy(target, {
			get(inner, prop, receiver) {
				const value: unknown = Reflect.get(inner, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					budget.countQuery();
					return (value as (...a: unknown[]) => unknown).apply(inner, args);
				};
			},
		});
	const storage =
		ctx.storage === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(ctx.storage).map(([name, collection]) => [name, counted(collection)]),
				);
	return Object.assign(Object.create(ctx) as PluginContext, {
		kv: counted(ctx.kv),
		http: counted(ctx.http),
		...(storage === undefined ? {} : { storage }),
	});
}

/**
 * The outbox's sender, or `undefined` when this deployment has none.
 *
 * Built LAZILY, on the first send: building reads two kv values (the API key, the
 * from-address), and an empty outbox — the usual minute — should not pay them.
 * The per-send timeout is asked AT EACH SEND: what is left of the leg when that
 * send starts, capped at `SWEEP_EMAIL_SEND_TIMEOUT_MS` and never below 1 ms (a
 * zero would mean "no timeout" to some transports).
 */
function outboxSender(
	ctx: PluginContext,
	options: CommerceSweepOptions,
	legBudget: LegBudget,
): EmailSender | undefined {
	if (options.emailSender !== undefined) return options.emailSender;
	const apiUrl = IN_PROCESS_EGRESS_URLS.emailApiUrl;
	const factory =
		options.emailSenderFactory ??
		(apiUrl === undefined || apiUrl.length === 0
			? undefined
			: (requestTimeoutMs: () => number) => makeEmailSender(ctx, { apiUrl }, { requestTimeoutMs }));
	if (factory === undefined) return undefined;
	const timeoutMs = (): number =>
		Math.max(1, Math.min(SWEEP_EMAIL_SEND_TIMEOUT_MS, legBudget.remainingMs()));
	let built: Promise<EmailSender | undefined> | undefined;
	const attempt = async (input: Parameters<EmailSender["send"]>[0]): Promise<void> => {
		built ??= factory(timeoutMs);
		const sender = await built;
		// Unreachable while the URL check above and `makeEmailSender` agree; a throw
		// here is a failed send, rescheduled like any other.
		if (sender === undefined) throw new Error("email sender is not configured");
		await sender.send(input);
	};
	return {
		/**
		 * The WHOLE send is raced against a timer — not only the request the
		 * sender's own abort signal covers. Everything before the request (building
		 * the sender's kv reads, and the host's `ctx.http.fetch` resolving the
		 * provider's address over DNS-over-HTTPS, which does not observe our signal)
		 * can hang too. If the timer wins it is a TIMEOUT: the row goes back
		 * uncounted, and should the provider deliver late after all, the retry's
		 * `Idempotency-Key` (the outbox row id) lets it dedupe.
		 */
		async send(input) {
			const limitMs = timeoutMs();
			// Given LESS than the full cap (the tick was short of time): a timeout then
			// is ours, not the provider's — handed back due at once, uncounted, with
			// no backoff and no timeout recorded against the row.
			const cutShort = limitMs < SWEEP_EMAIL_SEND_TIMEOUT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new EmailSendTimeoutError(limitMs, { cutShort })), limitMs);
			});
			const sending = attempt(input);
			// The losing side of the race must not surface as an unhandled rejection.
			sending.catch(() => undefined);
			try {
				await Promise.race([sending, deadline]);
			} catch (err) {
				// The sender's own abort fires with the same limit; whichever side wins,
				// it is one timeout, carrying whether the allowance was the full one.
				if (isEmailSendTimeoutError(err)) {
					throw new EmailSendTimeoutError(limitMs, { cutShort });
				}
				throw err;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/** Whether the "skipped — no email URL" line was logged in this isolate: it is
 *  true every minute on such a deployment, so it is said once, not 1,440 times a day. */
let loggedSkipped = false;

/**
 * One line for a leg that DID something worth reading: a non-zero count, more
 * left for the next tick, or a deployment fact. An idle leg is silent — at one
 * tick a minute, nine idle lines would bury the lines that matter. Failures
 * (`console.error`) and deferrals (their own line) are logged elsewhere.
 */
function logOutcome(outcome: SweepLegOutcome): void {
	if (outcome.skipped === true) {
		if (!loggedSkipped) {
			loggedSkipped = true;
			console.log(`[otta] cron sweep ${outcome.leg} skipped — not wired on this deployment`);
		}
		return;
	}
	if (outcome.count > 0 || outcome.incomplete === true) {
		console.log(
			`[otta] cron sweep ${outcome.leg} ${String(outcome.count)}` +
				(outcome.incomplete === true ? " (more next tick)" : ""),
		);
	}
	for (const anomaly of outcome.anomalies ?? []) {
		console.error(`[otta] cron sweep ${outcome.leg} ANOMALY ${anomaly}`);
	}
}

function batchOutcome(result: { count: number; drained: boolean }): {
	count: number;
	incomplete?: true;
} {
	return result.drained ? { count: result.count } : { count: result.count, incomplete: true };
}

function isDue(lastRunIso: string | undefined, now: Date): boolean {
	if (lastRunIso === undefined) return true;
	const last = Date.parse(lastRunIso);
	// An unreadable stamp, or one from the future (a clock step back), is treated as
	// "never ran": running a scan early is idempotent; skipping it is not visible.
	if (Number.isNaN(last) || last > now.getTime()) return true;
	return now.getTime() - last >= MAINTENANCE_LEG_INTERVAL_MS;
}

/** The cadence state: each scan's last completion, each leg's deferral streak. */
interface SweepState {
	lastRun: Partial<Record<SweepLeg, string>>;
	deferrals: Partial<Record<SweepLeg, number>>;
}

/** A lost or garbled state only makes every scan due and resets the streaks —
 *  the same "a lost cursor costs a re-read" rule as every other cursor here. */
async function readState(cursors: SweepCursorStore): Promise<SweepState> {
	const state: SweepState = { lastRun: {}, deferrals: {} };
	const raw = await cursors.read(STATE_CURSOR);
	if (raw === null) return state;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return state;
		const { lastRun, deferrals } = parsed as { lastRun?: unknown; deferrals?: unknown };
		for (const leg of SWEEP_LEGS) {
			const stamp = (lastRun as Record<string, unknown> | undefined)?.[leg];
			if (typeof stamp === "string" && MAINTENANCE_LEGS.includes(leg)) state.lastRun[leg] = stamp;
			const streak = (deferrals as Record<string, unknown> | undefined)?.[leg];
			if (typeof streak === "number" && Number.isInteger(streak) && streak > 0) {
				state.deferrals[leg] = streak;
			}
		}
		return state;
	} catch {
		return state;
	}
}

// ── cursors ─────────────────────────────────────────────────────────────────

/**
 * The default cursor store: `ctx.kv`, which is ungated and plugin-scoped.
 *
 * BOTH HALVES SWALLOW THEIR FAILURES, on purpose and with a log line. A cursor is
 * an optimisation over a correct-but-wasteful full re-read: losing one costs a
 * repeat of work that is idempotent by construction. Failing the leg because its
 * bookmark could not be saved would trade a cheap re-read for no sweep at all.
 */
function kvCursors(ctx: PluginContext): SweepCursorStore {
	return {
		async read(name) {
			try {
				const value = await ctx.kv.get<string>(`${CURSOR_KEY_PREFIX}${name}`);
				return typeof value === "string" && value !== "" ? value : null;
			} catch (err) {
				console.error(`[otta] cron sweep cursor read failed (${name}):`, err);
				return null;
			}
		},
		async write(name, value) {
			try {
				await ctx.kv.set(`${CURSOR_KEY_PREFIX}${name}`, value);
			} catch (err) {
				console.error(`[otta] cron sweep cursor write failed (${name}):`, err);
			}
		},
	};
}

/** One bounded pass over a declared index. */
interface ScannedWindow<T> {
	readonly items: readonly { id: string; data: T }[];
	/** True when the window was read to its END inside the page budget — which is
	 *  what tells a rotating cursor to wrap and a forward cursor that it is caught
	 *  up. False means "more to come", never "silently truncated". */
	readonly reachedEnd: boolean;
	/** True when the TICK's budget, not the page budget, ended the read. */
	readonly outOfTime: boolean;
}

/**
 * Page a collection on a DECLARED index, bounded by `maxPages`.
 *
 * The bound is structural here rather than remembered at each call site, and —
 * unlike the adapters' `ScanPageLimitError` convention, which exists because a
 * caller asking for "all expirable orders" must never be handed a short list — a
 * short read is CORRECT for a sweep: every caller below carries a cursor, so the
 * rows this pass did not reach are the rows the next tick starts from. What must
 * never happen is a short read with no cursor, which is the bug this replaced.
 */
async function scanWindow<T>(
	collection: ReturnType<typeof collectionOf<T>>,
	query: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc"> },
	options: CommerceSweepOptions,
	budget: LegBudget,
): Promise<ScannedWindow<T>> {
	const limit = options.pageSize ?? DEFAULT_PAGE_SIZE;
	const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
	const items: { id: string; data: T }[] = [];
	let cursor: string | undefined;
	const gate = budget.gate();
	for (let page = 0; page < maxPages; page++) {
		// Same contract as running out of pages: what was read is handled, and the
		// caller's cursor resumes from there.
		if (!gate()) return { items, reachedEnd: false, outOfTime: true };
		const result = await collection.query({
			...query,
			limit,
			...(cursor === undefined ? {} : { cursor }),
		} as Parameters<typeof collection.query>[0]);
		items.push(...result.items);
		if (!result.hasMore || result.cursor === undefined) {
			return { items, reachedEnd: true, outOfTime: false };
		}
		cursor = result.cursor;
	}
	return { items, reachedEnd: false, outOfTime: false };
}

/**
 * Walk a window's rows while the tick has time, and say how far it got.
 *
 * Every per-row loop below goes through here so the budget is checked between
 * rows, never inside one — a row's work is a guarded write sequence that is safe
 * to stop BEFORE but pointless to abandon halfway. `handled` is what a cursor may
 * advance past; `incomplete` is set when time (in the read or the walk) left rows
 * for the next tick.
 */
async function walkWindow<T>(
	window: ScannedWindow<T>,
	budget: LegBudget,
	leg: SweepLeg,
	visit: (item: { id: string; data: T }) => Promise<void>,
): Promise<{ handled: readonly { id: string; data: T }[]; incomplete: boolean }> {
	let handled = 0;
	const gate = budget.gate(0, LEG_QUERY_COSTS[leg].unit);
	for (const item of window.items) {
		if (!gate()) break;
		await visit(item);
		handled++;
	}
	const allHandled = handled === window.items.length;
	return {
		handled: allHandled ? window.items : window.items.slice(0, handled),
		incomplete: window.outOfTime || !allHandled,
	};
}

/** `{ count }`, plus the markers a leg wants surfaced — only when they apply, so a
 *  clean outcome stays exactly `{ count }`. */
function legResult(
	count: number,
	incomplete: boolean,
	anomalies: readonly string[] = [],
): { count: number; incomplete?: true; anomalies?: readonly string[] } {
	return {
		count,
		...(incomplete ? { incomplete: true as const } : {}),
		...(anomalies.length > 0 ? { anomalies } : {}),
	};
}

/**
 * The next lower bound for a FORWARD cursor after a walk.
 *
 * A complete walk rewinds from its newest row by the overlap, as always. A walk
 * the budget CUT SHORT must still make progress: on a tight budget the rows one
 * tick handles can all fall inside the overlap, and rewinding by it would park
 * the cursor where it started — the leg would re-read the same rows every tick
 * and never reach the rest, which is the starvation every cursor here exists to
 * prevent. So a partial walk keeps the overlap only when that still moves the
 * cursor forward, and otherwise steps to 1 ms before its newest handled row
 * (`gt`, so that row's own instant is re-read: a tie is never stepped over).
 */
function nextCursorAfterWalk(
	handled: readonly { data: { createdAt?: string } }[],
	incomplete: boolean,
	previous: string | null,
): string | null {
	const rewound = nextForwardCursor(handled);
	if (!incomplete || rewound === null) return rewound;
	if (previous === null || rewound > previous) return rewound;
	const newest = nextForwardCursor(handled, 1);
	return newest !== null && newest > previous ? newest : previous;
}

/** The newest `createdAt` a window read, rewound by `overlapMs` — the next tick's
 *  lower bound. `null` for an empty window, which leaves the cursor where it was. */
function nextForwardCursor(
	items: readonly { data: { createdAt?: string } }[],
	overlapMs = CURSOR_OVERLAP_MS,
): string | null {
	let newest: string | null = null;
	for (const item of items) {
		const at = item.data.createdAt;
		if (typeof at !== "string") continue;
		if (newest === null || at > newest) newest = at;
	}
	if (newest === null) return null;
	const rewound = new Date(Date.parse(newest) - overlapMs);
	return Number.isNaN(rewound.getTime()) ? null : rewound.toISOString();
}

// ── the five completers ──────────────────────────────────────────────────────

/**
 * SKU-TRANSFER COMPLETION (ADR-0019 sweeper concern 5).
 *
 * A rename moves units between two `inventory/{sku}` documents while the decision
 * lives in a third (`product_commerce/{productId}`), so the intent is RECORDED in
 * the same compare-and-set that commits the new sku and whoever finds it finishes
 * it. This is the "whoever" of last resort.
 *
 * DISCOVERY GOES THROUGH PRODUCTS, not inventory, and that is forced rather than
 * chosen: `INVENTORY_COLLECTIONS` declares ZERO indexes, so `transferOut` is not a
 * queryable field and a stamped source sku cannot be found by asking for stamped
 * source skus. `product_commerce` declares `createdAt`, so the products are
 * scannable, and a product that owes nothing costs one already-fetched document
 * to rule out.
 *
 * AND THE CURSOR ROTATES, because `product_commerce` declares nothing that says
 * "this product has a pending rename" — there is no `holdsPendingAt` analogue to
 * narrow by, so the predicate cannot shrink as the work completes. A fixed
 * `createdAt ASC` scan would therefore re-read the oldest page every tick and
 * never reach a stranded carry on a catalog larger than one tick's budget. So the
 * cursor advances through the catalog and WRAPS at the end: every product is
 * visited within one rotation, whatever the catalog's size.
 */
async function sweepSkuTransfers(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
	budget: LegBudget,
): Promise<{ count: number; incomplete?: true }> {
	const products = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
	const from = await cursors.read(SKU_TRANSFER_CURSOR);
	const window = await scanWindow<ProductCommerceDoc>(
		products,
		{
			...(from === null ? {} : { where: { createdAt: { gt: from } } }),
			orderBy: { createdAt: "asc" },
		},
		options,
		budget,
	);
	let finished = 0;
	const walked = await walkWindow(window, budget, "sku-transfers", async (item) => {
		const sources = new Set<string>();
		for (const record of Object.values(item.data.pendingRenames ?? {})) sources.add(record.fromSku);
		for (const variant of Object.values(item.data.variants ?? {})) {
			for (const record of Object.values(variant.pendingRenames ?? {})) sources.add(record.fromSku);
		}
		// Nothing recorded: not a candidate, and not a read.
		if (sources.size === 0) return;
		finished += await stores.productCommerce.completeRecordedRenames(item.data.productId);
		// And the OTHER half of the same coupling: a carry whose product record was
		// already cleared can still have left `inventory/{fromSku}` stamped. One read
		// per source sku when there is no stamp, so it costs nothing in the common case.
		for (const sku of sources) {
			if (await stores.productCommerce.completePendingSkuTransfer(sku)) finished++;
		}
	});
	// WRAP at the end of the catalog; otherwise carry on from the newest row
	// HANDLED — which, when the budget stopped the walk, is short of the newest read.
	// The rotation is also what heals a row this pass stepped over at a page seam:
	// the next full turn reads it again.
	const next = window.reachedEnd && !walked.incomplete ? "" : lastCreatedAt(walked.handled);
	if (next !== null) await cursors.write(SKU_TRANSFER_CURSOR, next);
	return legResult(finished, walked.incomplete);
}

/** The last row's `createdAt` in an ASC window — the exact resume point, with no
 *  overlap, because this cursor's safety net is the rotation rather than a rewind. */
function lastCreatedAt(items: readonly { data: { createdAt?: string } }[]): string | null {
	const last = items.at(-1);
	const at = last?.data.createdAt;
	return typeof at === "string" ? at : null;
}

/**
 * `order_sku_index` HEAL (ADR-0019 sweeper concern 7 — derived pointers).
 *
 * The by-sku search arm reads these pointers, and they are DERIVED: an order is
 * truth, a pointer is a cache of one of its facts. A crash between the order write
 * and its pointer writes makes an order invisible to a sku search while remaining
 * perfectly valid everywhere else — the exact failure a derived pointer has, and
 * the reason it must be swept rather than trusted.
 *
 * CREATE-IF-ABSENT ONLY, via `compareAndSet(id, null, …)`: the heal never
 * overwrites an existing pointer, so it cannot clobber a live writer, and two
 * sweeps racing the same gap produce one pointer because exactly one wins the
 * guarded create. A pointer with no order is deliberately NOT deleted here —
 * that is a different concern with a different failure mode, and this leg's whole
 * claim is that it only ever adds what an order already says.
 *
 * THE AGREEMENT CHECK IS THE ADAPTER'S, reproduced. `EmdashOrderStore` pairs its
 * own create-if-absent with `#assertPointerAgrees`: a create that did not apply is
 * fine when the incumbent names the SAME order and is a `DerivedPointerConflictError`
 * when it names another. Both of those are private, and the adapter exposes no
 * public heal — so this leg reproduces the write AND the check rather than the
 * write alone, which is what the first cut did. That duplication is a real seam and
 * is recorded as a follow-up: the right home is a public method on the adapter that
 * owns the collection, which is a `@otta-sh/store-emdash` change and outside this
 * increment.
 *
 * THE CURSOR ADVANCES rather than the window being pinned to `now - 48h`. A fixed
 * lower bound scanned `createdAt ASC` under a page budget can never reach the
 * NEWEST orders on a busy store — precisely the ones a crash just orphaned. The
 * lookback is now only the floor a cursor-less first run starts from.
 */
async function healOrderSkuIndex(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	now: Date,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
	budget: LegBudget,
): Promise<{ count: number; incomplete?: true; anomalies?: readonly string[] }> {
	const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
	const pointers = collectionOf<OrderSkuIndexDoc>(storage, ORDER_SKU_INDEX_COLLECTION);
	const floor = new Date(
		now.getTime() - (options.skuIndexLookbackMs ?? DEFAULT_SKU_INDEX_LOOKBACK_MS),
	).toISOString();
	const saved = await cursors.read(SKU_INDEX_CURSOR);
	const since = saved !== null && saved > floor ? saved : floor;
	const anomalies: string[] = [];
	let written = 0;
	const window = await scanWindow<OrderDoc>(
		orders,
		{ where: { createdAt: { gt: since } }, orderBy: { createdAt: "asc" } },
		options,
		budget,
	);
	const walked = await walkWindow(window, budget, "order-sku-index", async (item) => {
		const doc = item.data;
		for (const foldedSku of orderSkuKeys(doc)) {
			const id = orderSkuIndexId(foldedSku, doc.orderId);
			const applied = await pointers.compareAndSet(id, null, {
				sku: foldedSku,
				orderId: doc.orderId,
				// The order's own creation instant, frozen: what makes the arm a keyset arm.
				createdAt: doc.createdAt,
			});
			if (applied.applied) {
				written++;
				continue;
			}
			// Did not apply: either the pointer is already this order's (the healthy
			// case, and the reason a heal is cheap) or it belongs to another order,
			// which is the conflict the adapter raises rather than overwrites.
			const incumbent = await pointers.get(id);
			if (incumbent === null || incumbent.orderId === doc.orderId) continue;
			anomalies.push(`${ORDER_SKU_INDEX_COLLECTION}/${id}: held by ${incumbent.orderId}`);
			await stores.orderStore.flagReconciliation(
				toOrderId(doc.orderId),
				`sku pointer ${id} is held by order ${incumbent.orderId}`,
			);
		}
	});
	const next = nextCursorAfterWalk(walked.handled, walked.incomplete, saved);
	if (next !== null && next !== saved) await cursors.write(SKU_INDEX_CURSOR, next);
	return legResult(written, walked.incomplete, anomalies);
}

/**
 * PARTIAL ADOPT/COMMIT/RELEASE COMPLETION (D2, ADR-0019 sweeper concern 3).
 *
 * An order's holds are adopted, committed and released one reservation at a time,
 * and the SET of those per-id writes is not atomic with the order flip that decided
 * them. So the flip records its INTENT on the order — the reservation ids, and a
 * `completedAt` that stays null while work is owed — and `holdsPendingAt` carries
 * the earliest such intent as a DECLARED INDEX. That index is this leg's whole
 * discovery: the orders with outstanding hold work are exactly the orders whose
 * `holdsPendingAt` is at or before now.
 *
 * NO CURSOR HERE, and that is the point of the field: `holdsPendingAt` goes NULL
 * once the order owes nothing, so the predicate narrows by itself as the work
 * completes. A tick that runs out of budget leaves the remainder still matching,
 * and the next tick starts with them.
 *
 * HAZARD 1 lives here and is respected by construction: the completers below walk
 * the order's own intent and drive per-id calls. `commitMany` skips ids already
 * terminal in `reservation_index`, so replaying a batch over a partly-committed set
 * would silently complete nothing and stamp the intent done.
 *
 * HAZARD 2 is handled below the calls: their guard reads a non-versioned `get`, so
 * a `lost` id is re-judged against the order's CURRENT state before it counts as an
 * anomaly — and one that survives is WRITTEN TO THE ORDER, not merely returned.
 */
async function completeHoldIntents(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	nowIso: string,
	options: CommerceSweepOptions,
	budget: LegBudget,
): Promise<{ count: number; incomplete?: true; anomalies?: readonly string[] }> {
	const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
	const anomalies: string[] = [];
	let completed = 0;
	const window = await scanWindow<OrderDoc>(
		orders,
		{ where: { holdsPendingAt: { lte: nowIso } }, orderBy: { holdsPendingAt: "asc" } },
		options,
		budget,
	);
	const walked = await walkWindow(window, budget, "hold-intents", async (item) => {
		const id = toOrderId(item.data.orderId);
		const attempts = [
			{ kind: "adopt" as const, result: await stores.orderStore.completeHoldAdoption(id) },
			{ kind: "commit" as const, result: await stores.orderStore.completeHoldCommit(id) },
			{ kind: "release" as const, result: await stores.orderStore.completeHoldRelease(id) },
		];
		const lost = attempts.filter((attempt) => attempt.result.lost.length > 0);
		completed += attempts.filter((attempt) => attempt.result.completed).length;
		if (lost.length === 0) return;
		// HAZARD 2. The completers decided from a non-versioned read; re-read the
		// order NOW and keep only the losses that are still the order's problem.
		const current = await orders.get(item.data.orderId);
		const state = current === null ? null : current.state;
		if (state === null) return;
		const real: string[] = [];
		for (const attempt of lost) {
			if (!INTENT_OWNER_STATE[attempt.kind].includes(state as OrderState)) continue;
			for (const reservationId of attempt.result.lost) {
				anomalies.push(`${item.data.orderId}:${attempt.kind}:${reservationId}`);
				real.push(`${attempt.kind} ${reservationId}`);
			}
		}
		// ADR-0019 §7.13: an anomaly must always be RECORDABLE. The hook's return
		// value is not a record — the cron executor discards it — so the finding goes
		// onto the order, where an operator (and the admin's reconciliation surface)
		// will actually meet it.
		if (real.length > 0) {
			await stores.orderStore.flagReconciliation(
				id,
				`cron sweep: hold reservations lost while the order was ${state} — ${real.join(", ")}`,
			);
		}
	});
	return legResult(completed, walked.incomplete, anomalies);
}

/**
 * REPORTING ROLLUP HEAL (D3 item 4).
 *
 * The daily rollup is a different aggregate from the orders it counts, so a crash
 * between an order's write and its rollup delta leaves the day wrong. `reconcile`
 * recomputes a day from the orders themselves and rewrites it only when it differs,
 * which is what makes re-reconciling affordable.
 *
 * MORE THAN ONE DAY, deliberately. The first cut reconciled exactly `now - 24h` and
 * nothing else, so a day lost to a deploy outage, a paused cron or a day whose
 * reconcile kept failing was never healed by any later tick — the one gap the leg
 * exists to close was the one it could not close. A cursor now records the last day
 * healed and the leg walks forward from there.
 *
 * THE LIVE DAY IS NEVER RECONCILED FROM A SCHEDULE — that is the reporting store's
 * own rule (a live day is reconciled on demand) — so the walk always stops at the
 * CLOSED day, and the closed day itself is re-done on every tick because orders
 * from it can still settle. Everything older is healed once and left alone.
 *
 * BOUNDED AT BOTH ENDS. A cursor-less first run reaches back `reportingBackfillDays`
 * and no further (older than that is a backfill, not a sweep), and one tick
 * reconciles at most `reportingMaxDaysPerTick` days — the reporting store's own
 * docs ask a caller sweeping history to chunk it, because its page budget is per
 * day but its latency is not.
 *
 * ONE DAY PER BUDGET CHECK. A day is the unit: the budget is asked before each,
 * and the cursor records the last day FINISHED, so a tick that runs out part-way
 * keeps the days it finished and the next tick resumes at the first it did not. (The
 * closed day is the last of every walk, so a walk cut short simply re-does it on
 * the tick that completes.)
 */
async function healReportingRollups(
	stores: InProcessCommerceStores,
	now: Date,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
	budget: LegBudget,
): Promise<{ count: number; incomplete?: true }> {
	const closed = dayKey(new Date(now.getTime() - DAY_MS));
	const floor = addDays(
		closed,
		-(options.reportingBackfillDays ?? DEFAULT_REPORTING_BACKFILL_DAYS),
	);
	const saved = await cursors.read(REPORTING_CURSOR);
	// `YYYY-MM-DD` compares lexicographically exactly as it compares chronologically.
	let from = saved === null ? floor : addDays(saved, 1);
	if (from < floor) from = floor;
	if (from > closed) from = closed;
	const span = (options.reportingMaxDaysPerTick ?? DEFAULT_REPORTING_MAX_DAYS_PER_TICK) - 1;
	const capped = addDays(from, Math.max(span, 0));
	const to = capped < closed ? capped : closed;
	const gate = budget.gate(0, LEG_QUERY_COSTS["reporting-heal"].unit);
	let written = 0;
	let finished: string | null = null;
	let incomplete = false;
	for (let day = from; day <= to; day = addDays(day, 1)) {
		if (!gate()) {
			incomplete = true;
			break;
		}
		const result = await stores.reportingStore.reconcile({
			from: `${day}T00:00:00.000Z`,
			to: `${day}T23:59:59.999Z`,
		});
		written += result.documentsWritten;
		finished = day;
	}
	// One write for the walk, naming the last day FINISHED: a cut-short walk
	// resumes at the first day it did not reach.
	if (finished !== null) await cursors.write(REPORTING_CURSOR, finished);
	return legResult(written, incomplete);
}

function dayKey(at: Date): string {
	return at.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
	return dayKey(new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS));
}

/**
 * THE COUPON SWEEPER (ADR-0019 sweeper concern 6; the ratified INC-C4 brief
 * amendment).
 *
 * A redemption claims its once-only key, then claims a per-customer slot, then
 * bumps the coupon's global counter — three documents, no transaction. A checkout
 * that dies after the claim leaves a redemption holding a use and a slot for an
 * order that never became durable: the coupon looks exhausted, and the customer
 * looks like they already used it.
 *
 * WHAT IS RELEASED: a redemption whose order does not exist (the domain's rule —
 * `reconcileCouponRedemptions` in `@otta-sh/domain` releases exactly the
 * `getById === null` case), OR whose order is `expired`.
 *
 * THE EXPIRED ARM IS THE RETRY FOR `expireOrders`, not a redundancy. That use-case
 * makes the guarded `pending → expired` flip durable FIRST and calls
 * `couponStore.releaseByOrder` after it; a crash between the two leaves an expired
 * order still holding its coupon use, and nothing else would ever free it —
 * `listExpirable` only returns pending orders, and an order that exists is not an
 * orphan. An expired order owes its coupon back by policy (expiry releases it), so
 * releasing here is completing owed work, and `release` is idempotent, so the
 * normal case (already released by `expireOrders`) finds no redemption holding a use.
 * A declined-and-abandoned order ends on exactly this path (ADR-0022).
 *
 * It relies on ORDER within a tick: this leg runs after `expire-orders` — and only
 * when that leg ran to the END this tick (a deferred or cut-short `expire-orders`
 * defers this leg too, see `runCommerceSweeps`) — and the
 * grace window (`DEFAULT_COUPON_GRACE_MS`) is not shorter than the order hold
 * (`DEFAULT_CHECKOUT_TTL_MS`), so by the time a redemption is old enough to be
 * judged its order is already due and has been through `expire-orders` in the same
 * tick. The residual — that leg failing outright AND the later release then
 * crashing — needs two faults.
 *
 * `cancelled` is deliberately NOT released: `cancelOrder` releases no coupon, and a
 * sweeper that did would silently reverse that shipped policy an hour after the
 * fact, handing back a per-customer slot for a coupon a real order consumed. A
 * change to that policy belongs in an ADR, not in a sweeper.
 *
 * WHY NOT JUST CALL `reconcileCouponRedemptions`. Its rule is reused verbatim and
 * its grace default is imported rather than re-picked, but its READ cannot be: it
 * calls `listRedemptionsCreatedBefore(cutoff)`, which collects EVERY redemption
 * still holding a use — up to a hundred thousand documents — on every run. That read is the leg's other blocking defect, because `holdsUse` stays
 * `"yes"` for a terminal `applied` redemption: the list is dominated by legitimate
 * redemptions that will never be released, sorted oldest-first, so any fixed-size
 * bite out of its head is permanently occupied by them and a new orphan is never
 * reached. `state` is NOT a declared index, so it cannot be filtered on.
 *
 * SO THE WINDOW ADVANCES. The leg queries `coupon_redemptions` directly on the two
 * fields that ARE declared — `createdAt` and `holdsUse` — between a cursor and the
 * grace cutoff, and moves the cursor past everything it judged. A redemption ruled
 * live stays behind the cursor forever, which is correct: an order that exists now
 * exists for good, so it can never become an orphan later. An orphan is reached on
 * the tick that first sees it, whatever the collection's size.
 *
 * RELEASE is `CouponStore.release`, not a hand-rolled undo, and that matters: it
 * settles an ambiguous `bumping` redemption to a terminal state FIRST — rather than
 * guessing whether the counter was touched — then frees the per-customer slot, then
 * deletes the claim, and only decrements the global counter when the settled state
 * says it was actually consumed. Idempotent by construction: a second sweep finds
 * no redemption to release.
 *
 * WHAT THIS LEG DOES NOT DO, said plainly rather than left to be discovered:
 * ADR-0019 also requires a RECOUNT of the global counter, because a release that
 * dies between the guarded delete and the decrement leaves `usesCount` one HIGH and
 * a recount is the only thing that restores exactness. `CouponStore` exposes no
 * recount, and adding one is a `@otta-sh/store-emdash` change — out of this
 * increment's scope. The residual is in the SAFE direction (a use nobody holds
 * refuses a redemption that might have fit; it never grants one that does not).
 */
async function releaseOrphanedRedemptions(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	now: Date,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
	budget: LegBudget,
): Promise<{ count: number; incomplete?: true }> {
	const redemptions = collectionOf<CouponRedemptionDoc>(storage, COUPON_REDEMPTIONS_COLLECTION);
	const cutoff = new Date(
		now.getTime() - (options.couponGraceMs ?? DEFAULT_COUPON_GRACE_MS),
	).toISOString();
	const from = await cursors.read(COUPON_CURSOR);
	const createdAt = from === null ? { lt: cutoff } : { gt: from, lt: cutoff };
	const window = await scanWindow<CouponRedemptionDoc>(
		redemptions,
		{ where: { createdAt, holdsUse: "yes" }, orderBy: { createdAt: "asc" } },
		options,
		budget,
	);
	let released = 0;
	const walked = await walkWindow(window, budget, "coupon-orphans", async (item) => {
		const order = await stores.orderStore.getById(toOrderId(item.data.orderId));
		// A missing order is an orphan; an EXPIRED one is owed its coupon back and may
		// have lost the release to a crash (see above). Every other state keeps it.
		if (order !== null && order.state !== "expired") return;
		await stores.couponStore.release(item.data.redemptionId);
		released++;
	});
	// Only past what was JUDGED: a row the budget left unread or unvisited must still
	// be ahead of the cursor on the next tick.
	const next = nextCursorAfterWalk(walked.handled, walked.incomplete, from);
	if (next !== null && next !== from) await cursors.write(COUPON_CURSOR, next);
	return legResult(released, walked.incomplete);
}
