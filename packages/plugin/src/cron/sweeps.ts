/**
 * The scheduled sweep: twelve legs, one tick (INC-C4).
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
 * the others beside it. A tick therefore always returns a summary, and a failed
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
 * `createdAt`+`holdsUse` for the coupon orphans, `createdAt`+`lifecycle` for the
 * product orphans — and anything else is decided from the document once it is in
 * hand.
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
 *    product is reached within one rotation regardless of catalog size. Two legs
 *    rotate it, each on its own cursor: `sku-transfers` and `product-orphans`.
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
 *  - each leg may use only a SHARE of the tick (never less than one unit of its own
 *    work), so a hung provider or a backlog cannot take it all — and a leg its share
 *    stopped gets a SECOND PASS on whatever the tick has left once every leg has had
 *    its turn (a share is a cap, not a reservation);
 *  - the expiry legs take bounded bites (`expiryBatchLimit`), so a backlog drains
 *    over several ticks instead of eating one;
 *  - and the counter itself refuses any call past the budget
 *    (`SweepQueryCeilingError`, see `tick-budget.ts`): the backstop for a unit
 *    whose estimate was wrong. Every call is attributed to its leg, and a tick that
 *    did work logs one line saying what each leg spent.
 *
 * THE ORDER (QA2 M2, `LEG_PRIORITY` and `tickOrder`). `cancel-intents` first —
 * a due payment intent is withdrawn before anything can spend the tick — then the
 * money legs (`expire-orders`, `hold-intents`, `expire-holds`), the outbox, the
 * late-refund retry, and housekeeping last. Priority alone starves on the Free
 * preset (QA saw legs deferred for hours), so a leg passed over `AGING_TICKS`
 * ticks in a row with work goes to the head of the next tick: no leg waits
 * without bound, however busy the others are. `cron-sweep-backlog.test.ts`
 * simulates a backlog in every leg and pins the numbers.
 *
 * AND THE SCANS KEEP THEIR OLD CADENCE. The task is due every minute now (the
 * site's Worker cron's own resolution), which is what holds and mail need. The
 * four scan legs and the sign-in challenge prune (`MAINTENANCE_LEGS`) are a
 * different cost: each reads up to
 * `maxPages` pages of a collection, and `reporting-heal` re-reconciles the closed
 * day, on every run. Fifteen times the reads would buy nothing — they heal crash
 * residue, which is rare and not customer-visible within minutes — so each runs
 * only when `MAINTENANCE_LEG_INTERVAL_MS` has passed since it last COMPLETED (a
 * stamp in the cursor store). A scan the budget deferred or cut short is not
 * stamped, so it is due again on the very next tick. The other legs are not
 * free when idle — each asks one indexed "anything due?" read, and the tick reads
 * its setting and cadence state — eight queries an idle minute, not a page budget.
 * A leg the budget deferred last tick is not asked again (its work is known).
 *
 * THE HOLD TTL IS THE ADMIN'S SETTING. One settings read per tick feeds
 * `expireHolds`' `ttlMs` — the same `holdTtlMinutes` the in-process client reads
 * on every cart call that stamps or measures a deadline (issue #127), so a hold's
 * deadline, its lazy expiry and this sweep all agree on one window.
 */
import {
	assertSweepLimit,
	cancelDueIntents,
	DEFAULT_COUPON_GRACE_MS,
	dispatchOrderEmails,
	EmailSendTimeoutError,
	escalateStaleLateRefunds,
	expireHoldsBatch,
	expireOrdersBatch,
	finishCancellationRestock,
	idempotencyKey as toIdempotencyKey,
	isEmailSendTimeoutError,
	orderId as toOrderId,
	productId as toProductId,
	retryLatePaymentRefunds,
	softDeleteProductCommerce,
	UnitBackoff,
	type EmailSender,
	type OrderId,
	type OrderState,
} from "@otta-sh/domain";
import {
	CARTS_COLLECTION,
	collectionOf,
	COUPON_REDEMPTIONS_COLLECTION,
	EmdashReportingStore,
	isScanPageLimitError,
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
	UNMETERED_COLLECTION,
} from "@otta-sh/store-emdash";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
} from "../commerce/in-process-commerce-stores.js";
import {
	EMAIL_SENDER_BUILD_READS,
	EMAIL_TRANSPORT_RESOLVE_READS,
	type EmailTransport,
	makeEmailSender,
	resolveEmailTransport,
} from "../email/ctx-http-email-sender.js";
import { providerDedupesRetries } from "../email/email-provider.js";
import { countTimeoutsAsAttempts } from "../email/http-email-sender.js";
import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import {
	boundedRefundStripeOptions,
	type BoundedRefundStripeOptions,
	type RefundTimeBudget,
} from "../payments/bounded-refund-options.js";
import {
	resolvePaymentGateways,
	type PaymentGateways,
} from "../payments/resolve-payment-gateways.js";
import type { StripeGatewayOptions } from "../payments/stripe-wiring.js";
import { deriveDeleteIdempotencyKey } from "../sync/derive-idempotency-key.js";
import { PRODUCTS_COLLECTION } from "../sync/hooks.js";
import type { ContentReadAccess, PluginContext } from "../types.js";
import { DEFAULT_BACKGROUND_WORK, readBackgroundWork } from "./background-work-setting.js";
import {
	isSweepQueryCeilingError,
	SweepQueryCeilingError,
	type LegBudget,
	type LegShare,
	TickBudget,
	WHOLE_TICK,
} from "./tick-budget.js";

/** The twelve legs in the order a SUMMARY lists them (and the order the sweep ran
 *  them in before QA2 M2). The order a tick RUNS them in is `LEG_PRIORITY`, with
 *  `cancel-intents` always first and aged legs ahead of the rest (`tickOrder`). */
export const SWEEP_LEGS = [
	"order-emails",
	"expire-holds",
	"expire-orders",
	"cancel-intents",
	"hold-intents",
	"prune-challenges",
	"sku-transfers",
	"order-sku-index",
	"reporting-heal",
	"coupon-orphans",
	"product-orphans",
	"late-refunds",
] as const;

export type SweepLeg = (typeof SWEEP_LEGS)[number];

/**
 * The legs that run on the slow cadence rather than every tick: the five that walk
 * a collection (or a whole closed day) on every run, and the sign-in challenge
 * prune. The others find their work from a predicate that narrows as the work
 * completes, so an idle run is one empty query — cheap enough for every minute.
 */
export const MAINTENANCE_LEGS: readonly SweepLeg[] = [
	// Not a scan, but housekeeping on the same footing (QA2 M2): expired and used
	// sign-in challenges are refused at verify time whatever this does, so deleting
	// them is storage hygiene, not something a customer waits on — and its two
	// discovery reads every minute were a fifteenth of an idle Free tick.
	"prune-challenges",
	"sku-transfers",
	"order-sku-index",
	"reporting-heal",
	"coupon-orphans",
	// A CMS document whose delete hook was lost is not customer-visible within
	// minutes (the storefront lists from the CMS); what it blocks — the sku, a
	// tidy Pricing & inventory list — can wait for the slow cadence.
	"product-orphans",
];

/**
 * The order a tick runs its legs in (QA2 M2), before aging (`tickOrder`):
 *
 *  1. `cancel-intents` — ALWAYS first: an intent due at its order's hold deadline is
 *     withdrawn before anything else can spend the tick, so no lapsed order stays
 *     payable while the expiry catches up (late-payment prevention).
 *  2. `expire-orders` (stock back on sale), then `order-emails` (a customer who
 *     just paid is waiting on the confirmation — one email is about eight calls),
 *     then `hold-intents` (a paid order's stock commit, an expired one's release;
 *     the hold already took the units off sale, so the commit is bookkeeping that
 *     must happen, not stock a shopper can see), then `expire-holds` (stock held
 *     by abandoned carts — the costliest unit, about twenty calls on Free);
 *  3. `late-refunds` — a customer's money, best-effort behind Stripe's own retries
 *     (and leading one tick per interval on Free, see `runCommerceSweeps`);
 *  4. housekeeping: `prune-challenges` and the five scans. `coupon-orphans` stays
 *     after `expire-orders`, though it no longer depends on it finishing;
 *     `product-orphans` is last of all, the leg nothing else waits on.
 *
 * `SWEEP_LEGS` stays the summary's listing order; this is the run order.
 */
export const LEG_PRIORITY: readonly SweepLeg[] = [
	"cancel-intents",
	"expire-orders",
	"order-emails",
	"hold-intents",
	"expire-holds",
	"late-refunds",
	"prune-challenges",
	"sku-transfers",
	"order-sku-index",
	"reporting-heal",
	"coupon-orphans",
	"product-orphans",
];

/**
 * After this many ticks in a row passed over with work (deferred by the budget, or
 * not reached at all), a leg goes to the head of the next tick, right behind
 * `cancel-intents` (QA2 M2's starvation fix). Three: long enough that a one-minute
 * spike does not reorder the tick, short enough that a paid order's stock commit
 * waits minutes, not hours.
 */
export const AGING_TICKS = 3;

/**
 * THE STARVATION GUARD (review of QA2 M2). A leg passed over this many ticks in a
 * row goes ahead of even `cancel-intents`. Some units cannot fit behind an intent
 * cancel on the Workers Free preset at all — a hold expiry with its list (about
 * 20 calls) or a stock-commit completion (about 15), plus a cancel (about 11 with
 * its gateway reads and due check) and the tick's own reads, pass 30 — so while
 * cancels keep coming, ordinary aging (which places a leg right BEHIND
 * `cancel-intents`) would never let them run. Three aging periods: long enough
 * that a burst of cancels finishes first, bounded so nothing waits forever.
 * `cron-leg-costs.test.ts` pins which legs need it.
 */
export const STARVING_TICKS = 3 * AGING_TICKS;

/**
 * QA3 N2 — the calls a provider unit needs AFTER its last pre-check: checked before
 * the provider call (`headroom`), and allowed past the ceiling once the call has
 * happened (`allowCommit`), so an action is never repeated for want of its record.
 *  - An email, from just before the send: the refund-total and recipient reads (two),
 *    building the sender (up to `EMAIL_SENDER_BUILD_READS` kv reads, four, on the
 *    first send), the request (one), and marking it sent (three: the read, the
 *    write, the locator) — ten. `cron-leg-costs.test.ts` measures it with the
 *    REAL sender construction for both providers.
 *  - A withdrawal: the cancel and, when Stripe refuses it, the read-back (two
 *    subrequests), the intent's resolution (two) and, on a last attempt, the
 *    give-up flag (two) — six; its record is the last four.
 * A late-refund resume needs no window: its unit gate already demands room for a
 * whole resume (`LEG_QUERY_COSTS`), and a resume interrupted after the create is
 * re-driven under the SAME idempotency key, which Stripe answers with the refund it
 * already made — no second refund.
 */
const EMAIL_RECORD_CALLS = 3;
export const EMAIL_SEND_AND_RECORD_CALLS = 2 + EMAIL_SENDER_BUILD_READS + 1 + EMAIL_RECORD_CALLS;
const CANCEL_CALL_AND_RECORD_CALLS = 6;
const CANCEL_RECORD_CALLS = 4;

/** The legs with a per-tick batch, and which batch. */
const BATCHED: Partial<Record<SweepLeg, "expiry" | "email" | "intentCancels" | "lateRefunds">> = {
	"expire-holds": "expiry",
	"expire-orders": "expiry",
	"order-emails": "email",
	"cancel-intents": "intentCancels",
	"late-refunds": "lateRefunds",
};

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
 * What a leg keeps back after its units: the cadence-state write, and — for a scan
 * that saves an advancing cursor at the end — that write too. A leg with no trailing
 * write of its own keeping room for one would refuse a unit that fits (on Free, an
 * order expiry behind an intent cancel, by exactly that one call).
 */
export function legReserveQueries(leg: SweepLeg): number {
	return MAINTENANCE_LEGS.includes(leg) ? RESERVE_QUERIES : 1;
}

/** One unit of `leg` with its fixed entry reads, at the bite `queryBudget` gets — what
 *  the leg must have room for to start. */
export function legStartCalls(leg: SweepLeg, queryBudget: number): number {
	const costs = LEG_QUERY_COSTS[leg];
	const entry =
		leg === "expire-holds" ? expireHoldsEntry(batchesFor(queryBudget).expiry) : costs.entry;
	return entry + costs.unit;
}

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
 * A send that times out is NOT a failed attempt (`EmailSendTimeoutError`) on a
 * provider that dedupes retries (Resend's `Idempotency-Key`): the
 * row is handed back uncounted, with a forward backoff (one minute, doubling to
 * fifteen) so it falls behind the other due rows; after ten such timeouts the
 * sweep reports it (`console.error`) and further timeouts count as attempts, so a
 * provider that never answers in time does eventually park the row, with the
 * reason "provider kept timing out". On a provider WITHOUT an idempotency key
 * (SMTP2GO) every timeout is a counted attempt instead (`countTimeoutsAsAttempts`):
 * the provider may have delivered, so duplicates stop at the row's `maxAttempts`.
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
	// Best-effort: Stripe's own webhook redelivery is the first retry; this leg only
	// finishes what that leaves. On the Workers Free preset one unit (~26 calls
	// with its entry) fits only a tick it LEADS, so it leads one tick per
	// maintenance interval when it has work; and the give-up ESCALATION, which
	// makes no provider call, runs on every preset. It is NOT a critical leg:
	// `minimumQueryBudget` ignores it.
	// Its TIME share is the whole tick: it runs last (or leads, once per interval),
	// and its unit minimum — room for a pre-flight, a WHOLE create and the writes
	// after it (`LATE_REFUND_MIN_UNIT_MS`) — is what bounds it.
	"late-refunds": { time: 1, queries: 0.4 },
	// Prevention, best-effort: a small, cheap unit (one ledger read, one Stripe
	// cancel, one write), capped so a Stripe stall costs a fifth of the tick at
	// most. Not critical — a cancel it does not reach is still covered by the
	// late-payment refund — so `minimumQueryBudget` ignores it. On the Workers Free
	// preset under an expiry backlog it waits behind the critical legs.
	"cancel-intents": { time: 0.2, queries: 0.3 },
	// QA2 M2: a leg without a share took everything left, so under a backlog the
	// first housekeeping leg (or the stock-commit completer, behind a crash) spent
	// the rest of every tick and the ones after it waited for aging to rescue them.
	// Capped, the tick's leftovers are spread; the floor still holds one unit each.
	"hold-intents": { time: 0.5, queries: 0.5 },
	"prune-challenges": { time: 0.2, queries: 0.2 },
	"sku-transfers": { time: 0.3, queries: 0.3 },
	"order-sku-index": { time: 0.3, queries: 0.3 },
	// Larger: each attempt at a day owing its first heal re-reads the day's pages
	// before it can absorb anything, so a thin slice is mostly overhead.
	"reporting-heal": { time: 0.6, queries: 0.6 },
	"coupon-orphans": { time: 0.3, queries: 0.3 },
	// A CMS read per row: under a long walk it must not take the tick from the legs
	// a customer waits on. Its leftovers come back to it in the second pass.
	"product-orphans": { time: 0.3, queries: 0.3 },
};

