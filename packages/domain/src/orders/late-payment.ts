import type { Cents, Currency } from "../money/cents.js";
import { idempotencyKey, type IdempotencyKey, type OrderId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type {
	CapturedPayment,
	OrderEvent,
	OrderLedger,
	OrderStore,
	RefundRecord,
	RefundRetry,
} from "../ports/order-store.js";
import type { PaymentAnomalyKind, PaymentEventStore } from "../ports/payment-event-store.js";
import type { PaymentGateway } from "../ports/payment-gateway.js";
import type { Order, OrderState, PaymentMethod } from "./model.js";
import { refundOrder, type RefundOrderFailure } from "./refund-order.js";

/**
 * LATE PAYMENTS — money that lands on an order which can no longer take it.
 *
 * The bug this module closes: an order expired (stock released, the buyer told
 * "nothing was charged"), but the buyer still had the pay page open, paid, and
 * Stripe captured the money. Settlement correctly refused to revive the order and
 * flagged it for manual reconciliation — and then nothing happened: no refund, no
 * email, and the order page kept saying nothing was charged.
 *
 * The cure, called by `settleOrder` (and resumed by `retryLatePaymentRefunds`),
 * refunds such a payment automatically, exactly once, records it on the refunds
 * ledger, resolves the reconciliation flag with an `auto-refund` disposition and
 * enqueues one notice email to the buyer.
 *
 * ADR-0008 rejected auto-refund on a settle ANOMALY (an amount mismatch, a lost
 * hold) because those need judgement: the order is live and the merchant may well
 * fulfil it. A late payment on an order that provably left `pending` unpaid needs
 * none — there is nothing it could buy, and the only question is how fast the
 * money goes back. ADR-0022's 2026-10-02 amendment records the decision.
 */

/** Who the ledger and the reconciliation disposition say did it. Not an admin
 *  identity — the domain models none — but a stable, greppable actor string. */
export const LATE_PAYMENT_REFUNDED_BY = "otta:auto-refund";

const MINUTE_MS = 60 * 1000;

/**
 * How long a refund that hit its n-th transient provider failure waits before the
 * sweep resumes it: 5 min, 15 min, then hourly. Stripe's own redelivery usually
 * gets there first; the backoff keeps a provider outage from becoming a stream of
 * doomed calls from every tick.
 */
export function lateRefundRetryDelayMs(attempts: number): number {
	if (attempts <= 1) return 5 * MINUTE_MS;
	if (attempts === 2) return 15 * MINUTE_MS;
	return 60 * MINUTE_MS;
}

/**
 * How long the sweep keeps retrying a transient failure before handing the refund
 * to a human: Stripe's own webhook redelivery window (about three days). Past it,
 * a provider that has been "temporarily" failing is not temporary any more.
 */
export const LATE_REFUND_GIVE_UP_MS = 3 * 24 * 60 * MINUTE_MS;

/**
 * The states an order can leave `pending` into WITHOUT being paid, and never come
 * back from. `failed` is unreachable since ADR-0022 but historical orders still
 * carry it. `cancelled` is in the set, but a cancelled order is only a late
 * payment's order with POSITIVE evidence it was cancelled from `pending` — see
 * {@link leftPendingUnpaid}.
 */
const UNPAID_TERMINAL_STATES: ReadonlySet<OrderState> = new Set(["expired", "cancelled", "failed"]);

/** True iff `state` is a dead end an unpaid order can land in (see above). */
export function isUnpaidTerminalState(state: OrderState): boolean {
	return UNPAID_TERMINAL_STATES.has(state);
}

const LATE_REFUND_KEY_PREFIX = "late-payment-refund:";

/**
 * The ONE idempotency key a late payment is refunded under, derived from the
 * captured payment itself (`providerRef` — Stripe's PaymentIntent id). Every
 * redelivery of the same success, from any event id, and every sweep resume, lands
 * on the same ledger row and the same Stripe `Idempotency-Key`: one payment, one
 * refund. A different late payment on the same order (a second intent) is a
 * different key, because it is a different refund.
 */
export function latePaymentRefundKey(providerRef: string): IdempotencyKey {
	return idempotencyKey(`${LATE_REFUND_KEY_PREFIX}${providerRef}`);
}

/** The `providerRef` a late-payment refund key was derived from, or `null` when
 *  the key is not one (an admin refund). */
export function providerRefOfLateRefundKey(key: string): string | null {
	return key.startsWith(LATE_REFUND_KEY_PREFIX) ? key.slice(LATE_REFUND_KEY_PREFIX.length) : null;
}

/**
 * POSITIVE EVIDENCE that the order left `pending` without being paid — read off its
 * append-only state-change audit, which every guarded flip writes in the same write
 * as the flip.
 *
 * - `expired` and `failed` are only ever entered from `pending` (the state
 *   machine), so the state itself is the evidence.
 * - `cancelled` is entered from `pending`, `paid` or `processing`. A paid order an
 *   admin later cancelled sits in `cancelled` with captured money too, and a
 *   redelivery of its original settling event must NOT be refunded by a webhook —
 *   that money is the merchant's to return (or not). So a cancelled order counts
 *   only when its audit holds the `pending → cancelled` flip itself. An order that
 *   predates the audit log has no events at all: no evidence, so no automatic
 *   refund — a human decides, as before.
 */
export function leftPendingUnpaid(state: OrderState, events: readonly OrderEvent[]): boolean {
	if (state === "expired" || state === "failed") return true;
	if (state !== "cancelled") return false;
	return events.some((e) => e.fromState === "pending" && e.toState === "cancelled");
}

/** What the buyer-facing order page may say about money on a dead order. */
export type LatePaymentStatus =
	/** Nothing late: no capture on a dead order, or the order is live / was paid /
	 *  cannot be shown to have left `pending` unpaid. */
	| "none"
	/** A late payment was captured and has been refunded in full. */
	| "refunded"
	/** A late payment was captured and is NOT (yet) fully refunded — the refund is
	 *  in flight, failed, or waits on the merchant. Never "nothing was charged". */
	| "refund_pending";

/**
 * Pure classification for the storefront's order page: did money land on this
 * dead order, and has it gone back? Kept beside the refund that produces it, so
 * the page and the cure can never disagree about what a late payment is.
 *
 * Only `succeeded` payments count as captured and only `recorded` refunds as money
 * returned — a reserved or unverified refund row is a promise, not a refund.
 */
export function classifyLatePayment(input: {
	state: OrderState;
	events: readonly OrderEvent[];
	payments: readonly Pick<CapturedPayment, "amount" | "status">[];
	refunds: readonly Pick<RefundRecord, "amount" | "status">[];
}): LatePaymentStatus {
	if (!leftPendingUnpaid(input.state, input.events)) return "none";
	let captured = 0;
	for (const p of input.payments) if (p.status === "succeeded") captured += p.amount;
	if (captured === 0) return "none";
	let refunded = 0;
	for (const r of input.refunds) if (r.status === "recorded") refunded += r.amount;
	return refunded >= captured ? "refunded" : "refund_pending";
}

/**
 * The order and its late-payment status in ONE ledger read (`readOrderLedger`), or
 * `null` for an unknown order. The storefront's order read goes through here.
 */
export async function readOrderWithLatePayment(
	orderStore: OrderStore,
	orderId: OrderId,
): Promise<{ order: Order; latePayment: LatePaymentStatus } | null> {
	const ledger = await orderStore.readOrderLedger(orderId);
	if (ledger === null) return null;
	return {
		order: ledger.order,
		latePayment: classifyLatePayment({
			state: ledger.order.state,
			events: ledger.events,
			payments: ledger.payments,
			refunds: ledger.refunds,
		}),
	};
}

export interface LatePaymentDeps {
	orderStore: OrderStore;
	paymentEventStore: PaymentEventStore;
	clock: Clock;
}

/** The captured money in question — a verified success, or (on a sweep resume)
 *  the payment row a reserved refund was taken against. */
export interface LateCapture {
	gateway: PaymentMethod;
	providerRef: string;
	amount: Cents;
	currency: Currency;
}

/** The anomaly the caller saw — recorded once, on the first sight of this payment. */
export interface LatePaymentAnomaly {
	kind: Extract<PaymentAnomalyKind, "SETTLE_ON_NON_PENDING" | "PAID_FLIP_LOST">;
	detail: string;
}

/**
 * The outcome of {@link refundLatePayment}:
 *  - `ineligible` — not a late payment this module may refund (a live order, one
 *    without evidence it left `pending` unpaid, or a gateway that cannot refund):
 *    the caller keeps the manual-reconciliation behaviour. The capture is still
 *    recorded when the order is in a dead state, so no page claims nothing was
 *    charged.
 *  - `refunded` — refunded (now, or by an earlier attempt), flag resolved, buyer
 *    notified.
 *  - `manual` — the refund definitively did not complete, or its fate is unknown:
 *    the order stays flagged with wording that says which, for a human.
 *  - `retryable` — a transient provider failure; the reservation is kept, the
 *    order flagged "retrying" and a sweep retry scheduled. The caller answers
 *    "retry" so the provider redelivers too.
 */
export type LatePaymentOutcome = "ineligible" | "refunded" | "manual" | "retryable";

function money(capture: LateCapture): string {
	return `${String(capture.amount)} ${capture.currency}`;
}

function flagPrefix(capture: LateCapture, state: OrderState): string {
	return `late payment ${capture.providerRef} (${money(capture)}) on a ${state} order`;
}

/** The flag set BEFORE the provider call, and the only one {@link finish} clears. */
function inProgressFlag(capture: LateCapture, state: OrderState): string {
	return `${flagPrefix(capture, state)}: automatic refund in progress`;
}

/**
 * The flag a failed attempt leaves, worded by WHAT A HUMAN SHOULD DO — the reason
 * code alone does not say whether money may already have left:
 *  - transient: nothing to do, it is being retried;
 *  - fate unknown or provider-side divergence: look before acting — the provider
 *    may already have refunded it, and a second refund would be the buyer's
 *    windfall and the merchant's loss;
 *  - definite refusal: refund it by hand.
 */
function failedFlag(capture: LateCapture, state: OrderState, reason: RefundOrderFailure): string {
	const lead = flagPrefix(capture, state);
	const provider = capture.gateway === "stripe" ? "Stripe" : capture.gateway;
	switch (reason) {
		case "GATEWAY_RETRYABLE":
		case "GATEWAY_NOT_STARTED":
			return `${lead}: automatic refund retrying (the provider could not be reached)`;
		case "GATEWAY_UNVERIFIED":
		case "PROVIDER_ALREADY_REFUNDED":
		case "REFUND_ISSUED_UNRECORDED":
			return `${lead}: automatic refund needs checking (${reason}) — verify in ${provider}, it may already be refunded`;
		case "REFUND_EXCEEDS_TOTAL":
		case "REFUND_EXCEEDS_CAPTURED":
			// Past the refund ceiling, min(Σ captured, total): a second late payment
			// after an earlier refund used it up, a short capture, or one late capture
			// above the total. No refund from Otta can return this money, so "refund it
			// manually" would send the operator to a button that refuses — say where it
			// can be done, without guessing which of those it was.
			return `${lead}: automatic refund not possible (${reason}) — it would exceed what Otta can refund on this order. Nothing was issued: refund it in ${provider} directly, then resolve this flag`;
		default:
			return `${lead}: automatic refund failed (${reason}) — refund it manually`;
	}
}

/**
 * Refund a captured payment that landed on a dead order — the CURE.
 *
 * Every step is idempotent and the whole is re-driven by any redelivery or sweep
 * resume, so a crash between any two steps is healed by the next attempt:
 *
 *  0. On a dead order the capture is recorded on the payments ledger FIRST,
 *     whatever happens next (`provider_ref`-keyed: a redelivery writes nothing).
 *     It is real money we hold; recording it is what keeps the order page from
 *     saying "nothing was charged" even on the paths that cannot refund it.
 *  1. Eligibility: a gateway that can refund, and positive evidence the order
 *     left `pending` unpaid ({@link leftPendingUnpaid}). Otherwise `ineligible`.
 *  2. The anomaly is recorded on FIRST sight of this payment only (no ledger row
 *     under its key yet) — a retry storm is one incident, not N.
 *  3. A refund already `recorded` under the key ⇒ straight to step 6.
 *  4. The order is flagged "automatic refund in progress" BEFORE the provider
 *     call, so a crash past this point leaves it in the admin's queue.
 *  5. `refundOrder` — reserve-before-issue under {@link latePaymentRefundKey},
 *     targeted at THIS payment's `providerRef`. On a non-ok result the key's row
 *     is re-read: a CONCURRENT attempt for the same payment may have finalized it
 *     meanwhile (two deliveries of one event racing), in which case this attempt
 *     joins step 6 rather than flagging a refund that happened. Otherwise the flag
 *     is reworded for the failure, and a transient one schedules a sweep retry.
 *  6. The in-progress flag is resolved (compare-and-clear on that exact flag, so a
 *     different anomaly raised meanwhile survives) with outcome `refunded`, any
 *     scheduled retry is cleared, and ONE `late-payment-refunded` notice carrying
 *     the refunded amount is enqueued (first-wins per order).
 *
 * The order's STATE never moves: an expired order stays expired. `→ refunded` is
 * not a legal move from a dead state, and the ledger's full-refund flip is guarded
 * on that legality.
 */
export async function refundLatePayment(
	deps: LatePaymentDeps,
	gateway: PaymentGateway,
	capture: LateCapture,
	order: Order,
	anomaly: LatePaymentAnomaly | null,
	now: string,
): Promise<LatePaymentOutcome> {
	if (!isUnpaidTerminalState(order.state)) return "ineligible";
	// 0. The money is ours to account for, refundable or not.
	await deps.orderStore.recordPayment({
		orderId: order.id,
		gateway: capture.gateway,
		providerRef: capture.providerRef,
		amount: capture.amount,
		currency: capture.currency,
		status: "succeeded",
	});

	// 1. Eligibility.
	if (!gateway.refundable || capture.gateway !== gateway.id) return "ineligible";
	const ledger = await deps.orderStore.readOrderLedger(order.id);
	if (ledger === null || !leftPendingUnpaid(ledger.order.state, ledger.events)) {
		return "ineligible";
	}
	const state = ledger.order.state;
	const key = latePaymentRefundKey(capture.providerRef);
	const flag = inProgressFlag(capture, state);

	// 2. One incident per payment.
	const existing = await deps.orderStore.getRefundByIdempotencyKey(key);
	if (existing === null && anomaly !== null) {
		await deps.paymentEventStore.recordAnomaly({
			orderId: order.id,
			gateway: capture.gateway,
			kind: anomaly.kind,
			detail: `${anomaly.detail}; refunding automatically`,
			now,
		});
	}

	// 3. Already refunded by an earlier attempt.
	if (existing?.status === "recorded") return finish(deps, order.id, capture, existing);

	// 4 + 5. Flag, then issue (or resume) the refund.
	await deps.orderStore.flagReconciliation(order.id, flag);
	const res = await refundOrder(deps, gateway, {
		orderId: order.id,
		amount: capture.amount,
		currency: capture.currency,
		reason: `payment arrived after the order was ${state}`,
		refundedBy: LATE_PAYMENT_REFUNDED_BY,
		idempotencyKey: key,
		providerRef: capture.providerRef,
		purpose: "late-payment",
	});
	if (res.ok) return finish(deps, order.id, capture, res.refund);

	// A concurrent attempt for the same payment may have won while this one lost.
	const after = await deps.orderStore.getRefundByIdempotencyKey(key);
	if (after?.status === "recorded") return finish(deps, order.id, capture, after);

	return afterFailure(
		deps,
		order.id,
		capture,
		state,
		res.reason,
		ledger.refundRetries.find((r) => r.idempotencyKey === key),
		now,
	);
}

/**
 * What a refund that did not complete leaves behind — shared by the webhook path
 * and the sweep's resume. A TRANSIENT failure backs off PER REFUND (5 min → 15 min
 * → hourly, counted across every attempt from either path) until the refund is
 * older than {@link LATE_REFUND_GIVE_UP_MS}, then is given up; any other failure
 * goes to a human at once, worded by what they should do.
 */
async function afterFailure(
	deps: LatePaymentDeps,
	orderId: OrderId,
	capture: LateCapture,
	state: OrderState,
	reason: RefundOrderFailure,
	prior: RefundRetry | undefined,
	now: string,
): Promise<"retryable" | "manual"> {
	const key = latePaymentRefundKey(capture.providerRef);
	if (reason === "GATEWAY_NOT_STARTED") {
		// The CALLER declined to start the create (no time for a whole one): nothing
		// was issued and the provider did nothing wrong, so no attempt is counted and
		// the flag is left as it is. Due again shortly, for a tick with time.
		await deps.orderStore.scheduleRefundRetry(orderId, key, {
			at: new Date(Date.parse(now) + lateRefundRetryDelayMs(1)).toISOString(),
			attempts: prior?.attempts ?? 0,
			since: prior?.since ?? now,
		});
		return "retryable";
	}
	if (reason === "GATEWAY_RETRYABLE") {
		const attempts = (prior?.attempts ?? 0) + 1;
		const since = prior?.since ?? now;
		if (Date.parse(now) - Date.parse(since) >= LATE_REFUND_GIVE_UP_MS) {
			return giveUp(
				deps,
				orderId,
				capture,
				state,
				`still failing after ${String(attempts)} attempts`,
			);
		}
		await deps.orderStore.flagReconciliation(orderId, failedFlag(capture, state, reason));
		await deps.orderStore.scheduleRefundRetry(orderId, key, {
			at: new Date(Date.parse(now) + lateRefundRetryDelayMs(attempts)).toISOString(),
			attempts,
			since,
		});
		return "retryable";
	}
	// Given to a human: the sweep has nothing left to resume for THIS refund.
	await deps.orderStore.flagReconciliation(orderId, failedFlag(capture, state, reason));
	await deps.orderStore.scheduleRefundRetry(orderId, key, null);
	return "manual";
}

/**
 * Stop retrying a refund and hand it to a human — the provider has failed
 * "transiently" for longer than Stripe's own redelivery window, or this deployment
 * no longer has a gateway to refund through (the secret was removed).
 *
 * NEVER VOIDED BLIND. Whether money left is unknown in general (a stalled call can
 * have reached the provider), so the reservation is kept and marked `unverified` —
 * the existing "fate unknown, capacity held" state — and the flag says to look in
 * the provider first. A human who finds nothing refunded refunds it by hand; one
 * who finds it refunded resolves the flag.
 */
async function giveUp(
	deps: LatePaymentDeps,
	orderId: OrderId,
	capture: LateCapture,
	state: OrderState,
	why: string,
): Promise<"manual"> {
	const key = latePaymentRefundKey(capture.providerRef);
	const provider = capture.gateway === "stripe" ? "Stripe" : capture.gateway;
	await deps.orderStore.markRefundUnverified(key);
	await deps.orderStore.scheduleRefundRetry(orderId, key, null);
	await deps.orderStore.flagReconciliation(
		orderId,
		`${flagPrefix(capture, state)}: automatic refund needs checking (gave up retrying: ${why}) — verify in ${provider}, and refund it manually if it was not refunded`,
	);
	return "manual";
}

/**
 * Step 6: resolve OUR flag, stop retrying, tell the buyer — each idempotent.
 *
 * "Our" flag is any flag this module wrote for THIS payment (in progress,
 * retrying, …): they all start with the payment's own prefix. The resolve is still
 * a compare-and-clear on the exact value read, so an unrelated anomaly raised
 * meanwhile is never cleared. `knownOrder` lets the sweep's resume skip the re-read
 * it has just done (the ledger it resumed from).
 */
async function finish(
	deps: Pick<LatePaymentDeps, "orderStore">,
	orderId: OrderId,
	capture: LateCapture,
	refund: RefundRecord,
	knownOrder?: Order,
	/** The person who confirmed the refund at the provider (`resolveUnverifiedRefund`),
	 *  when it was not the automatic path that saw it succeed. */
	confirmedBy?: string,
): Promise<"refunded"> {
	const fresh = knownOrder ?? (await deps.orderStore.getById(orderId));
	const current = fresh?.reconciliationFlag ?? null;
	if (fresh !== null && current !== null && current.startsWith(flagPrefix(capture, fresh.state))) {
		await deps.orderStore.resolveReconciliation({
			orderId,
			expectedFlag: current,
			outcome: "refunded",
			reason:
				confirmedBy === undefined
					? `Payment arrived after the order was ${fresh.state}; refunded automatically${refund.refundRef === null ? "" : ` (${refund.refundRef})`}.`
					: `Payment arrived after the order was ${fresh.state}; the automatic refund's outcome was unknown and ${confirmedBy} confirmed at the provider that it was refunded${refund.refundRef === null ? "" : ` (${refund.refundRef})`}.`,
			resolvedBy: confirmedBy ?? LATE_PAYMENT_REFUNDED_BY,
			idempotencyKey: idempotencyKey(`late-payment-resolve:${capture.providerRef}`),
		});
	}
	await deps.orderStore.scheduleRefundRetry(
		orderId,
		latePaymentRefundKey(capture.providerRef),
		null,
	);
	await deps.orderStore.enqueueNotice(orderId, {
		kind: "late-payment-refunded",
		amount: refund.amount,
		currency: refund.currency,
		refundId: refund.id,
	});
	return "refunded";
}

/**
 * A late-payment refund whose outcome was UNKNOWN, after a person answered it
 * (`resolveUnverifiedRefund`, #364). The row itself is already settled by the
 * caller; this finishes what the refund was FOR, exactly as the automatic path
 * would have:
 *  - `confirmed` — the money went back: {@link finish} (our flag resolved, the
 *    retry cleared, ONE `late-payment-refunded` notice — first-wins per refund, so
 *    a replay emails nobody). The flag's resolution names the person who
 *    confirmed it, not the automatic path. Answers `finished`.
 *  - `voided` — it never happened, so the payment is still held on a dead order
 *    and nothing will refund it by itself (its one key is spent). The retry is
 *    cleared and the order flagged to refund it by hand — over our own flag for
 *    this payment or none, never over an unrelated one. Answers `refund_manually`
 *    with `flagged` — false when an unrelated flag kept it from writing one.
 * `null` when the row is not a late-payment refund this module made.
 */
export async function finishResolvedLatePaymentRefund(
	deps: Pick<LatePaymentDeps, "orderStore">,
	refund: RefundRecord,
	outcome: "confirmed" | "voided",
	resolvedBy: string,
	/** A replay of a `voided` answer: report, write nothing — a flag a person has
	 *  resolved since is never re-opened. */
	replay = false,
): Promise<{ outcome: "finished" } | { outcome: "refund_manually"; flagged: boolean } | null> {
	const providerRef = providerRefOfLateRefundKey(refund.idempotencyKey);
	if (providerRef === null) return null;
	const capture: LateCapture = {
		gateway: refund.gateway,
		providerRef,
		amount: refund.amount,
		currency: refund.currency,
	};
	if (outcome === "confirmed") {
		await finish(deps, refund.orderId, capture, refund, undefined, resolvedBy);
		return { outcome: "finished" };
	}
	if (!replay) {
		await deps.orderStore.scheduleRefundRetry(refund.orderId, refund.idempotencyKey, null);
	}
	const order = await deps.orderStore.getById(refund.orderId);
	if (order === null) return { outcome: "refund_manually", flagged: false };
	const prefix = flagPrefix(capture, order.state);
	const current = order.reconciliationFlag;
	// Already ours (a replay, or the answer's own earlier write): flagged, untouched.
	if (current !== null && current.startsWith(prefix) && current.includes("did not happen")) {
		return { outcome: "refund_manually", flagged: true };
	}
	// An unrelated open flag is never overwritten: the caller says none was written.
	if (replay || (current !== null && !current.startsWith(prefix))) {
		return { outcome: "refund_manually", flagged: false };
	}
	const provider = capture.gateway === "stripe" ? "Stripe" : capture.gateway;
	await deps.orderStore.flagReconciliation(
		refund.orderId,
		`${prefix}: automatic refund did not happen (${resolvedBy} found no refund in ${provider}) — refund it manually`,
	);
	return { outcome: "refund_manually", flagged: true };
}

/** The gateways the sweep refunds through, resolved only when something is due. */
export type LazyGateways = () =>
	| Partial<Record<PaymentMethod, PaymentGateway>>
	| Promise<Partial<Record<PaymentMethod, PaymentGateway>>>;

export interface RetryLatePaymentRefundsOptions {
	/** At most this many refund UNITS per run (the sweep's batch bound). Default 2 —
	 *  each is a provider round trip inside someone's cron tick. */
	limit?: number;
	/** Asked before EACH refund unit — not each order: an order with two late
	 *  payments is two units, never two under one check. `false` stops the run. */
	shouldContinue?: () => boolean;
	/** The due orders, when the caller has JUST listed them (`listRefundRetriesDue`)
	 *  — the sweep's own due check — so the list is not read twice. */
	due?: readonly OrderId[];
}

/** One due retry the sweep can act on, with what it needs to act. */
interface DueRetry {
	orderId: OrderId;
	ledger: OrderLedger;
	retry: RefundRetry;
	row: RefundRecord | undefined;
	capture: LateCapture | null;
}

/** The due retries on one order's ledger, each paired with its row and capture. */
function dueRetriesOf(orderId: OrderId, ledger: OrderLedger, now: string): DueRetry[] {
	return ledger.refundRetries
		.filter((retry) => retry.at <= now)
		.map((retry) => {
			const row = ledger.refunds.find((r) => r.idempotencyKey === retry.idempotencyKey);
			const providerRef = providerRefOfLateRefundKey(retry.idempotencyKey);
			const payment = ledger.payments.find((p) => p.providerRef === providerRef);
			const capture =
				row === undefined || providerRef === null || payment === undefined
					? null
					: { gateway: payment.gateway, providerRef, amount: row.amount, currency: row.currency };
			return { orderId, ledger, retry, row, capture };
		});
}

/** Whether a retry is past the age limit at `now`. */
function isStale(retry: RefundRetry, now: string): boolean {
	return Date.parse(now) - Date.parse(retry.since) >= LATE_REFUND_GIVE_UP_MS;
}

/**
 * ESCALATION — the give-up step, with NO provider call, so it runs on any budget.
 *
 * Without it, a deployment whose sweep can never afford a refund unit (Workers
 * Free: one unit is most of a tick) would never reach the ~3-day give-up either,
 * and a refund Stripe stopped redelivering would sit `reserved` and "retrying"
 * forever. This takes the due retries whose first failure is older than
 * {@link LATE_REFUND_GIVE_UP_MS} and gives each up: the reservation marked
 * `unverified` (kept, never voided), the retry cleared, the order flagged "needs
 * checking — verify in Stripe". A retry whose row is gone or already in a human's
 * hands is just cleared. Younger retries are left for the resume step.
 *
 * `limit` bounds the ORDERS listed; `shouldContinue` is asked before each
 * escalation. Returns the number escalated.
 */
export async function escalateStaleLateRefunds(
	deps: LatePaymentDeps,
	options: RetryLatePaymentRefundsOptions = {},
): Promise<number> {
	const now = deps.clock.now().toISOString();
	const cutoff = new Date(Date.parse(now) - LATE_REFUND_GIVE_UP_MS).toISOString();
	// Its OWN list, ranked by age: due-but-young retries never stand in the way.
	const stale = await deps.orderStore.listRefundRetriesStale(cutoff, options.limit ?? 2);
	let escalated = 0;
	for (const orderId of stale) {
		if (options.shouldContinue !== undefined && !options.shouldContinue()) break;
		const ledger = await deps.orderStore.readOrderLedger(orderId);
		if (ledger === null) continue;
		for (const retry of ledger.refundRetries) {
			if (!isStale(retry, now)) continue;
			const unit = dueRetriesOf(
				orderId,
				{ ...ledger, refundRetries: [retry] },
				"9999-12-31T23:59:59.999Z",
			)[0];
			if (unit === undefined) continue;
			if (unit.capture !== null && unit.row?.status === "recorded") {
				// Already refunded — a `finish` that crashed after the finalize left the
				// retry behind. Done, not "needs checking": finish it now.
				await finish(deps, orderId, unit.capture, unit.row, ledger.order);
				escalated++;
				continue;
			}
			if (unit.capture === null || unit.row?.status !== "reserved") {
				// Gone, or already in a human's hands: nothing to escalate.
				await deps.orderStore.scheduleRefundRetry(orderId, retry.idempotencyKey, null);
				continue;
			}
			await giveUp(
				deps,
				orderId,
				unit.capture,
				ledger.order.state,
				`no success for ${String(Math.floor(LATE_REFUND_GIVE_UP_MS / 3_600_000))} h`,
			);
			escalated++;
		}
	}
	return escalated;
}

/**
 * Resume late-payment refunds a transient provider failure left `reserved` — the
 * sweep half of the retry. Stripe's redelivery is the first retry, but it gives up
 * after a few days, and a `reserved` row holds ceiling capacity (refusing any admin
 * refund of the same money) until something resumes it or hands it to a human.
 *
 * Per DUE retry (one per refund key) — each a UNIT, gated on its own — it
 * re-drives the reservation under the SAME key through `refundOrder`, fed the
 * ledger it just read, so a resume can never be a second refund (and a resumed
 * reservation whose provider already shows the money back fails CLOSED to "verify
 * in Stripe", never to a re-issue). The unit is TRIMMED for the sweep's query
 * budget: a `reserved` row proves the capture was recorded and the order flagged
 * on the first attempt, so none of that is redone; the ledger read stands in for
 * the refund's own reads, and for the re-read after it.
 *
 * A deployment with no gateway for the payment right now is treated like any
 * transient failure (a missing or unreadable secret is not a reason to hand money
 * to a human) — backed off, given up only past the age limit. A retry whose row is
 * gone or already in a human's hands (`unverified`/`voided`) is simply cleared.
 *
 * Gateways are resolved only once a unit needs one — a quiet tick reads no
 * secrets. Returns the number of units run.
 */
export async function retryLatePaymentRefunds(
	deps: LatePaymentDeps & { gateways: LazyGateways },
	options: RetryLatePaymentRefundsOptions = {},
): Promise<number> {
	const now = deps.clock.now().toISOString();
	const limit = options.limit ?? 2;
	const due = options.due ?? (await deps.orderStore.listRefundRetriesDue(now, limit));
	let units = 0;
	for (const orderId of due) {
		if (units >= limit) break;
		const ledger = await deps.orderStore.readOrderLedger(orderId);
		if (ledger === null) continue;
		for (const unit of dueRetriesOf(orderId, ledger, now)) {
			if (units >= limit) break;
			if (options.shouldContinue !== undefined && !options.shouldContinue()) return units;
			if (unit.capture === null || unit.row === undefined) {
				await deps.orderStore.scheduleRefundRetry(orderId, unit.retry.idempotencyKey, null);
				continue;
			}
			if (unit.row.status === "recorded") {
				// Finalized elsewhere (a redelivery won): just finish the bookkeeping.
				await finish(deps, orderId, unit.capture, unit.row, ledger.order);
				units++;
				continue;
			}
			if (unit.row.status !== "reserved") {
				await deps.orderStore.scheduleRefundRetry(orderId, unit.retry.idempotencyKey, null);
				continue;
			}
			units++;
			if (isStale(unit.retry, now)) {
				// Past the age limit: give it up WITHOUT another provider call (the same
				// step `escalateStaleLateRefunds` takes on a budget too small for this).
				await giveUp(
					deps,
					orderId,
					unit.capture,
					ledger.order.state,
					`no success for ${String(Math.floor(LATE_REFUND_GIVE_UP_MS / 3_600_000))} h`,
				);
				continue;
			}
			const gateway = (await deps.gateways())[unit.capture.gateway];
			if (gateway === undefined || !gateway.refundable) {
				await afterFailure(
					deps,
					orderId,
					unit.capture,
					ledger.order.state,
					"GATEWAY_RETRYABLE",
					unit.retry,
					now,
				);
				continue;
			}
			await resumeReservedLateRefund(deps, gateway, { ...unit, capture: unit.capture }, now);
		}
	}
	return units;
}

/** The trimmed sweep unit: re-issue the reserved refund, then finish or back off. */
async function resumeReservedLateRefund(
	deps: LatePaymentDeps,
	gateway: PaymentGateway,
	unit: DueRetry & { capture: LateCapture },
	now: string,
): Promise<void> {
	const { orderId, ledger, capture } = unit;
	const res = await refundOrder(
		deps,
		gateway,
		{
			orderId,
			amount: capture.amount,
			currency: capture.currency,
			reason: `payment arrived after the order was ${ledger.order.state}`,
			refundedBy: LATE_PAYMENT_REFUNDED_BY,
			idempotencyKey: unit.retry.idempotencyKey,
			providerRef: capture.providerRef,
			purpose: "late-payment",
		},
		ledger,
	);
	if (res.ok) {
		await finish(deps, orderId, capture, res.refund, ledger.order);
		return;
	}
	await afterFailure(deps, orderId, capture, ledger.order.state, res.reason, unit.retry, now);
}
