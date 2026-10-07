/**
 * Send one order's due outbox emails NOW, inline in the request that made them due
 * — the payment-settle routes, so a shopper's order confirmation goes out with the
 * settlement instead of on the next sweep tick, behind the rest of the queue.
 * ADR-0005's 2026-10-02 amendment records the decision.
 *
 * BEST-EFFORT, AND THE CRON IS STILL THE GUARANTEE. Nothing about the outbox
 * changes: the settle writes the row in the order's own compare-and-set exactly as
 * before, and the sweep's `order-emails` leg still drains anything this misses. This
 * is an EARLY ATTEMPT at a row that was going to be sent anyway. So the one rule
 * that matters here is that it can never change the request's outcome:
 *
 *  - it NEVER THROWS, because a webhook whose payment settled must answer 200
 *    whatever the email provider did, or Stripe would redeliver a settlement that
 *    already happened. A failed SEND is not even an error here: the dispatcher
 *    catches it and reschedules the row for the cron, silently, exactly as a cron
 *    tick does. What this module LOGS is the rest — a store rejection out of the
 *    claim or the mark (`console.error`, the order id and the message only), and a
 *    skipped or abandoned attempt (`console.warn`, with the order id);
 *  - it is BOUNDED in time by the request's ONE deadline (`settle-deadline.ts`),
 *    fixed as the route started and shared with the settle's own slow steps (a late
 *    payment's Stripe refund calls) — so their SUM stays under Stripe's ~10 s, not
 *    each alone. The inline wait is the smaller of
 *    {@link ORDER_EMAIL_INLINE_DEADLINE_MS} and what is left of that deadline; a
 *    spent budget skips the attempt. The plugin has no `waitUntil` (ADR-0004), so
 *    the work is awaited inline;
 *  - a timeout is a COUNTED attempt (`countTimeoutsAsAttempts`): `ctx.email` has
 *    no idempotency key, so the email may have been delivered and an uncounted
 *    retry would deliver it again (ADR-0031);
 *  - it is CHEAP when there is nothing to do — no provider (`ctx.email` absent)
 *    costs nothing, a present `ctx.email` costs one kv read (the "no provider"
 *    record, ADR-0031), and the sender (its kv reads) is built only once a row has
 *    been claimed, so a replay costs that and one read of the order;
 *  - it makes the FIRST ATTEMPT ONLY — it claims a row no dispatcher has tried
 *    (`onlyUnattempted`), so it makes at most one COUNTED attempt per row and every
 *    counted retry is the cron's; the total budget (`maxAttempts`) is unchanged.
 *    Repeated Stripe redeliveries during a provider outage therefore cannot
 *    spend it and park the confirmation `failed` within minutes. A row the
 *    host had no provider for goes back uncounted (ADR-0031) and is tried again.
 *
 * WHY ONLY THIS ORDER'S ROWS. `dispatchOrderEmails` drains the whole queue, up to
 * 100 rows across every order — a cron's job, not a request's. The order-scoped
 * `dispatchOrderEmailsForOrder` claims via `claimNextEmailForOrder`: one read of one
 * order document and one compare-and-set, so the request pays for its own order and
 * nothing else.
 *
 * WHY THIS IS SAFE AGAINST THE CRON RUNNING AT THE SAME TIME. The claim is the same
 * single-winner compare-and-set the cron's claim is (ADR-0005 already allows
 * concurrent dispatchers), so at most one of them holds a row at a time. The
 * at-least-once tail (a send accepted but not yet marked when the request died)
 * is bounded by the row's `maxAttempts` (ADR-0031).
 */
import {
	dispatchOrderEmailsForOrder,
	type Clock,
	type CustomerStore,
	type EmailSender,
	type OrderId,
	type OrderStore,
	type OutboxEmail,
} from "@otta-sh/domain";
import { settleDeadline, type SettleDeadline } from "../settle-deadline.js";
import type { PluginContext } from "../types.js";
import {
	countTimeoutsAsAttempts,
	emailSendingAvailable,
	LOGIN_EMAIL_TIMEOUT_MS,
	makeEmailSender,
} from "./ctx-email-sender.js";

/**
 * The ceiling on ONE inline send — DEFINED as the login email's ceiling, for the
 * login email's reason: it is awaited on a request. A provider that has not answered
 * by then is aborted, which the dispatcher turns into a reschedule for the cron. It
 * is further capped by whatever is left of the inline wait.
 */
export const ORDER_EMAIL_INLINE_TIMEOUT_MS = LOGIN_EMAIL_TIMEOUT_MS;