/** The legs a customer waits on: the outbox and the two expiry legs. Each has a
 *  share, and the setting's floor is sized so each can always start. */
export const CRITICAL_LEGS: readonly SweepLeg[] = ["order-emails", "expire-holds", "expire-orders"];

/**
 * What ONE `ctx.content.get` costs, in D1 queries, on either EmDash path: the row
 * read, then — only when there IS a document — whether the collection has SEO
 * enabled and, when it does, the document's SEO row. So a miss is exactly ONE query
 * (trusted `findById` returns before the SEO reads; the sandbox bridge makes one
 * query, full stop) and a hit is at most THREE.
 *
 * The counting context charges it that way: `CONTENT_MISS_QUERIES` before the call
 * (so the ceiling refuses it whole) and the rest after a document comes back. The
 * leg always checks `CONTENT_READ_QUERIES` are left before a read, so the second
 * half always fits. A confirming re-read of a missing row therefore costs one query.
 */
export const CONTENT_READ_QUERIES = 3;
export const CONTENT_MISS_QUERIES = 1;

/**
 * What ONE `ctx.content.list` is charged. EmDash's trusted `findMany` runs the page
 * query AND an unbounded `COUNT(*)` (in parallel — two queries), then, with any
 * item, whether the collection has SEO enabled and the page's SEO rows: four. The
 * sandbox bridge's `contentList` is one query; the worst case is charged.
 */
export const CONTENT_LIST_QUERIES = 4;

/**
 * The calls one orphan's soft delete makes, MEASURED at 4 (`cron-leg-costs.test.ts`):
 * the product document's versioned read and its compare-and-set, then the release
 * of its `sku_owners` claim (a read and a guarded delete). The leg checks this much
 * is left before it starts a delete, so a row it cannot finish stays ahead of the
 * cursor for the next tick; a compare-and-set retry costing more is what the tick's
 * ceiling is for.
 */
export const PRODUCT_ORPHAN_DELETE_CALLS = 4;

/**
 * How old a commerce row must be before `product-orphans` judges it. The row is
 * written by the CMS sync AFTER the CMS commits its document, so on one database a
 * fresh row always has its document — but a read served by a lagging replica, or a
 * sync still in flight, is not a place to be decisive. Fifteen minutes: nothing a
 * merchant notices, and well past any replication lag.
 */
export const PRODUCT_ORPHAN_GRACE_MS = 15 * 60 * 1000;

/**
 * The distance between STRIKES: a strike counts only from a run at least this long
 * after the row's previous strike — one maintenance interval, so the looks are
 * separate runs on separate ticks, never repeated reads of one outage.
 */
export const ORPHAN_CONFIRM_AFTER_MS = 15 * 60 * 1000;

/**
 * Strikes before a tombstone. THREE, each from a separate run a cadence apart, each
 * a QUALIFYING run (one that read some OTHER document successfully, so the CMS was
 * demonstrably answering), each made of `ORPHAN_READS_PER_STRIKE` consecutive misses
 * — and any document found for the row in between wipes them all. Under the failure
 * that motivates this (EmDash's sandbox bridge answering `null` for a D1 error that
 * strikes reads at random with probability p), a live row is tombstoned only by
 * about p^(reads × strikes) = p^9 per window of three passes: for p = 0.3, 2e-5. The
 * seeded simulation in `cron-product-orphans.test.ts` pins the counts.
 */
export const ORPHAN_STRIKES = 3;

/**
 * Reads of a missing row in ONE run before that run counts as a strike: the first
 * read and two immediate re-reads, every one of them `null`. A re-read of a missing
 * row costs one query (`CONTENT_MISS_QUERIES`), so this is cheap exactly where it is
 * needed — and a transient `null` is overwhelmingly likely to be contradicted.
 */
export const ORPHAN_READS_PER_STRIKE = 3;

/**
 * At most this many tombstones per TICK (both passes of the leg), logged when
 * reached: the last line of defence if every other gate were fooled. Five: a lost
 * delete hook is a rare, one-at-a-time event, so a genuine backlog still clears at
 * five a minute (an unfinished scan runs every tick), while a misjudgement costs
 * at most five products a minute — each recoverable by re-creating it — with an
 * error line every minute for a human to read.
 */
export const ORPHAN_TOMBSTONES_PER_TICK = 5;

/**
 * After this many runs IN A ROW whose read of the same product REJECTED, the walk
 * steps past that row (leaving it live, logged every time) rather than stopping on
 * it forever. Three: two failures can be one outage spanning a cadence; a third,
 * thirty minutes on, is that one row.
 */
export const ORPHAN_MAX_READ_FAILURES = 3;

/** The suspect set's bounds: at most this many entries (a missing read beyond it is
 *  not marked this pass — the safe direction), each forgotten if not re-confirmed
 *  within its lifetime: `ORPHAN_SUSPECT_TTL_MS` at least, four full passes when a
 *  pass takes longer (`orphanMarkTtlMs`). 200 entries keep the one kv value near
 *  15 KB. */
export const ORPHAN_MAX_SUSPECTS = 200;
export const ORPHAN_SUSPECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Legs never promoted by aging or the starvation guard (`tickOrder`, `starvingLeg`):
 * work with no deadline must not jump ahead of `cancel-intents` and the money legs.
 * It still runs whenever a tick has room, and its second pass takes the leftovers.
 */
export const UNPROMOTED_LEGS: readonly SweepLeg[] = ["product-orphans"];

/** The most one row's reads can cost: `ORPHAN_READS_PER_STRIKE - 1` misses, then a
 *  document found. */
const ORPHAN_ROW_READ_QUERIES =
	(ORPHAN_READS_PER_STRIKE - 1) * CONTENT_MISS_QUERIES + CONTENT_READ_QUERIES;

/**
 * What a leg's calls cost before its first checked unit (`entry`) and per unit
 * (`unit`), in storage/kv/egress calls. MEASURED — `cron-leg-costs.test.ts` runs
 * one real unit of each leg through the counting context against SQLite and
 * fails if any exceeds its figure here (one order expiry is 13 calls since QA2 M2,
 * 22 before: the guarded flip, the email locator, the rollup delta, the batched
 * hold release and the intent stamp); they matter only until a loop has seen a real unit, after which
 * its gate uses the slowest observed. Without them a leg's first unit — and its
 * unchecked entry reads — would always be admitted, and on Workers Free one
 * `hold-intents` row alone is a third of the budget. `expire-holds` adds two calls
 * per listed candidate to its entry at run time (the cart page plus each cart's
 * reads).
 */
export const LEG_QUERY_COSTS: Record<SweepLeg, { readonly entry: number; readonly unit: number }> =
	{
		// The claim (its page, the read and the write: three), the order read, and then
		// EMAIL_SEND_AND_RECORD_CALLS: the
		// reads before the send, building the real sender (up to four kv reads, the
		// first send), the request, and marking it sent. QA3 saw 13-14 a tick with its due
		// check; 8 counted only an injected sender, and the ceiling then fell after the
		// send — the duplicate emails of N2.
		// entry: resolving the store's email provider once per tick (one kv read for
		// Resend, three for SMTP2GO: `EMAIL_TRANSPORT_RESOLVE_READS`).
		"order-emails": { entry: EMAIL_TRANSPORT_RESOLVE_READS, unit: 4 + EMAIL_SEND_AND_RECORD_CALLS },
		"expire-holds": { entry: 2, unit: 14 },
		// The flip, the email locator, the rollup delta, the batched hold release and
		// the intent stamp: 13 for a one-line order (QA2 M2; it was 22). A bigger order
		// costs more, and the gate learns it from the first unit it sees.
		"expire-orders": { entry: 1, unit: 13 },
		"hold-intents": { entry: 1, unit: 14 },
		// entry: the two arms' first page reads; unit: one delete.
		"prune-challenges": { entry: 2, unit: 1 },
		"sku-transfers": { entry: 2, unit: 12 },
		"order-sku-index": { entry: 2, unit: 3 },
		// unit: one closed day's reads (its currencies, its pin, a page of orders, a
		// page of claims, the commit: about five) and room to absorb at least one claim
		// (two calls) — a day owing its first heal must make PROGRESS when admitted,
		// not spend its whole allowance re-reading pages. The leg bounds a bigger day
		// by the calls it has left (`healReportingRollups`), so it never exceeds them.
		"reporting-heal": { entry: 1, unit: 8 },
		"coupon-orphans": { entry: 2, unit: 7 },
		// entry: the state read, the one page of rows, and the circuit breaker's CMS list
		// (`CONTENT_LIST_QUERIES`). unit: one row's reads at worst — two misses and then a
		// document found (`ORPHAN_ROW_READ_QUERIES`) — then, for a confirmed orphan in a
		// run with no other document found, the canary read, and the soft delete.
		"product-orphans": {
			entry: 2 + CONTENT_LIST_QUERIES,
			unit: ORPHAN_ROW_READ_QUERIES + CONTENT_READ_QUERIES + PRODUCT_ORPHAN_DELETE_CALLS,
		},
		// entry: resolving the gateways (their kv reads: 2 for Stripe, up to 2 more
		// with x402 configured; ADR-0028 increment 2 dropped x402's credential read,
		// and the budget keeps that one as headroom) — once, and only when a unit
		// needs them. The due list is the leg's due check, charged before this (see
		// `run`'s `isDue`).
		// unit: one order's ledger read, the re-driven refund (the two Stripe
		// subrequests, finalize with its reporting write) and the resolve, retry
		// clear and notice that follow — the TRIMMED resume, measured at 20.
		"late-refunds": { entry: 5, unit: 20 },
		// entry: resolving the gateways (their secret kv reads) — once, only when a
		// unit needs them; the due list is the leg's due check, charged before this.
		// unit: one order's ledger read, the Stripe cancel (one subrequest) and the
		// intent's bookkeeping write — 5 — and, at worst, the read-back of an intent
		// Stripe refused to cancel (a second subrequest) and, on the last attempt, the
		// give-up flag on the order: 7, measured with fix/late-charge-window merged.
		"cancel-intents": { entry: 5, unit: 7 },
	};

/** What examining one cart in the hold listing costs, at most: the cart (already in
 *  the page), its reservations' liveness reads, and a heal write for a dead one. */
const LIST_CANDIDATE_CALLS = 3;

/**
 * How many lapsed pending orders the expiry's due check reads at most, listed or
 * left out for a still-payable intent (issue #364). One host page: the check is
 * costed as one query, and a page is one query whatever its size. Behind a longer
 * run of payable orders the rest wait for a later tick; never expired unchecked.
 */
const EXPIRY_SCAN_ORDERS = 100;

/**
 * Orders whose expiry flip threw, waiting before they are tried again (review
 * round 3, B I4), so orders that fail every time cannot take every tick's bite and
 * starve the orders listed behind them. Per process, like the storage guard's heal
 * state; losing it (a restart, a fresh isolate) only means such an order is tried
 * once more sooner. Its cap is sized each tick by {@link expiryBackoffCap}.
 */
const ORDER_EXPIRY_BACKOFF = new UnitBackoff({ maxEntries: expiryBackoffCap(1) });

/**
 * The expiry back-off's cap for a bite of `expiryLimit` (polish P-3): the rows the
 * look's one page ({@link EXPIRY_SCAN_ORDERS}) has left beside the bite and its one
 * extra row — 98 on Free (bite 1), 81 at the Paid bite of 18 — so reading past
 * every waiting order never costs a second page. Never below the default 32 (only a
 * test-only bite of 68 or more gets there, and that look already paged).
 *
 * THE BOUND, stated plainly: the back-off holds starvation back, it does not end
 * it. Orders behind F orders whose flip fails EVERY time are still expired while F
 * is below both this cap and about 60 × the bite (each failing order is retried
 * once an hour at most, so past that the retries alone fill every bite). On Free
 * that is up to 59 such orders (the order behind 59 is reached in about six
 * hours); at the Paid bite, up to 89 measured (the condition is sufficient, not
 * tight; the order behind 90 starves). Past it the rest starve, which before the
 * back-off happened as soon as one bite's worth failed. See `UnitBackoff`.
 */
function expiryBackoffCap(expiryLimit: number): number {
	return Math.max(UnitBackoff.DEFAULT_MAX_ENTRIES, EXPIRY_SCAN_ORDERS - (expiryLimit + 1));
}

/** `expire-holds`' entry reads for a given bite: its fixed reads, plus two per
 *  listed candidate (it lists `batch + 1`). */
function expireHoldsEntry(expiryBatch: number): number {
	const listed = Number.isInteger(expiryBatch) && expiryBatch > 0 ? expiryBatch + 1 : 0;
	return LEG_QUERY_COSTS["expire-holds"].entry + 2 * listed;
}

/**
 * The per-tick bites a query budget can afford, from the MEASURED costs: as many
 * units as the leg's share holds, each with its list read (about two calls per
 * candidate) — between 1 and 50 for the expiry legs, 1 and 25 for the outbox.
 * Sized from the budget rather than left to the per-unit checks because the
 * expiry LIST (`batch + 1` candidates) is read before those checks run.
 *
 * Free (30): 1 hold, 1 order, 1 email a tick (QA2 M2: a bite of 2 holds made the
 * hold leg's list alone 6 calls, and it could not start behind the money legs'
 * due checks — a second unit never fits a Free tick anyway). Paid (600): 18
 * holds/orders, 15 emails — the time budget, not the count, usually ends a Paid
 * tick first.
 */
