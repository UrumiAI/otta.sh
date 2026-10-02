import {
	customerId as toCustomerId,
	type Email,
	type IdempotencyKey,
	type OrderId,
} from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { CustomerStore } from "../ports/customer-store.js";
import {
	type EmailSender,
	isCutShortEmailTimeout,
	isEmailSendTimeoutError,
} from "../ports/email-sender.js";
import type { OrderStore, OutboxEmail } from "../ports/order-store.js";
import type { Order, OrderState, PaymentMethod } from "./model.js";
import {
	emailTemplateForNotice,
	emailTemplateForState,
	isLegalOrderTransition,
	legalNextStates,
} from "./state-machine.js";

export interface TransitionOrderDeps {
	orderStore: OrderStore;
}

export interface TransitionOrderCommand {
	orderId: OrderId;
	toState: OrderState;
	/** Every command carries one (CLAUDE.md). NOT the dedup mechanism (review
	 *  round H4): the outbox enqueue is already deduped structurally by the
	 *  store's guarded flip + `UNIQUE(order_id, to_state)`, independent of this
	 *  key. Forwarded to `OrderStore.transition` for command-shape consistency. */
	idempotencyKey: IdempotencyKey;
}

export type TransitionOrderResult =
	| { ok: true; transitioned: boolean; order: Order }
	| { ok: false; reason: "ORDER_NOT_FOUND" | "INVALID_TRANSITION" };

/**
 * The order-status transition use-case (Phase 5 §5). Legality is enforced HERE,
 * in the domain — never in the DB or the client. Identity/authorization (who may
 * transition) is the service layer's concern (§5).
 *
 * Idempotency is two-layered and composes to "exactly one state change + exactly
 * one email" under retry/redelivery (headline case 5):
 *  - **already in `toState`** ⇒ a no-op success (`transitioned:false`), so an
 *    admin/webhook double-fire of the same target is not an `INVALID_TRANSITION`;
 *  - the store's guarded `UPDATE … WHERE state=:fromState` + the outbox
 *    `UNIQUE(order_id, to_state)` both no-op on replay.
 *
 * An out-of-table transition (e.g. `pending → shipped`) is rejected with
 * `INVALID_TRANSITION` and enqueues **zero** emails (headline case 6).
 */
export async function transitionOrder(
	deps: TransitionOrderDeps,
	cmd: TransitionOrderCommand,
): Promise<TransitionOrderResult> {
	const pre = await precheckTransition(deps, cmd);
	if (pre.done !== undefined) return pre.done;
	return applyTransition(deps, pre.order, cmd, emailTemplateForState(cmd.toState) !== null);
}

/**
 * The checks every transition use-case makes before its own rules, in ONE place so
 * `transitionOrder` and `transitionOrderAsAdmin` cannot drift: the order exists;
 * already being at the target is an idempotent no-op (a redelivery / double admin
 * call); and the move is in the state machine. `done` is the answer when one of
 * them decided it; otherwise `order` is the order to move.
 */
async function precheckTransition(
	deps: TransitionOrderDeps,
	cmd: TransitionOrderCommand,
): Promise<{ done: TransitionOrderResult; order?: never } | { done?: never; order: Order }> {
	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { done: { ok: false, reason: "ORDER_NOT_FOUND" } };
	if (order.state === cmd.toState) return { done: { ok: true, transitioned: false, order } };
	if (!isLegalOrderTransition(order.state, cmd.toState)) {
		return { done: { ok: false, reason: "INVALID_TRANSITION" } };
	}
	return { order };
}

/** The guarded flip both transition use-cases end in, once legality is settled. */
async function applyTransition(
	deps: TransitionOrderDeps,
	order: Order,
	cmd: TransitionOrderCommand,
	enqueueEmail: boolean,
): Promise<{ ok: true; transitioned: boolean; order: Order }> {
	const res = await deps.orderStore.transition({
		orderId: cmd.orderId,
		fromState: order.state,
		toState: cmd.toState,
		idempotencyKey: cmd.idempotencyKey,
		enqueueEmail,
	});
	return { ok: true, transitioned: res.transitioned, order: res.order ?? order };
}