/**
 * The most the request WAITS for the inline dispatch — claim, order and customer
 * reads, the send, the mark. Above {@link ORDER_EMAIL_INLINE_TIMEOUT_MS} so a send
 * that uses its full ceiling can still be marked sent. When it trips, the request
 * stops waiting and the drain stops claiming (`shouldContinue`); a send already in
 * flight is not cancellable from here, and finishes or is torn down with the
 * isolate — either way the row's lease bounds the damage.
 */
export const ORDER_EMAIL_INLINE_DEADLINE_MS = 5_000;

/**
 * The lease the inline claim takes — 1 minute, not the dispatcher's default 5.
 *
 * The lease is how long a claimed row is invisible to every other dispatcher, so it
 * is the cost of the request dying mid-send: the row waits out the lease before the
 * cron may reclaim it. The cron's 5 minutes is sized for a whole tick draining 100
 * rows; the inline path holds a row for at most {@link ORDER_EMAIL_INLINE_DEADLINE_MS},
 * so a minute is still a 12x margin over the longest legitimate hold (a shorter lease
 * would let a cron tick reclaim a row a live request is still sending, and
 * send it twice). It is also the backoff a FAILED
 * inline send is rescheduled to, so the next cron tick past it retries it.
 */
export const ORDER_EMAIL_INLINE_LEASE_MS = 60_000;

/** The stores the inline dispatch reads — the route's own, so the settle and the
 *  send see one set of stores and one clock.
 *
 *  Named by the DOMAIN's ports, not as a `Pick` of `InProcessCommerceStores`:
 *  this type reaches the plugin's published declarations through the settle
 *  routes' options, and `InProcessCommerceStores` names store-emdash's concrete
 *  classes, whose declarations pull in Vite's types — which the dts bundle then
 *  fails on (`test/bundle-imports.test.ts`). */
export type OrderEmailStores = {
	readonly orderStore: OrderStore;
	readonly customerStore?: CustomerStore;
	readonly clock: Clock;
};

/** The route-supplied deadline, plus test-facing overrides. A deploy passes only
 *  `deadline`. */
export interface SendOrderEmailsNowOptions {
	/**
	 * The sender, injected — the same override `CommerceSweepOptions.emailSender`
	 * is, so a suite pins the inline path against a fake with no egress. Unset, it is
	 * built from `ctx.email` with the inline ceiling, lazily.
	 */
	emailSender?: EmailSender;
	/** The request's ONE deadline (`settle-deadline.ts`), fixed as the route started
	 *  and shared with its other slow steps. Default: a fresh one, starting here. */
	deadline?: SettleDeadline;
}

/**
 * What an inline attempt did — so a caller that tells a person "the buyer has been
 * emailed" (the admin console, QA T1-6) can say it only when it is true.
 *
 * `configured: false` ⇒ the host has no email provider: nothing was sent, and the
 * rows wait in the outbox until one is selected. Otherwise `sent` lists every row this attempt delivered, in order; a row it
 * did not deliver (a failed send, the wait running out, a spent budget) is not
 * there and is the cron's to send. A row sent AFTER the wait ran out is not listed
 * either — the conservative direction for a caller reporting it.
 *
 * `skipped` lists every row this attempt completed WITHOUT a send because the order
 * has no email recipient (an x402 buyer's `x402:0x…` reference, ADR-0028 Decision 7).
 * Such a row is done: it was not sent and never will be, so a caller must not call it
 * queued.
 */
export interface InlineOrderEmails {
	readonly configured: boolean;
	readonly sent: readonly OutboxEmail[];
	readonly skipped: readonly OutboxEmail[];
}

/**
 * Dispatch `orderId`'s due, never-attempted outbox emails now. Resolves (never
 * rejects) once they are sent, have failed and been rescheduled for the cron, the
 * wait has run out, or there was nothing to do — with what it sent. A host with no
 * email provider is a quiet no-op — the cron leg reports that configuration as
 * `skipped`; a per-request log line would only be noise.
 */