export function batchesFor(queryBudget: number): {
	expiry: number;
	email: number;
	lateRefunds: number;
	intentCancels: number;
} {
	const holds = LEG_QUERY_COSTS["expire-holds"].unit + 2;
	const emails = LEG_QUERY_COSTS["order-emails"].unit;
	const holdShare = LEG_SHARES["expire-holds"]?.queries ?? 1;
	const emailShare = LEG_SHARES["order-emails"]?.queries ?? 1;
	return {
		expiry: clampInt((queryBudget * holdShare) / holds, 1, 50),
		email: clampInt((queryBudget * emailShare) / emails, 1, 25),
		// Best-effort Stripe round trips: at most a handful a minute even on Paid.
		lateRefunds: clampInt(
			(queryBudget * (LEG_SHARES["late-refunds"]?.queries ?? 1)) /
				LEG_QUERY_COSTS["late-refunds"].unit,
			1,
			5,
		),
		intentCancels: clampInt(
			(queryBudget * (LEG_SHARES["cancel-intents"]?.queries ?? 1)) /
				LEG_QUERY_COSTS["cancel-intents"].unit,
			1,
			10,
		),
	};
}

function clampInt(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** The Stripe cancel's bound — fixed, never clipped: a cancel is started only with
 *  at least this much left, so its timeout is always the provider's. */
const INTENT_CANCEL_CALL_MS = 1_500;

/** One late-refund ESCALATION (give-up, no provider call), MEASURED. */
export const LATE_REFUND_ESCALATION_UNIT = 8;

/** The refund CREATE's fixed bound. A create that times out is AMBIGUOUS (it may
 *  have reached Stripe) and lands as "verify in Stripe", so it is never handed a
 *  sliver of time: it gets all of this, or it is not started. */
export const LATE_REFUND_CREATE_MS = 2_500;
/** Room for the storage writes after a create (finalize, resolve, notice). */
const LATE_REFUND_STORAGE_MS = 500;
/** Room for the refund pre-flight read (clippable: a timed-out READ is retryable). */
const LATE_REFUND_PREFLIGHT_MS = 500;
/** The least time left at which a late-refund unit is ADMITTED. */
const LATE_REFUND_MIN_UNIT_MS =
	LATE_REFUND_PREFLIGHT_MS + LATE_REFUND_CREATE_MS + LATE_REFUND_STORAGE_MS;

/**
 * The Stripe options the `late-refunds` leg builds its gateway with, given the leg's
 * budget. Exported for its test.
 *  - the pre-flight READ is bounded by what the leg has left (a timed-out read
 *    issued nothing, so clipping it is safe);
 *  - the CREATE gets the fixed {@link LATE_REFUND_CREATE_MS};
 *  - and is started only while a whole create plus the writes after it still fit
 *    — otherwise the gateway answers RETRYABLE having issued nothing, the row
 *    stays `reserved`, and the domain reschedules it.
 */
export function lateRefundStripeOptions(legBudget: RefundTimeBudget): BoundedRefundStripeOptions {
	// The rule lives in ONE helper, shared with the settle webhook's refund.
	return boundedRefundStripeOptions(legBudget, {
		createMs: LATE_REFUND_CREATE_MS,
		storageMs: LATE_REFUND_STORAGE_MS,
	});
}

/** Calls every tick makes before any leg: the setting read and the cadence-state
 *  read. */
export const TICK_OVERHEAD_QUERIES = 2;

/** What an IDLE tick spends, MEASURED (DEPLOYMENT.md §5: "an idle tick is 8
 *  queries"): the setting and cadence-state reads plus one "anything due?" read for
 *  each every-minute leg. A budget that cannot hold this plus one late-refund unit
 *  is one where that leg can never run behind the others — so there, and only
 *  there, it leads. */
const IDLE_TICK_QUERIES = 8;

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
	/** The storage, kv and egress calls this leg made this tick, its due check
	 *  included (QA2 M2: a tick's spend is visible by leg). */
	readonly queries: number;
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
		/** Calls made outside every leg: the setting read and the cadence state. */
		readonly overheadQueries: number;
	};
}

