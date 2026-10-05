import { idempotencyKey, type OrderId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type {
	OrderStore,
	PaymentIntentCancelOutcome,
	PaymentIntentRecord,
} from "../ports/order-store.js";
import type { CancelIntentResult, PaymentGateway } from "../ports/payment-gateway.js";
import { isUnpaidTerminalState, type LazyGateways } from "./late-payment.js";
import type { Order } from "./model.js";

/** Transient-failure attempts before an intent's cancel is given up. */
export const DEFAULT_INTENT_CANCEL_MAX_ATTEMPTS = 5;
/** Orders the sweep examines per run — small: each may be a provider call inside
 *  someone's cron tick. */
export const DEFAULT_INTENT_CANCEL_BATCH = 3;
/** Backoff after the n-th transient failure: 1, 2, 4, 8 … minutes, capped at an hour. */
function backoffMs(attempts: number): number {
	return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60 * 1000;
}

export interface CancelDueIntentsDeps {
	orderStore: OrderStore;
	clock: Clock;
	/** Resolved PER ORDER and only once something is due: a quiet tick reads no
	 *  secrets, and the caller can bound each provider call by its time left. */
	gateways: LazyGateways;
}

export interface CancelDueIntentsOptions {
	/** At most this many orders per run. Default {@link DEFAULT_INTENT_CANCEL_BATCH}. */
	limit?: number;
	/** Checked before each order; `false` stops the run (a tick budget). */
	shouldContinue?: () => boolean;
	/** Default {@link DEFAULT_INTENT_CANCEL_MAX_ATTEMPTS}. */
	maxAttempts?: number;
	/**
	 * Asked just before each PROVIDER call; `false` ends the run with that intent
	 * untouched — still due, its attempts not counted. For a caller whose budget is
	 * too short for a whole cancel: a cancel cut off by the caller's own deadline
	 * says nothing about the provider, and must never cost one of the attempts that
	 * decide when the sweep gives up.
	 */
	canStartCancel?: () => boolean;
	/** The due orders, when the caller has JUST listed them (its due check), so
	 *  the list is not read twice. */
	due?: readonly OrderId[];
}

/**
 * The intent-cancel sweep — late-payment PREVENTION, drained in its own leg.
 *
 * WITHDRAWN AT THE DEADLINE, NOT AT THE EXPIRY (QA2 M1a). Past its hold an order
 * can no longer be paid — the pay page and resume refuse it — so its intent is
 * withdrawn as soon as it is due, whether or not the expiry has reached the order
 * yet. Waiting for the expiry (as this leg once did) left the intent payable for as
 * long as the expiry lagged, so a tab left open could pay an order that had just
 * expired. An order still `pending` past its hold keeps its stock until the expiry
 * runs; a payment that was already under way when the withdrawal reached the
 * provider (`not_cancellable`) settles it normally — the stock was still held, so
 * that is a sale, not an oversell (ADR-0022, 2026-10-03 amendment).
 *
 * WHY A LEG AND NOT THE EXPIRY. Cancelling at the provider is a network call per
 * order. Inside `expireOrders` it would put a provider's latency (and outage) on
 * the path that releases stock — one slow Stripe and a whole tick's expiries
 * crawl. Here the expiry stays pure state-and-stock, and the cancels are a
 * separate, bounded, budgeted drain over intents that became DUE:
 *  - at the order's hold deadline (`recordPaymentIntent` stamps it), or
 *  - at once, when an unpaid order is cancelled (`cancelOrder` expedites it);
 *  - never, for an order that was paid (the paid flip resolves its intents).
 *
 * Per due intent, by the order's current state:
 *  - left `pending` unpaid (`expired`/`cancelled`/`failed`), or still `pending`
 *    past its hold ⇒ `cancelIntent`, once per attempt, under a key derived from the
 *    intent AND the attempt (a provider replays a saved failure for a reused key). `cancelled` / `not_cancellable` /
 *    `UNSUPPORTED` resolve it; `TERMINAL` gives up (`failed`); `RETRYABLE` or a
 *    throw reschedules with backoff until `maxAttempts`, then gives up. A
 *    RETRYABLE cancel is retried ONLY here — nothing else re-asks the provider.
 *  - still `pending` and BEFORE its hold (only reachable if a due date were ever
 *    set early) ⇒ rescheduled to the hold; a payable order's intent is never
 *    withdrawn.
 *  - paid / anything else / vanished ⇒ resolved `not_needed`.
 *
 * Giving up is safe by construction: a payment on an intent this never cancelled
 * lands on a dead order, and `settleOrder` refunds it (`refundLatePayment`).
 * Returns the number of orders examined.
 */
export async function cancelDueIntents(
	deps: CancelDueIntentsDeps,
	options: CancelDueIntentsOptions = {},
): Promise<number> {
	const now = deps.clock.now();
	const nowIso = now.toISOString();
	const due =
		options.due ??
		(await deps.orderStore.listIntentCancelsDue(
			nowIso,
			options.limit ?? DEFAULT_INTENT_CANCEL_BATCH,
		));
	const maxAttempts = options.maxAttempts ?? DEFAULT_INTENT_CANCEL_MAX_ATTEMPTS;
	let examined = 0;
	for (const orderId of due) {
		if (options.shouldContinue !== undefined && !options.shouldContinue()) break;
		examined++;
		// ONE read of the aggregate per unit: the order and its intents together.
		const ledger = await deps.orderStore.readOrderLedger(orderId);
		const dueIntents = (ledger?.paymentIntents ?? []).filter(
			(intent) =>
				intent.cancelOutcome === null &&
				intent.cancelDueAt !== null &&
				intent.cancelDueAt <= nowIso,
		);
		if (dueIntents.length === 0) continue;
		const order = ledger?.order ?? null;
		// Only an order that left `pending` unpaid makes provider calls; resolve the
		// gateways (bounded by the caller's time left) only then.
		const gateways = order !== null && isWithdrawable(order, now) ? await deps.gateways() : {};
		for (const intent of dueIntents) {
			const settled = await settleIntent(
				deps,
				order,
				orderId,
				intent,
				gateways[intent.gateway],
				now,
				maxAttempts,
				options.canStartCancel,
			);
			if (settled === "out-of-time") return examined;
		}
	}
	return examined;
}

/**
 * Whether an order's intents may be withdrawn now: it left `pending` unpaid, or it
 * is still `pending` but its hold has passed (the expiry simply has not reached it
 * yet — it can no longer be paid either way).
 */
function isWithdrawable(order: Order, now: Date): boolean {
	if (isUnpaidTerminalState(order.state)) return true;
	return order.state === "pending" && Date.parse(order.holdExpiresAt) <= now.getTime();
}

/**
 * The provider idempotency key for ONE cancel attempt. Stripe saves the first
 * result for a key — failures included — and replays it, so retrying under the
 * same key could never get past a transient 500 or a stale refusal. A repeated
 * cancel is harmless (a withdrawn intent stays withdrawn), so attempt n > 1 gets
 * its own key; the first keeps the plain intent-derived form.
 */
function cancelKey(intentId: string, attempt: number) {
	return idempotencyKey(
		attempt <= 1 ? `cancel-intent:${intentId}` : `cancel-intent:${intentId}:${String(attempt)}`,
	);
}

async function settleIntent(
	deps: CancelDueIntentsDeps,
	order: Order | null,
	orderId: OrderId,
	intent: PaymentIntentRecord,
	gateway: PaymentGateway | undefined,
	now: Date,
	maxAttempts: number,
	canStartCancel: (() => boolean) | undefined,
): Promise<void | "out-of-time"> {
	const resolve = (outcome: PaymentIntentCancelOutcome, attempts = intent.cancelAttempts) =>
		deps.orderStore.updatePaymentIntentCancel(orderId, intent.intentId, {
			cancelDueAt: null,
			cancelAttempts: attempts,
			cancelOutcome: outcome,
		});
	const reschedule = (atMs: number, attempts = intent.cancelAttempts) =>
		deps.orderStore.updatePaymentIntentCancel(orderId, intent.intentId, {
			cancelDueAt: new Date(atMs).toISOString(),
			cancelAttempts: attempts,
			cancelOutcome: null,
		});

	if (order === null || (!isUnpaidTerminalState(order.state) && order.state !== "pending")) {
		await resolve("not_needed");
		return;
	}
	if (!isWithdrawable(order, now)) {
		// Pending and still inside its hold: the buyer may pay it. Never withdraw it
		// early — look again at the deadline.
		await reschedule(Date.parse(order.holdExpiresAt));
		return;
	}
	if (gateway === undefined) {
		// This deployment has no gateway for the method that minted it (any more).
		await resolve("unsupported");
		return;
	}

	// No time for a WHOLE cancel: leave it due and uncounted for a later tick.
	if (canStartCancel !== undefined && !canStartCancel()) return "out-of-time";
	const attempts = intent.cancelAttempts + 1;
	let res: CancelIntentResult;
	try {
		res = await gateway.cancelIntent({
			orderId,
			intentId: intent.intentId,
			idempotencyKey: cancelKey(intent.intentId, attempts),
		});
	} catch (err) {
		console.error(
			`[domain] cancelling payment intent ${intent.intentId} of order ${orderId} threw`,
			{ error: err instanceof Error ? err.message : String(err) },
		);
		res = { ok: false, reason: "RETRYABLE" };
	}

	if (res.ok) {
		await resolve(res.outcome, attempts);
		return;
	}
	if (res.reason === "UNSUPPORTED") {
		await resolve("unsupported", attempts);
		return;
	}
	if (res.reason === "RETRYABLE" && attempts < maxAttempts) {
		await reschedule(now.getTime() + backoffMs(attempts), attempts);
		return;
	}
	// TERMINAL, or retries exhausted. Logged once; the late-payment refund is the
	// backstop for any payment that still lands on this intent. And FLAGGED, so an
	// admin sees it on the orders console: the intent may still be payable. Never
	// over a flag already there — that one is somebody else's anomaly to resolve —
	// including one written during the cancel call: `order` was read before it, so
	// the write is a compare-and-set on "still unflagged" (issue #364).
	console.error(
		`[domain] gave up cancelling payment intent ${intent.intentId} of order ${orderId} (${res.reason}, ${String(attempts)} attempt(s)); a late payment on it will be refunded at settle`,
	);
	await resolve("failed", attempts);
	if (order.reconciliationFlag === null) {
		const written = await deps.orderStore.flagReconciliation(
			orderId,
			`Could not withdraw payment intent ${intent.intentId} at the provider (${res.reason}, ${String(attempts)} attempt(s)). It may still be payable: a payment on it is kept while the order is still held, and refunded automatically once the order has expired or been cancelled.`,
			{ expectedFlag: null },
		);
		if (!written) {
			console.warn(
				`[domain] order ${orderId}: intent-withdrawal flag not written for ${intent.intentId} — another reconciliation flag was raised meanwhile and is kept`,
			);
		}
	}
}