// -- the admin's status moves -------------------------------------------------

/**
 * How each payment method's money is confirmed: by its GATEWAY (Stripe's
 * `payment_intent.succeeded`, x402's facilitator verify) or OFFLINE, by a person
 * who saw the money arrive.
 *
 * A `Record` over every `PaymentMethod` on purpose: a new method (a "bank
 * transfer" or "cash on delivery") must declare which kind it is, and only an
 * `offline` one may be marked paid by hand. None is today.
 */
const PAYMENT_METHOD_SETTLEMENT: Readonly<Record<PaymentMethod, "gateway" | "offline">> = {
	stripe: "gateway",
	x402: "gateway",
};

/**
 * True iff an admin may mark an order paid by `method` BY HAND — only a method
 * declared `offline`. FAILS CLOSED: a gateway method is paid when its gateway says
 * so (the settle path's `markPaid`), and an order with NO method on file (`null`, a
 * historical or hand-seeded order) has nothing that could have been paid, so it is
 * refused too. With no offline method declared today, this is always false.
 */
export function manualPaymentAllowed(method: PaymentMethod | null): boolean {
	if (method === null) return false;
	return PAYMENT_METHOD_SETTLEMENT[method] === "offline";
}

/**
 * The status moves the admin console may OFFER for an order: the state machine's
 * legal moves, minus a manual `paid` that {@link manualPaymentAllowed} refuses and
 * minus `cancelled`, which an admin reaches only through Cancel order. Read by the
 * console instead of `legalNextStates`, so it never renders a button
 * {@link transitionOrderAsAdmin} would refuse.
 */
export function adminNextStates(order: Pick<Order, "state" | "paymentMethod">): OrderState[] {
	return legalNextStates(order.state).filter(
		(to) => !(to === "paid" && !manualPaymentAllowed(order.paymentMethod)) && to !== "cancelled",
	);
}

export type TransitionOrderAsAdminResult =
	| TransitionOrderResult
	/** `pending → paid` asked for an order whose payment method is not declared
	 *  offline — its gateway settles it, or there is no method to settle at all. */
	| { ok: false; reason: "MANUAL_PAYMENT_NOT_ALLOWED" }
	/** A bare `→ cancelled` — Cancel order is the admin's only way to cancel. */
	| { ok: false; reason: "USE_CANCEL" };

/** Every reason `transitionOrderAsAdmin` can refuse with — the closed set a caller
 *  maps to copy. */
export type TransitionOrderAsAdminFailure = Extract<
	TransitionOrderAsAdminResult,
	{ ok: false }
>["reason"];

/**
 * A status move made BY HAND in the admin console. It is {@link transitionOrder} —
 * the same legality, the same idempotent no-op, the same guarded flip — with three
 * rules that keep a manual move honest about money (QA T1-3, T1-4, T1-6;
 * ADR-0026):
 *
 *  - **No manual `pending → paid` unless the method is declared offline** — none is
 *    today, so never. A card order is paid when Stripe says so, through the settle
 *    path's `markPaid`. A click here could otherwise tell the buyer "we've received
 *    your payment", count revenue in the reports and release the order for
 *    fulfilment with nothing captured.
 *  - **No bare `→ cancelled`, from any state.** It records no reason, releases no
 *    adopted stock hold (only the expiry flip records a release intent), sends a
 *    reasonless "cancelled" email, and on a paid order keeps the money silently
 *    (QA T1-4). Cancel order — the store's `cancelOrder`, which records the reason
 *    and the release intent — is the admin's one way to cancel. (It does not refund
 *    a paid order: that is Money → Refunds.)
 *  - **`→ refunded` emails nobody.** A manual Mark refunded moves no money — it
 *    records a refund made OUTSIDE Otta (the Stripe dashboard, a bank transfer) —
 *    so it must not send the buyer "your order has been refunded" on Otta's word.
 *    Money moved through `refundOrder` emails the buyer from the ledger write.
 *
 * All three are refused in the domain, so a hand-made request is refused exactly
 * as the console's missing button implies.
 *
 * WHY A SEPARATE USE-CASE rather than a flag on `transitionOrder`: `transitionOrder`
 * is the generic state-machine command every suite drives orders through, and
 * these are rules about who is acting, not about the machine. The admin console is
 * the only production caller of either.
 */