export interface CommerceSweepOptions {
	/**
	 * The outbox's sender — an OVERRIDE since INC-C5, not the only source. Left
	 * unset, the tick builds the in-process `CtxHttpEmailSender` from the context
	 * and this bundle's email API URL; a suite sets it to pin the outbox against a
	 * fake without any egress. Neither one existing (no injection, no configured
	 * provider) makes the `order-emails` leg report `skipped` whenever an email is
	 * due, rather than pretend to drain an outbox — a silent no-op here would look
	 * exactly like an empty one.
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
	 *  scaled from the query budget (`batchesFor`) — 1 on the Free preset, 18 on Paid. */
	readonly expiryBatchLimit?: number;
	/** Where failed order expiries back off. Default: one per process. Tests pass
	 *  their own. The leg sizes its cap each tick (`expiryBackoffCap`). */
	readonly expiryBackoff?: UnitBackoff;
	/** Most outbox rows the email leg claims per tick. Default: scaled from the
	 *  query budget — 10 on the Free preset, 25 on Paid. */
	readonly emailBatchLimit?: number;
	/**
	 * Builds the outbox's sender, given the per-send timeout to apply at each send.
	 * Default: the in-process `CtxHttpEmailSender` over `ctx.http`, when this bundle
	 * carries an email API URL. A suite injects one to model a slow provider that
	 * honours the abort. Ignored when `emailSender` is set.
	 */
	/**
	 * The payment gateways a provider-facing leg uses — an OVERRIDE, either a map
	 * or a thunk producing one. Left unset, the leg resolves the deployment's own
	 * (`resolvePaymentGateways`) from the COUNTED context — so the secret reads and
	 * the Stripe subrequests count against the tick's query budget — once, lazily,
	 * only when it has found work, with every Stripe call bounded by what the leg
	 * has left. A suite injects fakes to pin the provider calls offline.
	 */
	readonly gateways?: PaymentGateways | (() => PaymentGateways | Promise<PaymentGateways>);
	/** Most orders the `late-refunds` leg resumes per tick. Default: scaled from
	 *  the query budget (`batchesFor`) — 1 to 5. */
	readonly lateRefundBatch?: number;
	/** Most orders the `cancel-intents` leg examines per tick. Default: scaled from
	 *  the query budget (`batchesFor`) — 1 to 10. */
	readonly intentCancelBatch?: number;
	/**
	 * @internal TEST-ONLY — not part of the plugin's public surface; may change or go
	 * without notice. Replace a leg's body with one that is handed the tick's COUNTED
	 * context. Used to pin the runner's own rules (a refusal the body swallowed still
	 * marks the leg incomplete) without staging a store that happens to misbehave.
	 * Never set by the plugin.
	 */
	readonly legBodies?: Partial<Record<SweepLeg, (ctx: PluginContext) => Promise<number>>>;
	readonly emailSenderFactory?: (
		requestTimeoutMs: () => number,
		/** The tick's COUNTED context — what the real sender builds from, so a suite
		 *  can model its kv reads and its request as the budget sees them. */
		ctx: PluginContext,
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
const PRODUCT_ORPHAN_CURSOR = "product-orphans";
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
 * a broken sweep is visible without taking the others down with it. It DOES
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
	const lateRefundLimit = options.lateRefundBatch ?? batches.lateRefunds;
	const intentCancelLimit = options.intentCancelBatch ?? batches.intentCancels;
	const batchLimits = {
		expiry: expiryLimit,
		email: emailLimit,
		intentCancels: intentCancelLimit,
		lateRefunds: lateRefundLimit,
	};
	const state = await readState(cursors);
	let stateChanged = false;
	const legs: Omit<SweepLegOutcome, "queries">[] = [];
	const deferredByBudget: SweepLeg[] = [];
	const stoppedAtCeiling: SweepLeg[] = [];
	/** Legs that ran (or found nothing) this tick, and legs that waited. */
	const reached = new Set<SweepLeg>();
	const waited = new Set<SweepLeg>();

	const noteDeferral = (leg: SweepLeg): void => {
		waited.add(leg);
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
	const clearDeferral = (leg: SweepLeg): void => {
		reached.add(leg);
		if ((state.deferrals[leg] ?? 0) > 0) {
			delete state.deferrals[leg];
			stateChanged = true;
		}
	};

	/** Set for the work-conserving second pass (see below): a leg runs again on
	 *  what the tick has left, with no share cap, and its outcome is merged. */
	let secondPass = false;
	/** Legs the BUDGET stopped (their share, not their batch) — the second pass's
	 *  candidates — and the units each batched leg has done, so a second go never
	 *  passes the per-tick batch. */
	const stoppedByBudget = new Set<SweepLeg>();
	const unitsDone: Partial<Record<SweepLeg, number>> = {};
	const batchLeft = (leg: SweepLeg, limit: number): number =>
		// A malformed limit passes through untouched, so the use-case refuses it loudly.
		Number.isInteger(limit) && limit > 0 ? Math.max(0, limit - (unitsDone[leg] ?? 0)) : limit;
	const noteUnits = (leg: SweepLeg, count: number, legBudget: LegBudget): void => {
		unitsDone[leg] = (unitsDone[leg] ?? 0) + count;
		if (legBudget.stopped) stoppedByBudget.add(leg);
	};
	const record = (outcome: Omit<SweepLegOutcome, "queries">): void => {
		const earlier = legs.findIndex((entry) => entry.leg === outcome.leg);
		if (earlier === -1) {
			legs.push(outcome);
			return;
		}
		const first = legs[earlier]!;
		// A second go the budget could not start leaves the first outcome as it was.
		if (outcome.deferred === true) return;
		legs[earlier] = {
			...first,
			...outcome,
			count: first.count + outcome.count,
			...(first.anomalies !== undefined || outcome.anomalies !== undefined
				? { anomalies: [...(first.anomalies ?? []), ...(outcome.anomalies ?? [])] }
				: {}),
		};
		if (outcome.incomplete !== true) delete (legs[earlier] as { incomplete?: true }).incomplete;
	};

	const run = async (
		leg: SweepLeg,
		realBody: (budget: LegBudget) => Promise<Omit<SweepLegOutcome, "leg" | "ok" | "queries">>,
		hooks: LegHooks = {},
	): Promise<void> => {
		const replaced = options.legBodies?.[leg];
		const body: typeof realBody =
			replaced === undefined ? realBody : async () => ({ count: await replaced(ctx) });
		if (secondPass) {
			await runAgain(leg, body, hooks);
			return;
		}
		const maintenance = MAINTENANCE_LEGS.includes(leg);
		// A malformed per-tick batch fails its leg LOUDLY on every tick, before any due
		// check — never an idle-looking leg that quietly sweeps nothing forever.
		const batch = BATCHED[leg];
		if (batch !== undefined) {
			try {
				assertSweepLimit(batchLimits[batch]);
			} catch (err) {
				record(failedOutcome(leg, err));
				reached.add(leg);
				console.error(`[otta] cron sweep ${leg} FAILED:`, err);
				return;
			}
		}
		if (maintenance && !isDue(state.lastRun[leg], now)) {
			// Quiet on purpose: four "not due" lines a minute would bury the lines
			// that matter. The summary still lists the leg.
			record({ leg, ok: true, count: 0, notDue: true });
			reached.add(leg);
			return;
		}
		// A leg with a cheap "is there any work?" check (one query) asks it first. Idle,
		// it is not "deferred" — there was nothing to defer — so no line, no warning and
		// no state write; only a leg with work due can be deferred.
		// A leg the budget deferred LAST tick with work known is not asked again: its
		// due check would cost a query a tick for an answer already in hand, and under
		// a backlog those reads were a sixth of a Free tick. It goes straight to its
		// budget check; if it runs and the work has gone, it simply finds nothing.
		const knownDue = (state.deferrals[leg] ?? 0) > 0 && hooks.cheapDueCheck !== true;
		if (hooks.isDue !== undefined && !knownDue) {
			if (!budget.leg(WHOLE_TICK).canStart(1, 0)) {
				// Not even room to ask. The summary says "not reached" (`deferred`), but
				// quietly — no line, no streak — since nothing says there is work. It still
				// WAITED, which is what ages it to the head of a later tick.
				record({ leg, ok: true, count: hooks.extraCount?.() ?? 0, deferred: true });
				waited.add(leg);
				return;
			}
			let due: boolean;
			try {
				due = await budget.charge(leg, hooks.isDue);
			} catch (err) {
				record(failedOutcome(leg, err));
				reached.add(leg);
				return;
			}
			if (!due) {
				record({ leg, ok: true, count: hooks.extraCount?.() ?? 0 });
				clearDeferral(leg);
				return;
			}
		}
		const costs = LEG_QUERY_COSTS[leg];
		// A malformed limit adds nothing here, so the leg STARTS and its use-case
		// refuses the limit loudly — rather than a NaN quietly deferring it forever.
		const entry = leg === "expire-holds" ? expireHoldsEntry(expiryLimit) : costs.entry;
		// A share never shrinks a leg below ONE unit of its own work: on the Free
		// preset one order expiry is most of a share, and a share smaller than that
		// would refuse the leg on every tick, silently, forever.
		const legBudget = budget.leg(
			LEG_SHARES[leg] ?? WHOLE_TICK,
			entry + costs.unit,
			legReserveQueries(leg),
		);
		if (!legBudget.canStart(entry, costs.unit)) {
			record({ leg, ok: true, count: hooks.extraCount?.() ?? 0, deferred: true });
			deferredByBudget.push(leg);
			noteDeferral(leg);
			return;
		}
		// Units a body finished before a refusal it swallowed — still reported.
		let doneBeforeRefusal = 0;
		try {
			const result = await budget.charge(leg, () => body(legBudget));
			if (budget.wasRefused(leg)) {
				doneBeforeRefusal = result.count;
				throw new SweepQueryCeilingError(budget.ceiling(), leg);
			}
			const outcome = {
				leg,
				ok: true,
				...result,
				count: result.count + (hooks.extraCount?.() ?? 0),
			};
			record(outcome);
			if (outcome.deferred === true) {
				// Deferred by its own body, which logged why.
				noteDeferral(leg);
				return;
			}
			clearDeferral(leg);
			logOutcome(outcome);
			// A scan cut short is NOT stamped: it resumes on the very next tick, from
			// its cursor, rather than waiting out another interval.
			if (maintenance && outcome.incomplete !== true) {
				state.lastRun[leg] = nowIso;
				stateChanged = true;
			}
		} catch (err) {
			if (isSweepQueryCeilingError(err)) {
				// The backstop fired: this leg's unit cost more than its estimate. Not a
				// failure — the call was refused before it was made, every write before it
				// was a guarded unit — and the leg resumes next tick. Loud, because an
				// estimate that is too low is a bug in LEG_QUERY_COSTS.
				record({
					leg,
					ok: true,
					count: doneBeforeRefusal + (hooks.extraCount?.() ?? 0),
					incomplete: true,
				});
				stoppedAtCeiling.push(leg);
				clearDeferral(leg);
				console.warn(
					`[otta] cron sweep ${leg} stopped at the tick's query ceiling (${String(err.ceiling)})` +
						" part-way through a unit; it resumes next tick",
				);
				return;
			}
			// One label, one catch — a leg that throws must not starve the rest.
			record(failedOutcome(leg, err));
			reached.add(leg);
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

	/** The second pass's run: no due check (the first pass found work), the whole
	 *  of what is left as the cap, no deferral bookkeeping. */
	const runAgain = async (
		leg: SweepLeg,
		body: (budget: LegBudget) => Promise<Omit<SweepLegOutcome, "leg" | "ok" | "queries">>,
		hooks: LegHooks,
	): Promise<void> => {
		const costs = LEG_QUERY_COSTS[leg];
		const entry = leg === "expire-holds" ? expireHoldsEntry(expiryLimit) : costs.entry;
		const legBudget = budget.leg(WHOLE_TICK, entry + costs.unit, legReserveQueries(leg));
		if (!legBudget.canStart(entry, costs.unit)) return;
		try {
			const result = await budget.charge(leg, () => body(legBudget));
			if (budget.wasRefused(leg)) throw new SweepQueryCeilingError(budget.ceiling(), leg);
			const outcome = { leg, ok: true, ...result, count: result.count };
			record(outcome);
			logOutcome(outcome);
			if (MAINTENANCE_LEGS.includes(leg) && outcome.incomplete !== true) {
				state.lastRun[leg] = nowIso;
				stateChanged = true;
			}
		} catch (err) {
			if (isSweepQueryCeilingError(err)) {
				stoppedAtCeiling.push(leg);
				console.warn(
					`[otta] cron sweep ${leg} stopped at the tick's query ceiling (${String(err.ceiling)})` +
						" part-way through a unit; it resumes next tick",
				);
				return;
			}
			record({ ...failedOutcome(leg, err), count: hooks.extraCount?.() ?? 0 });
			console.error(`[otta] cron sweep ${leg} FAILED:`, err);
		}
	};

	// ── the legs ──────────────────────────────────────────────────────────────

	// An injected sender (a suite) needs no provider. Otherwise the store's email
	// provider is resolved INSIDE the leg's body — after its due check and its
	// budget gate, under its charge — at most ONCE per tick (the second pass reuses
	// it), and handed to the sender build so it is not read again. Its reads are the
	// leg's `entry` cost in `LEG_QUERY_COSTS`, which `canStart` keeps room for, so a
	// busy tick DEFERS the leg (and it ages) rather than reaching a read the ceiling
	// refuses. (Review of #383: resolved before the gate, a refused read was
	// swallowed by the fail-soft readers into "no provider" — `skipped`, which
	// cleared the leg's wait on every busy tick, so order emails could starve.)
	// Should a read be refused anyway, `run` sees `wasRefused` and reports the
	// ceiling stop, never `skipped`. An idle outbox pays only the due check.
	// Unresolvable (no URL for Resend, no SMTP2GO key, a failed or unknown provider
	// read) ⇒ `skipped`: nothing is claimed, so no attempt is spent.
	const injectedSender =
		options.emailSender !== undefined || options.emailSenderFactory !== undefined;
	let transportP: Promise<EmailTransport | undefined> | undefined;
	const orderEmailsLeg = async (): Promise<void> => {
		await run(
			"order-emails",
			async (legBudget) => {
				let transport: EmailTransport | undefined;
				if (!injectedSender) {
					transportP ??= resolveEmailTransport(ctx, {
						apiUrl: IN_PROCESS_EGRESS_URLS.emailApiUrl,
					});
					transport = await transportP;
					if (transport === undefined) return { count: 0, skipped: true };
				}
				const outbox = outboxSender(ctx, options, legBudget, transport);
				if (outbox === undefined) return { count: 0, skipped: true };
				// No idempotency key (SMTP2GO): a timeout — the sender's or the sweep's
				// own timer — is a COUNTED attempt, so a slow but accepting provider is
				// not re-sent the same email on every tick. Outermost, over the timer.
				const provider =
					transport !== undefined && !providerDedupesRetries(transport.provider)
						? countTimeoutsAsAttempts(outbox)
						: outbox;
				// A delivered email is RECORDED, whatever the ceiling says (QA3 N2).
				const emailSender: EmailSender = {
					async send(input) {
						await provider.send(input);
						budget.allowCommit(EMAIL_RECORD_CALLS);
					},
				};
				const batchLimit = batchLeft("order-emails", emailLimit);
				if (batchLimit === 0) return { count: 0 };
				assertSweepLimit(batchLimit);
				// Checked before each CLAIM, so a stop never strands a leased row; and only
				// when a send could still finish inside the leg (`MIN_SEND_MS` at least).
				const gate = legBudget.gate(MIN_SEND_MS, LEG_QUERY_COSTS["order-emails"].unit);
				// Counted from the store's own answer, so "more left" means a row was
				// actually claimed — an empty outbox is never "0 (more next tick)".
				let claimed = 0;
				const orderStore = countClaims(stores.orderStore, () => {
					claimed++;
				});
				const count = await dispatchOrderEmails(
					{
						orderStore,
						emailSender,
						customerStore: stores.customerStore,
						clock: stores.clock,
					},
					{
						batchLimit,
						shouldContinue: () => {
							budget.endCommit();
							return gate();
						},
						// Asked again just before the send: the claim and the order/customer
						// reads take time of their own. Too little left — time, or calls for
						// the rest of the unit INCLUDING marking it sent (QA3 N2: never send
						// what cannot be recorded) — and the row goes back untried, its
						// attempt not counted.
						canSend: () => {
							const ok =
								legBudget.remainingMs() >= MIN_SEND_MS &&
								budget.headroom() >= EMAIL_SEND_AND_RECORD_CALLS;
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
				noteUnits("order-emails", claimed, legBudget);
				// "More left": the budget stopped it with a claim still to try, or every
				// claim the batch allowed found a row. The second can also mean the outbox
				// emptied on exactly the last claim — reported `incomplete` then, harmlessly,
				// since the next tick finds nothing.
				return legResult(count, legBudget.stopped || claimed >= batchLimit);
			},
			{
				// One indexed read: is any outbox row due? The claim re-applies the same
				// predicate, so a "yes" here that a peer drains first costs one claim query.
				isDue: async () =>
					(
						await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).query({
							where: { emailDueAt: { lte: nowIso } },
							limit: 1,
						})
					).items.length > 0,
			},
		);
	};

	const expireHoldsLeg = async (): Promise<void> =>
		await run(
			"expire-holds",
			async (legBudget) => {
				// The parity gap, closed: ONE settings read per tick drives the TTL that
				// both the cart hold and this sweep are measured against.
				const limit = batchLeft("expire-holds", expiryLimit);
				if (limit === 0) return { count: 0 };
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
							limit,
							shouldContinue: legBudget.gate(0, LEG_QUERY_COSTS["expire-holds"].unit),
							// The candidate list's own bound: each cart it examines costs a call
							// or three, and a run of carts that yield nothing must not be read in
							// full. Its own gate, so list rows are not mistaken for flips. Sized
							// to the candidate, not to a candidate AND a flip (QA2 M2): on the Free
							// preset that left room to examine one cart a tick, so a run of dead
							// carts ahead of a live hold took a tick each. A dead cart the list
							// examines is HEALED out of the index — progress, not waste — and a
							// live hold it finds with no room left to flip is flipped next tick,
							// when it is the first candidate.
							shouldContinueListing: legBudget.gate(0, LIST_CANDIDATE_CALLS),
						},
					),
					(count) => noteUnits("expire-holds", count, legBudget),
					// A list the budget cut short reads as "drained" to the use-case (it got
					// a short list); it is not — more carts may be lapsed behind it.
					legBudget.stopped,
				);
			},
			{
				// One indexed read: does any cart's derived hold deadline say "lapsed"? The
				// listing then decides which holds really can be expired (and heals a dead
				// cart's index so it stops matching).
				isDue: async () =>
					(
						await collectionOf(storage, CARTS_COLLECTION).query({
							where: { holdExpiresAt: { lte: nowIso } },
							limit: 1,
						})
					).items.length > 0,
			},
		);

	// The due check IS the leg's list, read once and handed to the domain: the lapsed
	// pending orders, oldest deadline first, LESS every order whose payment intent is
	// due for withdrawal and not yet withdrawn (QA3 N1 — the port's `excludeIntentDue`).
	// An order is never expired while the buyer could still pay it: `cancel-intents`
	// (first in every tick) withdraws the intent, and the expiry takes the order on
	// the same tick or a later one. `expiryLimit + 1`, so a longer backlog still reads
	// as not drained.
	//
	// The look is BOUNDED (issue #364): at most `EXPIRY_SCAN_ORDERS` lapsed orders are
	// read, listed or left out. Under a backlog of abandoned checkouts whose intents
	// are still due, filling the bite used to walk the whole backlog a small page at
	// a time — a dozen queries for 150 orders, charged to a check costed as one. An
	// order the look did not reach is not listed, so it is never expired unchecked;
	// it is read on a later tick, once `cancel-intents` has withdrawn the ones ahead.
	//
	// Orders still backing off after a failed flip (review round 3, B I4) are read
	// past: the look lists that many more and leaves them out, in the same query.
	const expiryBackoff = options.expiryBackoff ?? ORDER_EXPIRY_BACKOFF;
	let expirable: Promise<readonly OrderId[]> | undefined;
	const expirableIds = (): Promise<readonly OrderId[]> =>
		(expirable ??= (async () => {
			expiryBackoff.setMaxEntries(expiryBackoffCap(expiryLimit));
			const waiting = expiryBackoff.waiting(now.getTime());
			const listed = await stores.orderStore.listExpirable(nowIso, {
				limit: expiryLimit + 1 + waiting.size,
				excludeIntentDue: true,
				scanLimit: Math.max(expiryLimit + 1 + waiting.size, EXPIRY_SCAN_ORDERS),
			});
			return waiting.size === 0 ? listed : listed.filter((id) => !waiting.has(id));
		})());
	const expireOrdersLeg = async (): Promise<void> =>
		await run(
			"expire-orders",
			async (legBudget) => {
				const limit = batchLeft("expire-orders", expiryLimit);
				if (limit === 0) return { count: 0 };
				return batchOutcome(
					await expireOrdersBatch(
						{
							orderStore: stores.orderStore,
							inventoryStore: stores.inventory,
							couponStore: stores.couponStore,
							clock: stores.clock,
						},
						now,
						{
							limit,
							shouldContinue: legBudget.gate(0, LEG_QUERY_COSTS["expire-orders"].unit),
							due: await expirableIds(),
							backoff: expiryBackoff,
							// The tick's query ceiling ends the leg; it is not one order failing.
							stopsBatch: isSweepQueryCeilingError,
						},
					),
					(count) => noteUnits("expire-orders", count, legBudget),
				);
			},
			{ isDue: async () => (await expirableIds()).length > 0, cheapDueCheck: true },
		);

	// ── late-refunds: best-effort — except where a resume unit cannot fit behind the
	// money legs at all (the Workers Free preset: one unit, ~26 calls with its entry,
	// needs a tick nothing else has spent yet). There it LEADS (right after the
	// intent-cancel drain) one tick per maintenance interval when it has work, capped
	// at ONE unit, which is what lets a Free store make progress at all. On Paid it
	// never leads.
	// The due check IS the resume step's list (`lateRefundLimit` orders), read once
	// per tick and handed to the domain, so the leg never pays for its list twice.
	let lateRefundsDue: Promise<readonly OrderId[]> | undefined;
	const lateRefundsDueIds = (): Promise<readonly OrderId[]> =>
		(lateRefundsDue ??= stores.orderStore.listRefundRetriesDue(nowIso, lateRefundLimit));
	const lateRefundsAreDue = async (): Promise<boolean> => (await lateRefundsDueIds()).length > 0;
	let lateRefundsRan = false;
	let lateRefundsEscalated = 0;
	const lateRefundsLeg = async (leading = false): Promise<void> => {
		if (lateRefundsRan) return;
		lateRefundsRan = true;
		if (leading) {
			// Stamped when the lead is TRIED: one attempt per interval, admitted or not,
			// so a lead the tick cannot fit does not keep the money legs waiting.
			state.lastRun["late-refunds"] = nowIso;
			stateChanged = true;
		}
		const limit = leading ? 1 : lateRefundLimit;
		await run(
			"late-refunds",
			async (legBudget) => {
				// Resume late-payment refunds a transient provider failure left `reserved`
				// (`retryLatePaymentRefunds`), one gated UNIT per refund. A unit is admitted
				// only with room for a pre-flight, a WHOLE create and the writes after it;
				// the gateway is resolved from the COUNTED context, once, and only when a
				// unit needs it (see `lateRefundStripeOptions`). The domain re-drives the
				// SAME key, so a resume can never be a second refund.
				assertSweepLimit(limit);

				const gate = legBudget.gate(LATE_REFUND_MIN_UNIT_MS, LEG_QUERY_COSTS["late-refunds"].unit);
				const count = await retryLatePaymentRefunds(
					{
						orderStore: stores.orderStore,
						paymentEventStore: stores.paymentEventStore,
						clock: { now: () => now },
						gateways: sweepGateways(ctx, options, lateRefundStripeOptions(legBudget)),
					},
					{ limit, shouldContinue: () => gate(), due: await lateRefundsDueIds() },
				);
				return legResult(count, legBudget.stopped || count >= limit);
			},
			{ isDue: lateRefundsAreDue, extraCount: () => lateRefundsEscalated, cheapDueCheck: true },
		);
	};
	// IDLE_TICK_QUERIES was measured with every every-minute leg's due check; a
	// budget that cannot hold that plus one late-refund unit is one where that leg
	// can never run behind the others — so there, and only there, it leads.
	const lateRefundsMustLead =
		queryBudget <
		IDLE_TICK_QUERIES +
			1 +
			LEG_QUERY_COSTS["late-refunds"].entry +
			LEG_QUERY_COSTS["late-refunds"].unit +
			RESERVE_QUERIES;

	// The due check IS the leg's list, read once and handed to the domain.
	let intentCancelsDue: Promise<readonly OrderId[]> | undefined;
	const intentCancelsDueIds = (): Promise<readonly OrderId[]> =>
		(intentCancelsDue ??= stores.orderStore.listIntentCancelsDue(nowIso, intentCancelLimit));
	const cancelIntentsLeg = async (): Promise<void> =>
		await run(
			"cancel-intents",
			async (legBudget) => {
				// Late-payment PREVENTION, in its own leg — never inside `expire-orders`, so
				// a provider call is never made inside the expiry. The expiry still WAITS on
				// this leg for any order whose intent is due (QA3 N1), and since issue #364
				// its look is bounded (`EXPIRY_SCAN_ORDERS`): an order with no due intent
				// queued behind that many payable ones waits for this leg's throughput, so
				// provider latency can delay its stock release by a tick or more — and FIRST
				// in every tick: an intent due at its order's hold deadline is withdrawn
				// before the expiry (or anything else) can spend the tick, so a backlog of
				// lapsed orders never leaves one payable. Each unit admitted by the tick's
				// gate with room for one WHOLE cancel, the gateways resolved once (from the
				// counted context) and only when a unit needs them. A cancel is never
				// started with less than `INTENT_CANCEL_CALL_MS` left and is never clipped
				// below it — so a timeout is always the provider's, and the tick running out
				// costs no attempt. A transient failure is rescheduled by the domain and
				// retried by this leg on a later tick — nothing else retries it.
				const limit = batchLeft("cancel-intents", intentCancelLimit);
				if (limit === 0) return { count: 0 };
				assertSweepLimit(limit);
				const gate = legBudget.gate(INTENT_CANCEL_CALL_MS, LEG_QUERY_COSTS["cancel-intents"].unit);
				const count = await cancelDueIntents(
					{
						orderStore: stores.orderStore,
						clock: { now: () => now },
						// A withdrawal is RECORDED, whatever the ceiling says (QA3 N2).
						gateways: recordingCancels(
							sweepGateways(ctx, options, { requestTimeoutMs: INTENT_CANCEL_CALL_MS }),
							() => budget.allowCommit(CANCEL_RECORD_CALLS),
						),
					},
					{
						limit,
						shouldContinue: () => gate(),
						due: await intentCancelsDueIds(),
						canStartCancel: () => {
							budget.endCommit();
							// Time for a whole cancel, and calls for it AND its record.
							const ok =
								legBudget.remainingMs() >= INTENT_CANCEL_CALL_MS &&
								budget.headroom() >= CANCEL_CALL_AND_RECORD_CALLS;
							if (!ok) legBudget.stopped = true;
							return ok;
						},
					},
				);
				noteUnits("cancel-intents", count, legBudget);
				return legResult(count, legBudget.stopped || count >= limit);
			},
			{ isDue: async () => (await intentCancelsDueIds()).length > 0, cheapDueCheck: true },
		);

	const holdIntentsLeg = async (): Promise<void> =>
		await run(
			"hold-intents",
			async (legBudget) => await completeHoldIntents(storage, stores, nowIso, options, legBudget),
			{
				// One indexed read: does any order owe hold work? (`holdsPendingAt` goes
				// null as the work completes, so this narrows by itself.)
				isDue: async () =>
					(
						await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).query({
							where: { holdsPendingAt: { lte: nowIso } },
							limit: 1,
						})
					).items.length > 0,
			},
		);

	/** `product-orphans`' tombstones this tick, across both passes (the cap's count). */
	const orphanTombstones = { count: 0 };
	const runners: Record<SweepLeg, () => Promise<void>> = {
		"cancel-intents": cancelIntentsLeg,
		"expire-orders": expireOrdersLeg,
		"hold-intents": holdIntentsLeg,
		"expire-holds": expireHoldsLeg,
		"order-emails": orderEmailsLeg,
		"late-refunds": () => lateRefundsLeg(),
		"prune-challenges": async () =>
			await run("prune-challenges", async (legBudget) => {
				// Bounded: the prune deletes one row per call, and a pile of expired
				// sign-in challenges must not spend a whole tick (QA2 M2) — a check before
				// each delete, the rest next tick.
				const gate = legBudget.gate(0, 1);
				const count = await stores.credentialVerifier.pruneChallenges(nowIso, {
					shouldContinue: () => gate(),
				});
				return legResult(count, legBudget.stopped);
			}),
		"sku-transfers": async () =>
			await run(
				"sku-transfers",
				async (legBudget) => await sweepSkuTransfers(storage, stores, cursors, options, legBudget),
			),
		"order-sku-index": async () =>
			await run(
				"order-sku-index",
				async (legBudget) =>
					await healOrderSkuIndex(storage, stores, now, cursors, options, legBudget),
			),
		"reporting-heal": async () =>
			await run(
				"reporting-heal",
				async (legBudget) =>
					await healReportingRollups(
						storage,
						stores,
						now,
						cursors,
						options,
						legBudget,
						queryBudget,
					),
			),
		"coupon-orphans": async () =>
			await run(
				"coupon-orphans",
				async (legBudget) =>
					await releaseOrphanedRedemptions(storage, stores, now, cursors, options, legBudget),
			),
		"product-orphans": async () => {
			// The host hands `ctx.content` over only under `content:read`, and the
			// workerd mirror's production entry has no CMS at all. Without it there is
			// nothing to judge a row against — and a row must never be judged gone for
			// want of a reader — so the leg says it is not wired, BEFORE any budget
			// check (it costs nothing, so it is never "deferred"), and is stamped like
			// any scan so it reads `notDue` until its next cadence.
			const content = ctx.content;
			if (content === undefined) {
				if (secondPass) return;
				if (!isDue(state.lastRun["product-orphans"], now)) {
					record({ leg: "product-orphans", ok: true, count: 0, notDue: true });
				} else {
					const outcome = { leg: "product-orphans" as const, ok: true, count: 0, skipped: true };
					record(outcome);
					logOutcome(outcome);
					state.lastRun["product-orphans"] = nowIso;
					stateChanged = true;
				}
				reached.add("product-orphans");
				return;
			}
			await run("product-orphans", async (legBudget) => {
				const result = await softDeleteOrphanedProducts(
					storage,
					stores,
					content,
					now,
					cursors,
					options,
					legBudget,
					// The tombstone cap is per TICK: the second pass shares this counter.
					orphanTombstones,
				);
				// Stopped by its share with rows left: a candidate for the second pass,
				// which hands it whatever the tick has left once every leg has had a turn.
				if (legBudget.stopped) stoppedByBudget.add("product-orphans");
				return result;
			});
		},
	};

	// ── the order ─────────────────────────────────────────────────────────────
	//
	// `cancel-intents` first (late-payment prevention: an intent due at its order's
	// deadline is withdrawn before anything else can spend the tick) — except in the
	// one tick per interval a Free store's late-refund resume leads (below). Then any
	// leg that has WAITED `AGING_TICKS` ticks in a row with work — longest wait first —
	// so no leg is starved however busy the others are. Then the rest in
	// `LEG_PRIORITY`: the money legs ahead of the customer-facing outbox, and both
	// ahead of housekeeping.
	// When late-refund work is due, the head of the tick does ONE of two things:
	//  - where a unit cannot fit behind the others (the Workers Free preset), once
	//    per maintenance interval, the leg LEADS with one unit — AHEAD of even
	//    `cancel-intents`: a resume is about 25 calls and needs a tick nothing else
	//    has touched, and the money it returns has already been taken. That tick's
	//    intent cancels and expiries wait one minute together, so no order expires
	//    with its intent still live. (Its resume step gives a refund past the ~3-day
	//    limit up itself, without a provider call.)
	//  - otherwise the give-up ESCALATION runs, right after `cancel-intents` — no
	//    provider call, its own age-ranked list and a few calls — so a refund the
	//    resume step cannot afford is still handed to a human within a tick of passing
	//    the limit, instead of "retrying" forever.
	// The due check is one query, so an idle tick pays exactly that.
	const lateRefundsDueNow = budget.leg(WHOLE_TICK).canStart(1, 0)
		? await budget.charge("late-refunds", lateRefundsAreDue).catch(() => false)
		: false;
	const leadsThisTick =
		lateRefundsDueNow && lateRefundsMustLead && isDue(state.lastRun["late-refunds"], now);
	if (leadsThisTick) await lateRefundsLeg(true);

	// The starvation guard (`STARVING_TICKS`): a leg passed over that long goes ahead
	// of even the intent cancels, once, so a unit too big to run behind a cancel still
	// runs while cancels keep coming. Not in a tick a late refund leads.
	const starving = leadsThisTick ? undefined : starvingLeg(state.waits);
	if (starving !== undefined) await runners[starving]();

	await runners["cancel-intents"]();

	if (lateRefundsDueNow && !leadsThisTick) {
		const escalation = budget.leg(WHOLE_TICK, 1 + LATE_REFUND_ESCALATION_UNIT);
		if (escalation.canStart(1, LATE_REFUND_ESCALATION_UNIT)) {
			try {
				lateRefundsEscalated = await budget.charge("late-refunds", () =>
					escalateStaleLateRefunds(
						{
							orderStore: stores.orderStore,
							paymentEventStore: stores.paymentEventStore,
							clock: { now: () => now },
						},
						{ shouldContinue: escalation.gate(0, LATE_REFUND_ESCALATION_UNIT) },
					),
				);
			} catch (err) {
				console.error("[otta] cron sweep late-refunds escalation FAILED:", err);
			}
		}
	}

	const order = tickOrder(state.waits);
	for (const leg of order) {
		if (leg === "cancel-intents" || leg === starving) continue;
		await runners[leg]();
	}

	// THE SECOND PASS. A share is a cap, not a reservation — but a cap alone wastes
	// what the legs after a capped leg did not need: a Free tick with only an expiry
	// backlog would stop at one order with half its budget unspent. So a leg that
	// stopped with work left (and not at the ceiling) goes again, in the same order,
	// on whatever the tick has left — the money legs first. Its due list is read
	// again, since the first pass consumed the one it had.
	expirable = undefined;
	intentCancelsDue = undefined;
	secondPass = true;
	for (const leg of ["cancel-intents" as const, ...order.filter((x) => x !== "cancel-intents")]) {
		const first = legs.find((entry) => entry.leg === leg);
		if (first === undefined || first.ok !== true || first.incomplete !== true) continue;
		// Only a leg its SHARE stopped: one that used its whole per-tick batch is done
		// for this tick, and one the ceiling stopped has nothing left to spend.
		if (!stoppedByBudget.has(leg) || stoppedAtCeiling.includes(leg)) continue;
		if (leg === "late-refunds") continue;
		stoppedByBudget.delete(leg);
		await runners[leg]();
	}
	secondPass = false;

	// ── after the legs ────────────────────────────────────────────────────────

	// The aging record: a leg that waited (deferred, or not reached) adds a tick; a
	// leg that ran, or found nothing to do, starts again from zero.
	for (const leg of SWEEP_LEGS) {
		const before = state.waits[leg] ?? 0;
		if (waited.has(leg) && !reached.has(leg)) {
			state.waits[leg] = before + 1;
			stateChanged = true;
		} else if (reached.has(leg) && before > 0) {
			delete state.waits[leg];
			stateChanged = true;
		}
	}

	budget.finishLegs();
	if (stateChanged) await cursors.write(STATE_CURSOR, JSON.stringify(state));
	// After the state write, so the line's total is the tick's whole spend.
	logTick(budget, legs, deferredByBudget, stoppedAtCeiling);

	const listed = (leg: SweepLeg): number => SWEEP_LEGS.indexOf(leg);
	const reported = legs
		.map((entry) => ({ ...entry, queries: budget.queriesFor(entry.leg) }))
		.toSorted((x, y) => listed(x.leg) - listed(y.leg));
	return {
		task,
		scheduledAt: nowIso,
		legs: reported,
		budget: {
			timeMs: budget.limits.ms,
			queries: budget.limits.queries,
			expiryBatch: expiryLimit,
			emailBatch: emailLimit,
			queriesUsed: budget.queriesUsed(),
			overheadQueries: budget.overheadQueries(),
		},
	};
}

/** A leg that threw: its own row, never a rejected tick. */
function failedOutcome(leg: SweepLeg, err: unknown): Omit<SweepLegOutcome, "queries"> {
	return { leg, ok: false, count: 0, error: err instanceof Error ? err.message : String(err) };
}

/**
 * This tick's leg order (after `cancel-intents`, which always runs first): every leg
 * that has waited at least `AGING_TICKS` ticks in a row, longest wait first (ties:
 * the lower-priority leg first), then the rest in `LEG_PRIORITY`.
 *
 * THE FAIRNESS RULE (QA2 M2). Priority alone starves: on the Workers Free preset
 * under a backlog the first leg or two spend the tick, and QA saw `coupon-orphans`
 * deferred 180 ticks in a row, `sku-transfers` 175, `hold-intents` 145 — a paid
 * order's stock commit two hours late. Aging bounds that: a leg passed over for
 * `AGING_TICKS` ticks goes to the head of the next one, where its share always holds
 * one unit of its work. With every leg backlogged at once the aged legs take turns
 * at the head, so each still runs within a bounded number of ticks (the backlog
 * suite pins it).
 */
export function tickOrder(waits: Partial<Record<SweepLeg, number>>): SweepLeg[] {
	const rank = (leg: SweepLeg): number => LEG_PRIORITY.indexOf(leg);
	// Equal waits: the LOWER-priority leg first — the higher one runs right after it
	// anyway in the ordinary order, and it is the lower one that keeps losing.
	const aged = LEG_PRIORITY.filter(
		(leg) => !UNPROMOTED_LEGS.includes(leg) && (waits[leg] ?? 0) >= AGING_TICKS,
	).toSorted((x, y) => (waits[y] ?? 0) - (waits[x] ?? 0) || rank(y) - rank(x));
	return [...aged, ...LEG_PRIORITY.filter((leg) => !aged.includes(leg))];
}

/** The leg the starvation guard puts ahead of `cancel-intents` this tick, if any:
 *  the longest wait at or past `STARVING_TICKS` (ties: the lower-priority leg).
 *  `late-refunds` is excluded — it has its own lead — and so are `UNPROMOTED_LEGS`. */
export function starvingLeg(waits: Partial<Record<SweepLeg, number>>): SweepLeg | undefined {
	const rank = (leg: SweepLeg): number => LEG_PRIORITY.indexOf(leg);
	return LEG_PRIORITY.filter(
		(leg) =>
			leg !== "cancel-intents" &&
			leg !== "late-refunds" &&
			!UNPROMOTED_LEGS.includes(leg) &&
			(waits[leg] ?? 0) >= STARVING_TICKS,
	).toSorted((x, y) => (waits[y] ?? 0) - (waits[x] ?? 0) || rank(y) - rank(x))[0];
}

/**
 * The tick's one summary line, when it did anything worth reading: what it spent,
 * by leg (and the tick's own reads, as `overhead`), and what it left for the next tick. An idle
 * tick — every leg found nothing — is silent.
 */
function logTick(
	budget: TickBudget,
	legs: readonly Omit<SweepLegOutcome, "queries">[],
	deferred: readonly SweepLeg[],
	stoppedAtCeiling: readonly SweepLeg[],
): void {
	const busy = legs.some(
		(entry) => entry.count > 0 || entry.incomplete === true || entry.ok === false,
	);
	if (!busy && deferred.length === 0 && stoppedAtCeiling.length === 0) return;
	const spent = SWEEP_LEGS.filter((leg) => budget.queriesFor(leg) > 0).map(
		(leg) => `${leg} ${String(budget.queriesFor(leg))}`,
	);
	spent.push(`overhead ${String(budget.overheadQueries())}`);
	console.log(
		`[otta] cron sweep used ${String(budget.queriesUsed())} of ${String(budget.limits.queries)} queries` +
			` (${String(budget.elapsedMs())}ms of ${String(budget.limits.ms)}ms): ${spent.join(", ")}` +
			(deferred.length > 0 ? `; deferred to the next tick: ${deferred.join(", ")}` : "") +
			(stoppedAtCeiling.length > 0
				? `; stopped at the ceiling: ${stoppedAtCeiling.join(", ")}`
				: ""),
	);
}

/**
 * The order store, counting each `claimNextEmail` that came back with a row. A
 * delegating object rather than a proxy: the store's `#private` fields need their
 * own receiver.
 */
function countClaims<S extends object>(store: S, onClaim: () => void): S {
	return new Proxy(store, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop === "claimNextEmail") {
				return async (...args: unknown[]) => {
					const row: unknown = await (value as (...a: unknown[]) => Promise<unknown>).apply(
						target,
						args,
					);
					if (row !== null && row !== undefined) onClaim();
					return row;
				};
			}
			return (value as (...a: unknown[]) => unknown).bind(target);
		},
	});
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
				// The storage guard's repair walk reads past the meter (review A2): the
				// budget is D1's per-invocation cap, the walk only runs after a Postgres
				// error, and it is bounded by its own page budget. Charged here, a bad
				// row deep in a collection cut the walk off every tick, from page 0.
				if (prop === UNMETERED_COLLECTION) return inner;
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
	// A CMS call is several host queries, not one, and is charged as such: a `list`
	// at its worst before it is made, a `get` as a miss before it is made and the rest
	// of a hit after a document comes back (`CONTENT_READ_QUERIES`) — so a confirming
	// re-read of a missing row costs what it really costs.
	const reader = ctx.content;
	const charge = (queries: number): void => {
		for (let i = 0; i < queries; i++) budget.countQuery();
	};
	const content: ContentReadAccess | undefined =
		reader === undefined
			? undefined
			: {
					async get(collection, id) {
						charge(CONTENT_MISS_QUERIES);
						const doc = await reader.get(collection, id);
						if (doc !== null) charge(CONTENT_READ_QUERIES - CONTENT_MISS_QUERIES);
						return doc;
					},
					list(collection, listOptions) {
						charge(CONTENT_LIST_QUERIES);
						return reader.list(collection, listOptions);
					},
				};
	return Object.assign(Object.create(ctx) as PluginContext, {
		kv: counted(ctx.kv),
		http: counted(ctx.http),
		...(storage === undefined ? {} : { storage }),
		...(content === undefined ? {} : { content }),
	});
}

