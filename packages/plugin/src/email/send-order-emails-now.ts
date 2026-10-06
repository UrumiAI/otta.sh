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
 *  - its timeouts are CUT SHORT — an inline send gets less than the sweep's full
 *    allowance, so a timeout is released uncounted for the cron and never recorded
 *    against the provider;
 *  - it is CHEAP when there is nothing to do — the sender (two kv reads) is built
 *    only once a row has been claimed, so a replay costs one read of the order;
 *  - it makes the FIRST ATTEMPT ONLY — it claims a row no dispatcher has tried
 *    (`onlyUnattempted`), so it makes at most one COUNTED attempt per row and every
 *    counted retry is the cron's; the total budget (`maxAttempts`) is unchanged.
 *    Repeated Stripe redeliveries during a provider outage therefore cannot
 *    spend it and park the confirmation `failed` within minutes. A
 *    cut-short inline attempt is uncounted and may recur on a later delivery before
 *    the sweep takes the row; the `Idempotency-Key` dedupes it.
 *
 * WHY ONLY THIS ORDER'S ROWS. `dispatchOrderEmails` drains the whole queue, up to
 * 100 rows across every order — a cron's job, not a request's. The order-scoped
 * `dispatchOrderEmailsForOrder` claims via `claimNextEmailForOrder`: one read of one
 * order document and one compare-and-set, so the request pays for its own order and
 * nothing else.
 *
 * WHY THIS IS SAFE AGAINST THE CRON RUNNING AT THE SAME TIME. The claim is the same
 * single-winner compare-and-set the cron's claim is (ADR-0005 already allows
 * concurrent dispatchers), so at most one of them holds a row at a time; and the
 * provider `Idempotency-Key` is the row id on both paths, which dedupes the
 * at-least-once tail (a send accepted but not yet marked when the request died).
 */
import {
	dispatchOrderEmailsForOrder,
	EmailSendTimeoutError,
	isCutShortEmailTimeout,
	isEmailSendTimeoutError,
	type Clock,
	type CustomerStore,
	type EmailSender,
	type OrderId,
	type OrderStore,
	type OutboxEmail,
} from "@otta-sh/domain";
import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import { settleDeadline, type SettleDeadline } from "../settle-deadline.js";
import type { PluginContext } from "../types.js";
import {
	emailSenderConfigured,
	LOGIN_EMAIL_TIMEOUT_MS,
	makeEmailSender,
	type EmailSenderEgress,
} from "./ctx-http-email-sender.js";

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
 * would let a cron tick reclaim a row a live request is still sending — harmless,
 * the Idempotency-Key dedupes it, but pointless). It is also the backoff a FAILED
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
	 * built from the context and {@link egress} with the inline ceiling, lazily.
	 */
	emailSender?: EmailSender;
	/** The build-time email URL. Default: this bundle's resolved define. */
	egress?: EmailSenderEgress;
	/** The request's ONE deadline (`settle-deadline.ts`), fixed as the route started
	 *  and shared with its other slow steps. Default: a fresh one, starting here. */
	deadline?: SettleDeadline;
}

/**
 * What an inline attempt did — so a caller that tells a person "the buyer has been
 * emailed" (the admin console, QA T1-6) can say it only when it is true.
 *
 * `configured: false` ⇒ this bundle has no email provider: nothing was or will be
 * sent. Otherwise `sent` lists every row this attempt delivered, in order; a row it
 * did not deliver (a failed send, the wait running out, a spent budget) is not
 * there and is the cron's to send. A row sent AFTER the wait ran out is not listed
 * either — the conservative direction for a caller reporting it.
 */
export interface InlineOrderEmails {
	readonly configured: boolean;
	readonly sent: readonly OutboxEmail[];
}

/**
 * Dispatch `orderId`'s due, never-attempted outbox emails now. Resolves (never
 * rejects) once they are sent, have failed and been rescheduled for the cron, the
 * wait has run out, or there was nothing to do — with what it sent. A bundle with no
 * email API URL is a quiet no-op — the cron leg reports that configuration as
 * `skipped`; a per-request log line would only be noise.
 */