export async function transitionOrderAsAdmin(
	deps: TransitionOrderDeps,
	cmd: TransitionOrderCommand,
): Promise<TransitionOrderAsAdminResult> {
	const pre = await precheckTransition(deps, cmd);
	if (pre.done !== undefined) return pre.done;
	const order = pre.order;
	if (cmd.toState === "paid" && !manualPaymentAllowed(order.paymentMethod)) {
		return { ok: false, reason: "MANUAL_PAYMENT_NOT_ALLOWED" };
	}
	if (cmd.toState === "cancelled") return { ok: false, reason: "USE_CANCEL" };
	const enqueueEmail = cmd.toState !== "refunded" && emailTemplateForState(cmd.toState) !== null;
	return applyTransition(deps, order, cmd, enqueueEmail);
}

// -- outbox dispatcher --------------------------------------------------------

export interface DispatchOrderEmailsDeps {
	orderStore: OrderStore;
	emailSender: EmailSender;
	/** Optional: resolve a linked customer's email; guest orders fall back to
	 *  `buyerRef` (the email captured at checkout). */
	customerStore?: CustomerStore;
	clock: Clock;
}

export interface DispatchOrderEmailsOptions {
	/** How long a claim holds a row before a crashed run's row is reclaimable. */
	leaseMs?: number;
	/** Retries before a row is parked `failed`. */
	maxAttempts?: number;
	/** Safety cap on rows drained per invocation. */
	batchLimit?: number;
	/**
	 * Asked before each CLAIM; `false` ends the drain. The plugin's cron tick runs
	 * this inside a host hook with a hard timeout, and passes its time budget here.
	 * The check sits before the claim, never after it, because a row claimed and
	 * then abandoned stays leased — unsent — for the whole lease, while an
	 * unclaimed row simply goes out on the next tick.
	 */
	shouldContinue?: () => boolean;
	/**
	 * Asked once more just BEFORE the send — after the claim and the order and
	 * customer reads, which take time of their own. `false` hands the claimed row
	 * back untried (`releaseEmailClaim`, the attempt not counted) and ends the
	 * drain. Default: always send.
	 */
	canSend?: () => boolean;
	/**
	 * Called for each timeout PAST `maxUncountedTimeouts` on a row — the point at
	 * which "slow" has become "not working", so the caller can raise an alert (the
	 * plugin logs it with `console.error`). From then on each timeout also counts
	 * as an attempt, so the row parks with reason "provider kept timing out".
	 */
	onRepeatedTimeouts?: (row: { id: string; orderId: OrderId; timeouts: number }) => void;
	/** Uncounted timeouts a row is allowed. Default: {@link MAX_UNCOUNTED_TIMEOUTS}. */
	maxUncountedTimeouts?: number;
}

export interface DispatchOrderEmailsForOrderOptions extends DispatchOrderEmailsOptions {
	/** Claim only rows no dispatcher has tried yet — see
	 *  `OrderStore.claimNextEmailForOrder`. The inline path's setting: at most one
	 *  COUNTED attempt per row from there (a cut-short attempt is uncounted and may
	 *  recur), never a row the cron has backed off; `maxAttempts` is unchanged. */
	onlyUnattempted?: boolean;
}

/**
 * A timed-out row is retried after a backoff: one minute, doubling per timeout,
 * capped at fifteen. Forward, so the row goes BEHIND the other due rows instead
 * of being claimed first again on the next run — one stuck row must not stall
 * the queue.
 */
export const TIMEOUT_BACKOFF_BASE_MS = 60_000;
export const TIMEOUT_BACKOFF_MAX_MS = 15 * 60_000;