/**
 * The payment gateways for a provider-facing leg, as the LAZY thunk the domain
 * calls per unit of work — and only once it has found some, so a quiet tick reads
 * no secrets. An injected map or thunk wins (suites). Otherwise the deployment's
 * own, resolved ONCE per leg from the COUNTED context (the secret kv reads and
 * every Stripe subrequest count against the tick's query budget), with each Stripe
 * call bounded, AT THE CALL, by `min(callCapMs, what the leg has left)`.
 */
function sweepGateways(
	ctx: PluginContext,
	options: CommerceSweepOptions,
	stripeOptions: StripeGatewayOptions,
): () => Promise<PaymentGateways> {
	let resolved: Promise<PaymentGateways> | undefined;
	return async () => {
		const injected = options.gateways;
		if (typeof injected === "function") return injected();
		if (injected !== undefined) return injected;
		resolved ??= resolvePaymentGateways(ctx, stripeOptions);
		return resolved;
	};
}

/** The gateways, each `cancelIntent` followed by `afterCall` once it has returned —
 *  what opens the commit window for the withdrawal's record. */
function recordingCancels(
	gateways: () => Promise<PaymentGateways>,
	afterCall: () => void,
): () => Promise<PaymentGateways> {
	return async () => {
		const resolved = await gateways();
		const wrapped: PaymentGateways = {};
		for (const [method, gateway] of Object.entries(resolved)) {
			if (gateway === undefined) continue;
			wrapped[method as keyof PaymentGateways] = {
				...gateway,
				id: gateway.id,
				refundable: gateway.refundable,
				createIntent: (input) => gateway.createIntent(input),
				verifyConfirmation: (raw) => gateway.verifyConfirmation(raw),
				refund: (input) => gateway.refund(input),
				async cancelIntent(input) {
					const result = await gateway.cancelIntent(input);
					afterCall();
					return result;
				},
			};
		}
		return wrapped;
	};
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
	transport: EmailTransport | undefined,
): EmailSender | undefined {
	if (options.emailSender !== undefined) return options.emailSender;
	const apiUrl = IN_PROCESS_EGRESS_URLS.emailApiUrl;
	// Reached only once the leg has resolved the store's transport; the build reuses
	// it rather than reading the provider again.
	const factory =
		options.emailSenderFactory ??
		((requestTimeoutMs: () => number) =>
			makeEmailSender(
				ctx,
				{ apiUrl },
				{ requestTimeoutMs, ...(transport !== undefined ? { transport } : {}) },
			));
	const timeoutMs = (): number =>
		Math.max(1, Math.min(SWEEP_EMAIL_SEND_TIMEOUT_MS, legBudget.remainingMs()));
	let built: Promise<EmailSender | undefined> | undefined;
	const attempt = async (input: Parameters<EmailSender["send"]>[0]): Promise<void> => {
		built ??= factory(timeoutMs, ctx);
		const sender = await built;
		// Unreachable while the leg's check and `makeEmailSender` agree; a throw
		// here is a failed send, rescheduled like any other.
		if (sender === undefined) throw new Error("email sender is not configured");
		await sender.send(input);
	};
	return {
		/**
		 * The WHOLE send is raced against a timer — not only the request and body
		 * read the sender's own deadline covers (`send-deadline.ts`). Everything
		 * before the request (building the sender's kv reads, and the host's
		 * `ctx.http.fetch` resolving the provider's address over DNS-over-HTTPS)
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
				// The tick's query ceiling refused a call inside the send (building the
				// sender reads kv): that is the sweep's own limit, never the provider's
				// failure — handed back due at once, uncounted, like a send cut short.
				if (isSweepQueryCeilingError(err)) {
					throw new EmailSendTimeoutError(limitMs, { cutShort: true });
				}
				throw err;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/** The legs whose "skipped — not wired" line was logged in this isolate: it is
 *  true every minute on such a deployment, so it is said once, not 1,440 times a
 *  day. Per leg, so one unwired leg's line never silences another's. */
const loggedSkipped = new Set<SweepLeg>();

/**
 * One line for a leg that DID something worth reading: a non-zero count, more
 * left for the next tick, or a deployment fact. An idle leg is silent — at one
 * tick a minute, nine idle lines would bury the lines that matter. Failures
 * (`console.error`) and deferrals (their own line) are logged elsewhere.
 */
function logOutcome(outcome: Omit<SweepLegOutcome, "queries">): void {
	if (outcome.skipped === true) {
		if (!loggedSkipped.has(outcome.leg)) {
			loggedSkipped.add(outcome.leg);
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

function batchOutcome(
	result: { count: number; drained: boolean },
	onUnits?: (count: number) => void,
	cutShort = false,
): {
	count: number;
	incomplete?: true;
} {
	onUnits?.(result.count);
	return result.drained && !cutShort
		? { count: result.count }
		: { count: result.count, incomplete: true };
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
/** A leg's optional entry hooks (see `run`). */
interface LegHooks {
	/** One cheap query: is there any work? `false` ⇒ a quiet, idle leg. */
	readonly isDue?: () => Promise<boolean>;
	/** The due check is the leg's own work list, which its body needs anyway — so
	 *  it is always asked (the "deferred last tick" shortcut saves nothing). */
	readonly cheapDueCheck?: boolean;
	/** Units a step outside the leg's body completed for it this tick (counted in
	 *  its outcome, run or deferred). */
	readonly extraCount?: () => number;
}

interface SweepState {
	lastRun: Partial<Record<SweepLeg, string>>;
	deferrals: Partial<Record<SweepLeg, number>>;
	/** Ticks in a row each leg was passed over with work (deferred, or not reached)
	 *  — what ages it to the head of a tick (`tickOrder`). */
	waits: Partial<Record<SweepLeg, number>>;
}

/** A lost or garbled state only makes every scan due and resets the streaks —
 *  the same "a lost cursor costs a re-read" rule as every other cursor here. */
async function readState(cursors: SweepCursorStore): Promise<SweepState> {
	const state: SweepState = { lastRun: {}, deferrals: {}, waits: {} };
	const raw = await cursors.read(STATE_CURSOR);
	if (raw === null) return state;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return state;
		const { lastRun, deferrals, waits } = parsed as {
			lastRun?: unknown;
			deferrals?: unknown;
			waits?: unknown;
		};
		for (const leg of SWEEP_LEGS) {
			const stamp = (lastRun as Record<string, unknown> | undefined)?.[leg];
			if (typeof stamp === "string" && (MAINTENANCE_LEGS.includes(leg) || leg === "late-refunds")) {
				// `late-refunds` keeps a stamp too: when it last LED a tick.
				state.lastRun[leg] = stamp;
			}
			const streak = (deferrals as Record<string, unknown> | undefined)?.[leg];
			if (typeof streak === "number" && Number.isInteger(streak) && streak > 0) {
				state.deferrals[leg] = streak;
			}
			const waited = (waits as Record<string, unknown> | undefined)?.[leg];
			if (typeof waited === "number" && Number.isInteger(waited) && waited > 0) {
				state.waits[leg] = waited;
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
 * for the next tick, or a row asked to wait. `estimate`, when a leg can size a row
 * from the document in hand, is that row's expected calls, checked before it runs.
 */
async function walkWindow<T>(
	window: ScannedWindow<T>,
	budget: LegBudget,
	leg: SweepLeg,
	visit: (item: { id: string; data: T }) => Promise<void | "stop">,
	estimate?: (item: { id: string; data: T }) => number,
): Promise<{ handled: readonly { id: string; data: T }[]; incomplete: boolean }> {
	let handled = 0;
	const gate = budget.gate(0, LEG_QUERY_COSTS[leg].unit);
	for (const item of window.items) {
		if (!gate(estimate?.(item))) break;
		// "stop": the row cannot be judged yet. It is NOT handled, so a cursor stays
		// before it and the next tick starts there.
		if ((await visit(item)) === "stop") break;
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
 *
 * A CANCELLATION'S PENDING RESTOCK rides the same index (issue #364): a paid order's
 * cancel restocks only after its flip lands, and the flip records the restock it
 * owes (`cancellation.restockPending`), which `holdsPendingAt` counts. So when that
 * restock failed, this leg finishes it through the domain's
 * `finishCancellationRestock` — under the keys the flip recorded, so a racing replay
 * moves nothing twice. A failure is an anomaly for this row only: the marker stays,
 * the order stays in the index, and the next tick retries it. A line the inventory no
 * longer knows is flagged on the order, because nobody else will see it.
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
	const walked = await walkWindow(
		window,
		budget,
		"hold-intents",
		async (item) => {
			const id = toOrderId(item.data.orderId);
			const attempts = [
				{ kind: "adopt" as const, result: await stores.orderStore.completeHoldAdoption(id) },
				{ kind: "commit" as const, result: await stores.orderStore.completeHoldCommit(id) },
				{ kind: "release" as const, result: await stores.orderStore.completeHoldRelease(id) },
			];
			completed += attempts.filter((attempt) => attempt.result.completed).length;
			const owed = item.data.cancellation?.restockPending ?? null;
			// A backed-off restock waits for its `retryAt`, even when another intent on
			// the same order brought the row into this scan early.
			if (owed !== null && (owed.retryAt === undefined || owed.retryAt <= nowIso)) {
				const restocked = await finishRestockOwed(stores, id);
				anomalies.push(...restocked.anomalies);
				if (restocked.finished) completed++;
			}
			const lost = attempts.filter((attempt) => attempt.result.lost.length > 0);
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
		},
		holdIntentCost,
	);
	return legResult(completed, walked.incomplete, anomalies);
}

/**
 * Finish one cancelled order's pending restock (issue #364). `finished` when this
 * call closed it; a failure is logged and is an anomaly, and the order stays in
 * `holdsPendingAt` (backed off once flagged) for a later tick. Lines it could not
 * return (a deleted sku) are flagged on the order — the operator who cancelled it
 * has long since left the page — unless another flag is already there, which is
 * never overwritten: that, like a stuck-restock flag the domain could not write, is
 * reported as an anomaly instead.
 */
async function finishRestockOwed(
	stores: InProcessCommerceStores,
	orderId: OrderId,
): Promise<{ finished: boolean; anomalies: string[] }> {
	try {
		const res = await finishCancellationRestock(
			{ orderStore: stores.orderStore, inventoryStore: stores.inventory },
			orderId,
		);
		const anomalies: string[] = [];
		if (res.flagSkipped !== null) {
			// Another flag is on the order; it is never overwritten. Reported here instead.
			anomalies.push(`${orderId}:restock-flag-skipped: ${res.flagSkipped}`);
		}
		if (res.failure !== null) {
			// Counted on the order, which is flagged (and backed off) after a few in a
			// row — the domain's CANCELLATION_RESTOCK_FLAG_AFTER; this tick only logs it.
			console.error(`[otta] cron sweep: the pending restock of cancelled order ${orderId} failed`, {
				error: res.failure,
			});
			anomalies.push(`${orderId}:restock`);
			return { finished: false, anomalies };
		}
		if (res.restockSkipped.length > 0) {
			const lines = res.restockSkipped
				.map((skip) => `${skip.sku} ×${String(skip.quantity)}`)
				.join(", ");
			const text = `cron sweep: the cancellation's restock could not return ${lines} (no inventory row) — adjust stock by hand`;
			// Never over a flag something else wrote: report it instead.
			if ((res.order?.reconciliationFlag ?? null) === null) {
				await stores.orderStore.flagReconciliation(orderId, text);
			} else {
				anomalies.push(`${orderId}:restock-flag-skipped: ${text}`);
			}
		}
		return { finished: res.finished, anomalies };
	} catch (err) {
		console.error(`[otta] cron sweep: the pending restock of cancelled order ${orderId} failed`, {
			error: err instanceof Error ? err.message : String(err),
		});
		return { finished: false, anomalies: [`${orderId}:restock`] };
	}
}

/**
 * What completing one order's outstanding hold intents costs, from the document in
 * hand: the three completers' order reads, then per reservation id of each
 * OUTSTANDING intent a settle (about seven calls: the index, the aggregate, the key,
 * the terminal state, the prune) and the intent's stamp (two). A pending
 * cancellation restock adds its reads and its marker write (four) and a keyed
 * restock per line (about six: the key claim, the stock row, the ledger). A ten-line
 * order owes far more than the one-line unit `LEG_QUERY_COSTS` measures, and the
 * gate must know before it starts the row, not after (QA2 M2).
 */
function holdIntentCost(item: { data: OrderDoc }): number {
	let calls = 3;
	for (const intent of [
		item.data.holdsAdopted,
		item.data.holdsCommitted,
		item.data.holdsReleased,
	]) {
		if (intent === undefined || intent === null || intent.completedAt !== null) continue;
		calls += 7 * intent.reservationIds.length + 2;
	}
	const restock = item.data.cancellation?.restockPending ?? null;
	if (restock !== null) calls += 6 * restock.lineIds.length + 4;
	return calls;
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
 *
 * AND ONE DAY IS BOUNDED BY THE CALLS THE LEG HAS LEFT (QA2 M2). A day's FIRST heal
 * absorbs every live rollup claim the day's orders made — two calls each — inside
 * one `reconcile`, and QA logged that as one tick of 334 queries against a budget of
 * 30. So each day is reconciled by a store whose page budget (`maxReconcilePages`:
 * one unit per page of orders or claims, and per claim absorbed) is what the leg
 * can still afford. A day that runs out ABSORBING has made progress — every claim
 * it absorbed stays absorbed and is skipped next time — so it is `incomplete` and
 * resumes next tick; the cursor does not move past it. A day whose orders cannot
 * even be READ within the most this budget could ever give the leg is too big for
 * the setting, and fails loudly (stamped, retried at the cadence) rather than
 * overrunning: raise "Background work per minute".
 */
async function healReportingRollups(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	now: Date,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
	budget: LegBudget,
	queryBudget: number,
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
		const units = reconcileUnitsFor(budget.remainingQueries());
		const bounded = new EmdashReportingStore({
			storage,
			clock: stores.clock,
			maxReconcilePages: units,
		});
		try {
			const result = await bounded.reconcile({
				from: `${day}T00:00:00.000Z`,
				to: `${day}T23:59:59.999Z`,
			});
			written += result.documentsWritten;
			finished = day;
		} catch (err) {
			if (!isScanPageLimitError(err)) throw err;
			// Out of calls for this day. Absorbing, it made progress: resume next tick.
			if (
				err.operation === "absorbReportingClaims" ||
				units < reconcileUnitsFor(queryBudget * 0.9)
			) {
				incomplete = true;
				break;
			}
			throw new Error(
				`reporting-heal: ${day} is too large to reconcile within one tick's query budget` +
					` (${String(queryBudget)}): its orders alone need more than ${String(units)} pages.` +
					' Raise "Background work per minute" (DEPLOYMENT.md §5)',
				{ cause: err },
			);
		}
	}
	// One write for the walk, naming the last day FINISHED: a cut-short walk
	// resumes at the first day it did not reach.
	if (finished !== null) await cursors.write(REPORTING_CURSOR, finished);
	return legResult(written, incomplete);
}

/**
 * The reconcile page budget the given calls can pay for. A unit is a page read (one
 * call) or a claim absorbed (two), and the reconcile also makes reads it does not
 * count (a pin and a commit per currency). A day spends at least three page units
 * (its currencies, its orders, its claims), so half of what is left, less two for
 * the uncounted reads, never lets the day spend more than the calls given — for a
 * day in one currency; a second currency can cost one more, which the tick's hard
 * ceiling still holds.
 */
function reconcileUnitsFor(calls: number): number {
	return Math.max(1, Math.floor((calls - 2) / 2));
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
 * A redemption is judged only once its order has LEFT `pending`: one whose order is
 * still pending past its hold (the expiry has not reached it yet) stops the walk,
 * and the cursor stays before it until `expire-orders` has flipped it. It used to
 * rely instead on `expire-orders` having run to the end in the same tick, and
 * deferred itself otherwise — which under an expiry backlog on the Workers Free
 * preset meant never (QA saw it deferred 180 ticks in a row, QA2 M2). The grace
 * window (`DEFAULT_COUPON_GRACE_MS`) is not shorter than the order hold
 * (`DEFAULT_CHECKOUT_TTL_MS`), so a redemption old enough to be judged has an order
 * that is due by then. The residual — the expiry's release crashing AND this
 * release then crashing — needs two faults.
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
	const nowIso = now.toISOString();
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
		// An order the expiry has not reached yet (pending, its hold already lapsed)
		// cannot be judged: it is about to become `expired`, which this leg would then
		// owe a release. Wait for it — the walk stops here, the cursor stays before it.
		if (order !== null && order.state === "pending" && order.holdExpiresAt <= nowIso) {
			return "stop";
		}
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

/**
 * PRODUCT ORPHANS (issue #374): soft-delete a `product_commerce` row whose CMS
 * document is gone.
 *
 * WHY IT IS OWED. `content:afterDelete` is the only thing that tombstones a
 * commerce row, and it is fire-and-forget (`createAfterDeleteHandler`): a failed
 * delivery is logged and nothing retries it. A CMS product deleted — and, as
 * merchants do, created again under a NEW id (EmDash mints a fresh ULID) with the
 * same name and sku — then leaves its old row live for good: listed in Pricing &
 * inventory beside the new one, and holding the sku claim the new product needs.
 * This leg is the retry the hook never had.
 *
 * THE TOMBSTONE IS FINAL AND RELEASES THE SKU, so the leg is built around one fact:
 * a `null` from `ctx.content.get` is NOT proof the document is gone. EmDash's
 * trusted read rejects on a database error, but its SANDBOX bridge
 * (`@emdash-cms/cloudflare`, `contentGet`/`contentList`) catches every D1 error and
 * answers `null` / an empty page — a lost binding, an overloaded database or a
 * renamed collection reads exactly like a deleted catalog, and a database failing
 * some reads at random reads like a few deleted products. ADR-0006: a change that
 * only works trusted is still broken. So a row is tombstoned only past every gate:
 *
 *  1. THE CIRCUIT BREAKER, once per run before any row is read: the CMS must
 *     positively LIST at least one product (`content.list(products, limit 1)`).
 *  2. THE FLAKINESS BREAKER, per run: every missing row is re-read on the spot, and
 *     a row that missed and was then FOUND proves the host is answering `null` for
 *     documents that exist. One such contradiction makes the run untrustworthy: no
 *     strike is recorded, the strikes of every row it read are wiped, and the walk
 *     moves PAST those rows. A real deletion misses on every look of every pass, so it
 *     never trips this — a dense block of real orphans (a bulk delete whose hooks were
 *     all lost) is judged like any other rows, under the per-tick cap.
 *  3. THE CANARY: a missing row counts only in a QUALIFYING run — one that read some
 *     OTHER document successfully. When nothing on the page was found, the run reads
 *     the document the circuit breaker listed; a `null` there is the CMS lying.
 *  4. THREE STRIKES (`ORPHAN_STRIKES`), from qualifying runs at least a cadence apart,
 *     each strike `ORPHAN_READS_PER_STRIKE` consecutive misses in one run. Any read
 *     that finds the document wipes the row's strikes.
 *  5. A CAP of `ORPHAN_TOMBSTONES_PER_TICK` tombstones per tick (its second pass
 *     included), logged when hit.
 *  6. The GRACE window: a row younger than `PRODUCT_ORPHAN_GRACE_MS` is not read.
 *
 * A breaker that trips (1, 2, or a canary read `null`) is direct evidence the CMS is
 * not answering truthfully, so strikes gathered while it was failing are wiped with
 * it: ALL of them for 1 and the canary (which keep the cursor); for 2, those of the
 * rows the run read (and the walk moves past them). The run judges nothing and logs
 * an anomaly. (So a store whose every CMS product is gone while live commerce rows
 * remain is never swept — the safe direction, and a state the delete hook makes
 * rare.)
 *
 * WHAT COUNTS AS GONE, when the CMS can be seen: EmDash reads `WHERE id = ? AND
 * deleted_at IS NULL`, so a draft, scheduled, published or unpublished document is
 * found and its row is never touched; a TRASHED document reads `null`, as a
 * permanently deleted one does — and its row is soft-deleted, deliberately: the
 * hook already tombstones on trash (`permanent: false`), and this leg only
 * completes what that delivery would have done. A read that REJECTS is never taken
 * for absence: the leg keeps its place before that row and fails loudly — until the
 * same row has rejected on `ORPHAN_MAX_READ_FAILURES` runs in a row, when it is
 * stepped past (logged every time) so one corrupt row cannot stop the walk forever.
 *
 * THE SOFT DELETE IS THE HOOK'S OWN: the same use-case under the same idempotency
 * key, so it converges with a late hook delivery and a replay is a no-op. It keeps
 * the row's commercial data, releases the product's sku claim, and touches no order,
 * stock or hold.
 *
 * THE CURSOR IS COMPOUND, `(createdAt, id)` — the host's own total order for an
 * `orderBy: { createdAt }` query, which breaks ties on the document id. The filter
 * algebra has no OR, so the query asks `createdAt >= at` and the rows at exactly
 * `at` with an id at or before the cursor's are skipped in memory; a page made only
 * of such rows follows the host's own page cursor. Rows sharing a `createdAt` are
 * therefore never stepped over at a page or tick boundary.
 *
 * NO LIVELOCK ON A TIGHT BUDGET: the row at the cursor is always finishable by the
 * run that reads it — its reads, a canary and a delete stay in hand until it is
 * known not to need them — so every run either moves the cursor or tombstones.
 *
 * ONE PAGE A RUN, sized to what the leg can pay for. The state — the cursor, the
 * suspects and the read-failure streaks — is ONE `ctx.kv` document, read once and
 * written once per run, and BOUNDED: at most `ORPHAN_MAX_SUSPECTS` entries in each
 * map (a strike beyond that is not recorded — the safe direction), each forgotten
 * when not renewed within `ORPHAN_SUSPECT_TTL_MS`.
 */
async function softDeleteOrphanedProducts(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	content: ContentReadAccess,
	now: Date,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
	budget: LegBudget,
	tombstones: { count: number },
): Promise<{ count: number; incomplete?: true; anomalies?: readonly string[] }> {
	const products = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
	const nowMs = now.getTime();
	const nowIso = now.toISOString();
	const cutoff = new Date(nowMs - PRODUCT_ORPHAN_GRACE_MS).toISOString();
	const raw = await cursors.read(PRODUCT_ORPHAN_CURSOR);
	const state = parseOrphanState(raw, nowMs);
	const save = async (): Promise<void> => {
		const next = JSON.stringify(state);
		if (next !== raw) await cursors.write(PRODUCT_ORPHAN_CURSOR, next);
	};
	const anomalies: string[] = [];
	/**
	 * A breaker tripped: judge nothing, and wipe strikes. `scope` says which: `all` for
	 * the CMS-wide trips (the list, the canary), the strikes of the rows this run READ
	 * for a flaky run (gate 2). Not all of them there: a run is flaky because of what it
	 * read, and wiping rows it never looked at would let a host that flickers somewhere
	 * keep every orphan elsewhere from ever reaching its third strike.
	 */
	const outage = async (
		line: string,
		scope: "all" | { readonly readIds: ReadonlySet<string> } = "all",
	): Promise<{ count: number; anomalies: string[] }> => {
		let wiped = 0;
		for (const id of Object.keys(state.suspects)) {
			if (scope === "all" || scope.readIds.has(id)) {
				delete state.suspects[id];
				wiped++;
			}
		}
		const said = wiped > 0 ? `${line}; ${String(wiped)} suspect(s) cleared` : line;
		console.error(`[otta] cron sweep product-orphans: ${said}`);
		anomalies.push(said);
		await save();
		return { count: 0, anomalies };
	};

	// The page: as many rows as the leg can read the CMS for after this query and the
	// circuit breaker's list, at least one, at most a host page.
	const affordable = Math.floor(
		(budget.remainingQueries() - 1 - CONTENT_LIST_QUERIES) / CONTENT_READ_QUERIES,
	);
	const limit = Math.max(1, Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, affordable));
	const where = {
		lifecycle: "live",
		createdAt: state.at === null ? { lt: cutoff } : { gte: state.at, lt: cutoff },
	};
	const afterCursor = (item: { data: ProductCommerceDoc }): boolean =>
		state.at === null ||
		item.data.createdAt > state.at ||
		(state.id !== null && item.data.productId > state.id);
	let page = await products.query({ where, orderBy: { createdAt: "asc" }, limit });
	let rows = page.items.filter(afterCursor);
	// A page made only of rows the cursor already passed (a run of equal `createdAt`
	// longer than a page): follow the host's own cursor, while the budget allows.
	while (rows.length === 0 && page.hasMore && page.cursor !== undefined) {
		if (budget.remainingQueries() < 1 + CONTENT_LIST_QUERIES + CONTENT_READ_QUERIES) {
			budget.stopped = true;
			return legResult(0, true);
		}
		page = await products.query({
			where,
			orderBy: { createdAt: "asc" },
			limit,
			cursor: page.cursor,
		});
		rows = page.items.filter(afterCursor);
	}
	if (rows.length === 0) {
		// The end of the catalog: wrap, and the pass is done.
		finishPass(state, nowMs);
		await save();
		return legResult(0, false);
	}
	// A pass begins at the top of the catalog.
	if (state.at === null && state.passStartedAt === null) state.passStartedAt = nowIso;

	// GATE 1 — can the CMS see any product at all?
	let listed: string[] = [];
	try {
		const page1 = await content.list(PRODUCTS_COLLECTION, { limit: 1 });
		listed = page1.items
			.map((item) => item["id"])
			.filter((id): id is string => typeof id === "string" && id.length > 0);
	} catch (err) {
		if (isSweepQueryCeilingError(err)) throw err;
	}
	if (listed.length === 0) {
		const r = await outage(
			"the CMS lists no products while live commerce rows exist — it cannot be seen, so" +
				" nothing was judged (a broken content binding or an outage, never proof of deletion)",
		);
		return legResult(r.count, false, r.anomalies);
	}

	// Read the page's documents first: GATES 2 and 3 are decided on the run as a whole,
	// before anything is marked or deleted.
	type Read = {
		item: { data: ProductCommerceDoc };
		found: boolean;
		/** A look missed and a later look FOUND the document, or every look missed and the
		 *  gate-1 list returned it: proof of a flaky read. */
		contradicted?: boolean;
		steppedPast?: boolean;
	};
	const reads: Read[] = [];
	const gate = budget.gate(0, CONTENT_READ_QUERIES);
	/** What the run must still be able to afford for the row at the cursor, until it
	 *  is known to be found: a canary read and a delete. */
	const headReserve = (): number =>
		reads[0] === undefined || (reads[0].found === false && reads[0].steppedPast !== true)
			? CONTENT_READ_QUERIES + PRODUCT_ORPHAN_DELETE_CALLS
			: 0;
	let pendingError: unknown;
	for (const item of rows) {
		if (!gate() || budget.remainingQueries() < ORPHAN_ROW_READ_QUERIES + headReserve()) break;
		const id = item.data.productId;
		try {
			// A miss is re-read, at a query each, before it counts: a transient `null`
			// almost never survives three looks in a row.
			let found = false;
			let looks = 0;
			for (; looks < ORPHAN_READS_PER_STRIKE && !found; looks++) {
				found = (await content.get(PRODUCTS_COLLECTION, id)) !== null;
			}
			delete state.failures[id];
			// Found after at least one miss: the host said "missing" for a document it has.
			reads.push({ item, found, contradicted: found && looks > 1 });
		} catch (err) {
			// The tick's own ceiling is not the CMS failing: stop, and let the runner
			// report it once what was read is recorded.
			if (isSweepQueryCeilingError(err)) {
				pendingError = err;
				break;
			}
			const streak = (state.failures[id]?.n ?? 0) + 1;
			if (streak >= ORPHAN_MAX_READ_FAILURES) {
				// One corrupt row must not stop the walk forever. Stepped past — LEFT LIVE
				// — and the streak starts over on the next rotation.
				delete state.failures[id];
				const line = `the CMS read of product ${id} failed on ${String(streak)} runs in a row; its row is left live and stepped past`;
				console.error(`[otta] cron sweep product-orphans: ${line}:`, err);
				anomalies.push(line);
				reads.push({ item, found: false, steppedPast: true });
				continue;
			}
			if (
				state.failures[id] !== undefined ||
				Object.keys(state.failures).length < ORPHAN_MAX_SUSPECTS
			) {
				state.failures[id] = { n: streak, at: nowIso };
			}
			pendingError = new Error(
				`product-orphans: the CMS read of product ${id} failed, so its commerce row is` +
					" left live (a failed read is never taken for a deleted document); the scan" +
					` resumes from it at its next run (failure ${String(streak)} of` +
					` ${String(ORPHAN_MAX_READ_FAILURES)} before it is stepped past)`,
				{ cause: err },
			);
			break;
		}
	}
	const judged = reads.filter((read) => read.steppedPast !== true);
	// A row whose id the gate-1 list just RETURNED counts as found, whatever its `get`s
	// said: the list is a successful read of that very document in this run. And when
	// its gets all missed, the two reads disagree — a get-vs-list CONTRADICTION, the
	// same proof of a lying host as a re-read that overturns a miss (gate 2).
	for (const read of judged) {
		if (!read.found && listed.includes(read.item.data.productId)) {
			read.found = true;
			read.contradicted = true;
		}
	}

	// GATE 2 — FLAKINESS, told apart from deletion by the reads themselves. A row that
	// missed and was then FOUND by a re-read is direct proof that this host is answering
	// `null` for documents that exist, right now. A real deletion misses on every look,
	// every pass. So one contradicted miss makes the whole run untrustworthy: it records
	// no strike, wipes the strikes of every row it read, and moves the walk past them
	// (judged found or not judged at all — never struck). A dense block of REAL orphans
	// has no contradiction in it, so it is judged like any other rows: three strikes
	// over three passes, under the per-tick cap.
	const contradicted = judged.filter((read) => read.contradicted === true);
	// A contradicted row is one the run read, so `reads` is not empty here.
	const firstRead = reads[0];
	const lastRead = reads.at(-1);
	if (contradicted.length > 0 && firstRead !== undefined && lastRead !== undefined) {
		const first = firstRead.item.data;
		const last = lastRead.item.data;
		const r = await outage(
			`${String(contradicted.length)} of ${String(judged.length)} products read on this page were` +
				" missing and then found (on a re-read, or in the CMS's own list) — the CMS is answering" +
				" missing for documents that exist, so nothing on the page was judged" +
				` (products ${first.productId} to ${last.productId}), and the walk moved past it`,
			{ readIds: new Set(reads.map((read) => read.item.data.productId)) },
		);
		state.at = last.createdAt;
		state.id = last.productId;
		const endOfPage = reads.length === rows.length && !page.hasMore;
		if (endOfPage) finishPass(state, nowMs);
		else budget.stopped = true;
		await save();
		if (pendingError !== undefined) throw pendingError;
		return legResult(0, !endOfPage, r.anomalies);
	}
	const nulls = judged.filter((read) => !read.found).length;

	// GATE 3 — the canary. A miss counts only in a run that found some other document.
	let qualifies = judged.some((read) => read.found);
	if (!qualifies && nulls > 0 && budget.remainingQueries() >= CONTENT_READ_QUERIES) {
		const canaryId = listed[0] as string;
		let canary: boolean | undefined;
		try {
			canary = (await content.get(PRODUCTS_COLLECTION, canaryId)) !== null;
		} catch (err) {
			if (isSweepQueryCeilingError(err)) throw err;
			// A canary that cannot be read proves nothing either way: this run judges no
			// miss, and no strike is wiped for it — but it is said.
			const line = `the canary read of listed product ${canaryId} failed, so no miss on this page was judged`;
			console.error(`[otta] cron sweep product-orphans: ${line}:`, err);
			anomalies.push(line);
		}
		if (canary === false) {
			const r = await outage(
				`the CMS listed product ${canaryId} and then read it as missing — its reads cannot be` +
					" trusted, so nothing was judged",
			);
			if (pendingError !== undefined) throw pendingError;
			return legResult(0, false, r.anomalies);
		}
		qualifies = canary === true;
	}

	let deleted = 0;
	let stopped = pendingError !== undefined || reads.length < rows.length;
	const advance = (item: { data: ProductCommerceDoc }): void => {
		state.at = item.data.createdAt;
		state.id = item.data.productId;
	};
	try {
		for (const read of reads) {
			const id = read.item.data.productId;
			if (read.steppedPast === true) {
				advance(read.item);
				continue;
			}
			if (read.found) {
				// Found: every strike against it is wiped.
				delete state.suspects[id];
				advance(read.item);
				continue;
			}
			if (!qualifies) {
				// No other document was read this run: the miss proves nothing, and the row
				// stays ahead of the cursor — first in the next run, which holds a canary
				// for it in hand.
				stopped = true;
				break;
			}
			const suspect = state.suspects[id];
			if (suspect !== undefined && nowMs - Date.parse(suspect.at) < ORPHAN_CONFIRM_AFTER_MS) {
				// Struck already this cadence: not a separate look.
				advance(read.item);
				continue;
			}
			const strikes = (suspect?.n ?? 0) + 1;
			if (strikes < ORPHAN_STRIKES) {
				if (suspect !== undefined || Object.keys(state.suspects).length < ORPHAN_MAX_SUSPECTS) {
					state.suspects[id] = { n: strikes, at: nowIso };
				}
				advance(read.item);
				continue;
			}
			// The last strike.
			if (tombstones.count >= ORPHAN_TOMBSTONES_PER_TICK) {
				const line = `reached the cap of ${String(ORPHAN_TOMBSTONES_PER_TICK)} tombstones in one tick; the rest wait for the next tick`;
				console.error(`[otta] cron sweep product-orphans: ${line}`);
				anomalies.push(line);
				stopped = true;
				break;
			}
			if (budget.remainingQueries() < PRODUCT_ORPHAN_DELETE_CALLS) {
				stopped = true;
				break;
			}
			await softDeleteProductCommerce(
				stores.productCommerce,
				toProductId(id),
				toIdempotencyKey(deriveDeleteIdempotencyKey(PRODUCTS_COLLECTION, id)),
			);
			delete state.suspects[id];
			deleted++;
			tombstones.count++;
			advance(read.item);
		}
	} catch (err) {
		// A delete that threw: keep every row already handled, and fail the leg.
		await save();
		throw err;
	}

	const reachedEnd = !stopped && !page.hasMore;
	if (reachedEnd) finishPass(state, nowMs);
	else budget.stopped = true;
	await save();
	if (pendingError !== undefined) throw pendingError;
	return legResult(deleted, !reachedEnd, anomalies);
}

/** The end of the catalog: wrap the cursor, and record how long the pass took (what
 *  the strikes' lifetime is derived from — `orphanMarkTtlMs`). */
function finishPass(state: OrphanState, nowMs: number): void {
	state.at = null;
	state.id = null;
	if (state.passStartedAt !== null) {
		const took = nowMs - Date.parse(state.passStartedAt);
		if (Number.isFinite(took) && took >= 0) state.lastPassMs = took;
	}
	state.passStartedAt = null;
}

/**
 * How long a strike (or a read-failure streak) survives without renewal: at least
 * `ORPHAN_SUSPECT_TTL_MS`, and FOUR times the last full pass. A strike is renewed only
 * when the walk comes round to its row again — once a pass, plus the rest between
 * passes — so on a catalog whose pass outlasts the floor (about ten thousand products
 * on the Workers Free preset), a fixed seven days would expire every strike before
 * the third, and no orphan would ever be tombstoned. Four passes cover the three
 * strikes with room for a slow pass. Still bounded by `ORPHAN_MAX_SUSPECTS`.
 */
function orphanMarkTtlMs(state: Pick<OrphanState, "lastPassMs">): number {
	return Math.max(ORPHAN_SUSPECT_TTL_MS, 4 * (state.lastPassMs ?? 0));
}

/** One row's record in `product-orphans`' state: how many times, and when last. */
interface OrphanMark {
	n: number;
	at: string;
}

/** `product-orphans`' one kv document: the compound cursor, the suspects (strikes
 *  per product id) and the read-failure streaks. */
interface OrphanState {
	at: string | null;
	id: string | null;
	suspects: Record<string, OrphanMark>;
	failures: Record<string, OrphanMark>;
	/** When the pass now under way began (null between passes). */
	passStartedAt: string | null;
	/** How long the last COMPLETE pass took, ms — what `orphanMarkTtlMs` scales by. */
	lastPassMs: number | null;
}

/** A lost or garbled state costs a re-read and restarts every strike — the safe
 *  direction: nothing is tombstoned on the strength of a lost record. Entries past
 *  their lifetime (`orphanMarkTtlMs`), and any beyond `ORPHAN_MAX_SUSPECTS` per map,
 *  are dropped here, which is what keeps the document bounded. */
function parseOrphanState(raw: string | null, nowMs: number): OrphanState {
	const state: OrphanState = {
		at: null,
		id: null,
		suspects: {},
		failures: {},
		passStartedAt: null,
		lastPassMs: null,
	};
	if (raw === null || raw === "") return state;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return state;
		const value = parsed as Partial<Record<keyof OrphanState, unknown>>;
		if (typeof value.at === "string" && typeof value.id === "string") {
			state.at = value.at;
			state.id = value.id;
		}
		if (typeof value.passStartedAt === "string" && !Number.isNaN(Date.parse(value.passStartedAt))) {
			state.passStartedAt = value.passStartedAt;
		}
		if (
			typeof value.lastPassMs === "number" &&
			Number.isFinite(value.lastPassMs) &&
			value.lastPassMs >= 0
		) {
			state.lastPassMs = value.lastPassMs;
		}
		const ttlMs = orphanMarkTtlMs(state);
		state.suspects = parseMarks(value.suspects, nowMs, ttlMs);
		state.failures = parseMarks(value.failures, nowMs, ttlMs);
		return state;
	} catch {
		return state;
	}
}

function parseMarks(raw: unknown, nowMs: number, ttlMs: number): Record<string, OrphanMark> {
	const marks: Record<string, OrphanMark> = {};
	if (typeof raw !== "object" || raw === null) return marks;
	for (const [id, mark] of Object.entries(raw as Record<string, unknown>)) {
		if (Object.keys(marks).length >= ORPHAN_MAX_SUSPECTS) break;
		if (typeof mark !== "object" || mark === null) continue;
		const { n, at } = mark as { n?: unknown; at?: unknown };
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || typeof at !== "string") continue;
		const ms = Date.parse(at);
		if (Number.isNaN(ms) || ms > nowMs || nowMs - ms > ttlMs) continue;
		marks[id] = { n, at };
	}
	return marks;
}