export async function sendOrderEmailsNow(
	ctx: PluginContext,
	stores: OrderEmailStores,
	orderId: OrderId,
	options: SendOrderEmailsNowOptions = {},
): Promise<InlineOrderEmails> {
	// Configured-ness FIRST, and quietly: with no sender the cron leg reports `skipped`
	// as well, so a "the cron sweep will deliver it" line below would be false.
	const egress = options.egress ?? { apiUrl: IN_PROCESS_EGRESS_URLS.emailApiUrl };
	if (options.emailSender === undefined && !emailSenderConfigured(egress)) {
		return { configured: false, sent: [] };
	}
	const sent: OutboxEmail[] = [];

	const deadline = options.deadline ?? settleDeadline();
	const waitMs = Math.min(ORDER_EMAIL_INLINE_DEADLINE_MS, deadline.remainingMs());
	if (waitMs <= 0) {
		console.warn(
			`[otta] inline order email for ${orderId} skipped: the settle used the request's time budget; the cron sweep will deliver it`,
		);
		return { configured: true, sent: [] };
	}
	// The inline wait's own end — at most the request's deadline, sooner when the
	// 5 s inline cap is the tighter of the two.
	const waitEndsAt = deadline.now() + waitMs;
	// What is left of the wait WHEN EACH SEND STARTS — the claim and the reads before
	// it may have used most of it — capped at the inline ceiling, never below 1 ms.
	const sendTimeoutMs = (): number =>
		Math.max(1, Math.min(ORDER_EMAIL_INLINE_TIMEOUT_MS, waitEndsAt - deadline.now()));

	const emailSender = cutShortTimeouts(
		options.emailSender ?? lazySender(ctx, egress, sendTimeoutMs),
	);

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
				`[otta] inline order email for ${orderId} exceeded its ${waitMs} ms wait; the cron sweep will deliver it`,
			);
		}
	} finally {
		clearTimeout(timer);
	}
	return { configured: true, sent: [...sent] };
}

/**
 * The context's sender, built on FIRST SEND rather than up front — so a replay with
 * nothing due never pays its two kv reads. The caller has already established that
 * this bundle has an email API URL (`emailSenderConfigured`, the predicate
 * `makeEmailSender` applies), so a row is never claimed for a sender that cannot
 * exist. `timeoutMs` is a FUNCTION the sender asks at each send, so every
 * per-request abort is what is left of the wait when that send starts.
 */
function lazySender(
	ctx: PluginContext,
	egress: EmailSenderEgress,
	timeoutMs: () => number,
): EmailSender {
	let built: Promise<EmailSender | undefined> | undefined;
	return {
		async send(input) {
			built ??= makeEmailSender(ctx, egress, { requestTimeoutMs: timeoutMs });
			const sender = await built;
			// Unreachable while `emailSenderConfigured` and `makeEmailSender` agree; a
			// throw here is a failed send, rescheduled for the cron like any other.
			if (sender === undefined) throw new Error("email sender is not configured");
			await sender.send(input);
		},
	};
}

/**
 * Every inline timeout is CUT SHORT. The sweep gives a send its full allowance
 * (`SWEEP_EMAIL_SEND_TIMEOUT_MS`) and treats a timeout there as the provider's
 * doing — backed off, recorded, counted past a limit. An inline send gets less (3 s,
 * and less still near the request's deadline), so its timeout says nothing about
 * the provider: re-marked `cutShort`, the drain releases the row uncounted and due
 * at once, and the cron sends it with the full allowance. Exported for its test.
 */
export function cutShortTimeouts(sender: EmailSender): EmailSender {
	return {
		async send(input) {
			try {
				await sender.send(input);
			} catch (err) {
				if (isEmailSendTimeoutError(err) && !isCutShortEmailTimeout(err)) {
					// The original allowance, kept; only a bridged copy that dropped the field
					// falls back to the inline ceiling (the most it could have been given).
					throw new EmailSendTimeoutError(err.timeoutMs ?? ORDER_EMAIL_INLINE_TIMEOUT_MS, {
						cutShort: true,
					});
				}
				throw err;
			}
		},
	};
}