/** Timeouts a row may take uncounted. Past this a provider is not slow but not
 *  working, and continuing to retry for free would hide that forever. */
export const MAX_UNCOUNTED_TIMEOUTS = 10;

/** The backoff after a row's `timeouts`-th timeout. */
export function timeoutBackoffMs(timeouts: number): number {
	const doublings = Math.max(0, timeouts - 1);
	return Math.min(TIMEOUT_BACKOFF_MAX_MS, TIMEOUT_BACKOFF_BASE_MS * 2 ** Math.min(doublings, 20));
}

/**
 * How long a row the dispatcher claimed but could not TRY (its caller was out of
 * time before the send) waits before it is due again. Short, because nothing is
 * wrong with the row; but forward, so that a run short of time cannot hand the
 * same row back to the head of the queue every time and keep the rows behind it
 * from a run that does have time.
 */
export const UNTRIED_RETRY_MS = 30_000;

/** The reason a row parked by repeated timeouts carries. */
export const TIMEOUT_FAILURE_REASON = "provider kept timing out";

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_LIMIT = 100;
/** The per-order cap. The outbox holds at most one state row per `(order, toState)`
 *  (the UNIQUE the stores enforce) plus at most one notice row per `(order, kind)`
 *  (`enqueueNotice`'s first-wins), so an order can never have more due rows than
 *  there are templated states + notices; this is a safety bound that is never the
 *  reason a drain stops in practice. */
const DEFAULT_ORDER_BATCH_LIMIT = 10;

/**
 * The outbox dispatcher (Phase 5 §5 step 2–3 / §8 5.8), reusing the Phase-3
 * hold-expiry cron pattern. Claims pending rows atomically (only one runner wins
 * a claim — concurrent runs can't claim the same row at once), renders + sends
 * each, then marks it `sent`. A send failure returns the row to `pending` for a
 * later tick (or parks it `failed` after `maxAttempts`) — durable retry WITHOUT
 * re-running the state transition itself. Note: claim is exactly-once but
 * delivery is only at-least-once — a crash after `send()` but before the row is
 * marked sent lets the lease lapse and the row be re-claimed and re-sent; dedup
 * to effectively-once relies on the provider's `Idempotency-Key` (§6,
 * `HttpEmailSender`). Returns the number of emails actually sent.
 */
export async function dispatchOrderEmails(
	deps: DispatchOrderEmailsDeps,
	options: DispatchOrderEmailsOptions = {},
): Promise<number> {
	return drainOutbox(deps, options, DEFAULT_BATCH_LIMIT, (nowIso, leaseUntil) =>
		deps.orderStore.claimNextEmail(nowIso, leaseUntil),
	);
}

/**
 * The outbox dispatcher narrowed to ONE order — what the payment-settle route calls
 * inline so a just-paid order's confirmation goes out with the settlement rather than
 * on the next cron tick (ADR-0005's 2026-10-02 amendment).
 *
 * It is {@link dispatchOrderEmails} with a different CLAIM and nothing else: the same
 * send (state emails and notices alike), the same `markEmailSent`, the same
 * `shouldContinue` / `canSend` checks, the same timeout handling (a cut-short send
 * released uncounted and due at once; a genuine timeout backed off, counted past the
 * limit) and the same reschedule-or-park on failure, with the same `Idempotency-Key`
 * (the row id) — so an inline send and a later cron re-send of the same row dedupe
 * provider-side exactly as two cron ticks do. The claim is `claimNextEmailForOrder`,
 * which can never take another order's row: a request must not run the global
 * drain, which walks the whole queue and is the cron's job.
 *
 * Best-effort by contract, not by hope: the cron leg remains the at-least-once
 * backstop. A failed send here is rescheduled to `leaseUntil` like any other — so a
 * caller passing a SHORT `leaseMs` is also choosing how soon the backstop may retry.
 */