export async function sendOrderEmailsNow(
	ctx: PluginContext,
	stores: OrderEmailStores,
	orderId: OrderId,
	options: SendOrderEmailsNowOptions = {},
): Promise<InlineOrderEmails> {
	// Configured-ness FIRST, and quietly: with no sender the cron leg reports `skipped`
	// as well, so a "the cron sweep will take it" line below would be false. (And
	// "take", not "deliver": the sweep may complete a row as skipped — an order with
	// no email recipient, ADR-0028 Decision 7 — rather than send it.)
	if (options.emailSender === undefined && !(await emailSendingAvailable(ctx))) {
		return { configured: false, sent: [], skipped: [] };
	}
	const sent: OutboxEmail[] = [];
	const skipped: OutboxEmail[] = [];

	const deadline = options.deadline ?? settleDeadline();
	const waitMs = Math.min(ORDER_EMAIL_INLINE_DEADLINE_MS, deadline.remainingMs());
	if (waitMs <= 0) {
		console.warn(
			`[otta] inline order email for ${orderId} skipped: the settle used the request's time budget; the cron sweep will take it`,
		);
		return { configured: true, sent: [], skipped: [] };
	}
	// The inline wait's own end — at most the request's deadline, sooner when the
	// 5 s inline cap is the tighter of the two.
	const waitEndsAt = deadline.now() + waitMs;
	// What is left of the wait WHEN EACH SEND STARTS — the claim and the reads before
	// it may have used most of it — capped at the inline ceiling, never below 1 ms.
	const sendTimeoutMs = (): number =>
		Math.max(1, Math.min(ORDER_EMAIL_INLINE_TIMEOUT_MS, waitEndsAt - deadline.now()));

	// No idempotency key on `ctx.email`: a timeout is a COUNTED attempt, so a slow
	// but accepting provider is not re-sent the same email every time. Outermost.
	const emailSender = countTimeoutsAsAttempts(
		options.emailSender ?? lazySender(ctx, sendTimeoutMs),
	);
	// A sandboxed host with no provider answers the first send (`ctx.email` is
	// always present there): the row goes back uncounted and nothing was sent.
	let unavailable = false;

	// Flipped by the deadline: the drain asks before every claim, so once the request
	// stops waiting nothing NEW is claimed by the abandoned work.
	let expired = false;
	// The whole attempt, with its own catch ATTACHED BEFORE the race below: if the
	// deadline wins, this promise keeps running unobserved, and a rejection it
	// produced later must land here rather than as an unhandled rejection.
	const attempt = dispatchOrderEmailsForOrder(
		{
			orderStore: stores.orderStore,
			emailSender,
			customerStore: stores.customerStore,
			clock: stores.clock,
		},
		orderId,
		{
			leaseMs: ORDER_EMAIL_INLINE_LEASE_MS,
			onlyUnattempted: true,
			shouldContinue: () => !expired,
			// Only what was sent while the request was still waiting is reported.
			onSent: (row) => {
				if (!expired) sent.push(row);
			},
			onSkipped: (row) => {
				if (!expired) skipped.push(row);
			},
			onTransportUnavailable: () => {
				unavailable = true;
			},
		},
	).then(
		() => undefined,
		(err: unknown) => {
			// A STORE rejection (the claim or the mark — a failed send never gets here).
			// The message, never the error object: a transport error is free to quote the
			// request it failed on (the login-email precedent, in-process-commerce-client).
			console.error(
				`[otta] inline order email for ${orderId} failed (the cron sweep will retry):`,
				err instanceof Error ? err.message : "unknown error",
			);
		},
	);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const waitOver = new Promise<"deadline">((resolve) => {
		timer = setTimeout(() => resolve("deadline"), waitMs);
	});
	try {
		if ((await Promise.race([attempt, waitOver])) === "deadline") {
			expired = true;
			console.warn(
				`[otta] inline order email for ${orderId} exceeded its ${waitMs} ms wait; the cron sweep will take it`,
			);
		}
	} finally {
		clearTimeout(timer);
	}
	return { configured: !unavailable, sent: [...sent], skipped: [...skipped] };
}

/**
 * The context's sender, built on FIRST SEND rather than up front — so a replay with
 * nothing due never pays its kv reads. The caller has already established that
 * this context can send (`ctx.email` is there), so a row is never claimed for a
 * sender that cannot exist. `timeoutMs` is a FUNCTION the sender asks at each send, so every
 * per-request abort is what is left of the wait when that send starts.
 */
function lazySender(ctx: PluginContext, timeoutMs: () => number): EmailSender {
	let built: Promise<EmailSender | undefined> | undefined;
	return {
		async send(input) {
			built ??= makeEmailSender(ctx, { requestTimeoutMs: timeoutMs });
			const sender = await built;
			// Unreachable while `emailSendingConfigured` and `makeEmailSender` agree; a
			// throw here is a failed send, rescheduled for the cron like any other.
			if (sender === undefined) throw new Error("email sender is not configured");
			await sender.send(input);
		},
	};
}