export async function dispatchOrderEmailsForOrder(
	deps: DispatchOrderEmailsDeps,
	orderId: OrderId,
	options: DispatchOrderEmailsForOrderOptions = {},
): Promise<number> {
	const claimOptions = options.onlyUnattempted === true ? { onlyUnattempted: true } : {};
	return drainOutbox(deps, options, DEFAULT_ORDER_BATCH_LIMIT, (nowIso, leaseUntil) =>
		deps.orderStore.claimNextEmailForOrder(orderId, nowIso, leaseUntil, claimOptions),
	);
}

/**
 * The one dispatch body both dispatchers share. Only the claim differs between them,
 * and it is the only thing passed in, so the two cannot drift on retry, timeout,
 * notice-rendering or dedupe semantics.
 */
async function drainOutbox(
	deps: DispatchOrderEmailsDeps,
	options: DispatchOrderEmailsOptions,
	defaultBatchLimit: number,
	claim: (nowIso: string, leaseUntil: string) => Promise<OutboxEmail | null>,
): Promise<number> {
	const now = deps.clock.now();
	const nowIso = now.toISOString();
	const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const batchLimit = options.batchLimit ?? defaultBatchLimit;

	let sent = 0;
	for (let i = 0; i < batchLimit; i++) {
		if (options.shouldContinue !== undefined && !options.shouldContinue()) break;
		const row = await claim(nowIso, leaseUntil);
		if (row === null) break;

		// A NOTICE row (`enqueueNotice`) renders its own template; every other row is
		// a state email keyed by the state it announces. `toState` on a notice row is
		// only the state the order was in when it was enqueued — never the template.
		const template =
			row.notice !== null
				? emailTemplateForNotice(row.notice.kind)
				: emailTemplateForState(row.toState);
		const order = await deps.orderStore.getById(row.orderId);
		// A row with no template (defensive) or a vanished order can never be
		// delivered — mark it done so it doesn't wedge the queue.
		if (template === null || order === null) {
			await deps.orderStore.markEmailSent(row.id, nowIso);
			continue;
		}

		if (options.canSend !== undefined && !options.canSend()) {
			await deps.orderStore.releaseEmailClaim(row.id, {
				retryAt: new Date(now.getTime() + UNTRIED_RETRY_MS).toISOString(),
			});
			break;
		}

		// The money a refund email is about: a notice carries its own; the `refunded`
		// STATE email states everything finalized on the ledger (QA T1-6), read here
		// and passed as data so the template still reaches back into nothing.
		const refunded =
			row.notice !== null
				? { amount: row.notice.amount, currency: row.notice.currency }
				: row.toState === "refunded"
					? await refundedTotal(deps.orderStore, order)
					: null;

		try {
			await deps.emailSender.send({
				to: await resolveRecipient(deps, order),
				template,
				data:
					refunded === null
						? buildOrderEmailData(order, row.toState)
						: {
								...buildOrderEmailData(order, row.toState),
								// The OWN figure — the money refunded, never the order total
								// it may differ from.
								noticeAmountCents: refunded.amount,
								noticeCurrency: refunded.currency,
							},
				idempotencyKey: row.id,
			});
			await deps.orderStore.markEmailSent(row.id, nowIso);
			sent++;
		} catch (err) {
			// A send cut off by the CALLER's timeout is not a failed attempt: hand the
			// row back uncounted, and stop — the time is gone, and re-claiming the
			// same row inside this drain would only time out again.
			// Cut short by the CALLER (given less than its full allowance): not the
			// provider's doing, so no backoff and no timeout recorded — due at once.
			if (isCutShortEmailTimeout(err)) {
				await deps.orderStore.releaseEmailClaim(row.id);
				break;
			}
			if (isEmailSendTimeoutError(err)) {
				const timeouts = row.timeouts + 1;
				const retryAt = new Date(now.getTime() + timeoutBackoffMs(timeouts)).toISOString();
				if (timeouts <= (options.maxUncountedTimeouts ?? MAX_UNCOUNTED_TIMEOUTS)) {
					// Uncounted, but BACKED OFF: forward, behind every other due row.
					await deps.orderStore.releaseEmailClaim(row.id, { retryAt, timedOut: true });
				} else {
					// Past the limit: reported, and counted like any failed attempt (the
					// claim already counted it), parking the row with its own reason.
					options.onRepeatedTimeouts?.({ id: row.id, orderId: row.orderId, timeouts });
					await deps.orderStore.rescheduleEmail(
						row.id,
						row.attempts >= maxAttempts ? null : retryAt,
						TIMEOUT_FAILURE_REASON,
					);
				}
				break;
			}
			// row.attempts already counts this attempt (incremented on claim). Back
			// off to `leaseUntil` (a future time) so the row is retried on the NEXT
			// tick, not re-picked within this same drain loop; park it `failed` once
			// retries are exhausted.
			await deps.orderStore.rescheduleEmail(
				row.id,
				row.attempts >= maxAttempts ? null : leaseUntil,
			);
		}
	}
	return sent;
}

/** Everything finalized on the order's refund ledger, or null when nothing is. */
async function refundedTotal(
	orderStore: OrderStore,
	order: Order,
): Promise<{ amount: number; currency: string } | null> {
	let total = 0;
	for (const r of await orderStore.listRefunds(order.id))
		if (r.status === "recorded") total += r.amount;
	return total === 0 ? null : { amount: total, currency: order.totals.currency };
}

async function resolveRecipient(deps: DispatchOrderEmailsDeps, order: Order): Promise<Email> {
	if (order.customerId !== null && deps.customerStore !== undefined) {
		const customer = await deps.customerStore.get(toCustomerId(order.customerId));
		if (customer !== null) return customer.email;
	}
	// Guest order: the email captured at checkout (buyerRef). Branded without
	// re-validating — it was accepted at checkout and is not re-parsed here.
	return order.buyerRef as Email;
}

/** Template data, rendered from order fields passed explicitly — no template
 *  reaches back into a store (§6). */
export function buildOrderEmailData(order: Order, toState: OrderState): Record<string, unknown> {
	return {
		orderId: order.id,
		state: toState,
		currency: order.totals.currency,
		totalCents: order.totals.total,
		lines: order.lines.map((l) => ({
			sku: l.sku,
			title: l.title,
			quantity: l.quantity,
			unitPriceCents: l.unitPrice,
		})),
		// Tracking travels with the data (never a store reach-back, §6) so the
		// shipped template renders it — the whole point of the fulfillment slice is a
		// shipped email that carries tracking instead of being empty. Present only
		// once the order has been fulfilled; the shipped email is the natural
		// consumer, but any later transition's data carries it harmlessly too.
		...(order.fulfillment !== null
			? {
					fulfillment: {
						carrier: order.fulfillment.carrier,
						trackingNumber: order.fulfillment.trackingNumber,
						trackingUrl: order.fulfillment.trackingUrl,
						shippedAt: order.fulfillment.shippedAt,
					},
				}
			: {}),
		// Same rationale as fulfillment above: the cancellation travels with the
		// data (never a store reach-back, §6). NOTE the customer-safety contract:
		// the service renderer applies an explicit CUSTOMER-SAFE allowlist to this
		// — only safe reasons (customer_request / out_of_stock) ever produce a
		// reason line in the buyer's email; sensitive ones (fraud_suspected /
		// pricing_error / other) and the admin `detail` never reach the rendered
		// email (they stay admin-only, on the order detail page). Present only when
		// cancelOrder recorded one (admin-UX Increment 1) — a bare-transition
		// cancellation carries none.
		...(order.cancellation !== null
			? {
					cancellation: {
						reason: order.cancellation.reason,
						detail: order.cancellation.detail,
						// The money the cancellation returned (QA T1-4), so the email can say a
						// refund is on its way and for how much. Null when nothing was refunded.
						refund:
							order.cancellation.refund == null
								? null
								: {
										amountCents: order.cancellation.refund.amount,
										currency: order.cancellation.refund.currency,
									},
					},
				}
			: {}),
	};
}
