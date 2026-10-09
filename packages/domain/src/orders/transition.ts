import {
	customerId as toCustomerId,
	isEmailAddress,
	type Email,
	type IdempotencyKey,
	type OrderId,
} from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { CustomerStore } from "../ports/customer-store.js";
import type { EntitlementStore } from "../ports/entitlement-store.js";
import {
	type EmailSender,
	isCutShortEmailTimeout,
	isEmailSendTimeoutError,
	isEmailTransportUnavailableError,
} from "../ports/email-sender.js";
import type { OrderStore, OutboxEmail } from "../ports/order-store.js";
import type { Order, OrderState, PaymentMethod } from "./model.js";
import { orderTotalLabel } from "./order-total-label.js";
import {
	capturedOnlyThroughLegacy,
	isCurrentPaymentMethod,
	legacyFact,
	type LegacyMethodFacts,
} from "./payment-methods.js";
import { roundingEntry } from "../pricing/payment-rounding.js";
import { PROVIDER_REFUNDED_FLAG_PREFIX } from "./provider-refunded-flag.js";
import { readOrderTaxSnapshot } from "./order-tax-snapshot.js";
import { sumFinalizedRefunds } from "./refund-order.js";
import { revokeOrderEntitlements } from "./revoke-entitlements.js";
import {
	emailTemplateForNotice,
	emailTemplateForState,
	isLegalOrderTransition,
	legalNextStates,
} from "./state-machine.js";

export interface TransitionOrderDeps {
	orderStore: OrderStore;
	/**
	 * Revokes the order's download entitlements when a move lands it `refunded`
	 * (Mark refunded — money returned in full outside Otta; issue #376). Run after
	 * the flip is recorded, and on the already-`refunded` replay too, so a crash in
	 * between is finished by the retry. Optional: suites that drive the state machine
	 * need not wire it; the admin console's composition does, and a test pins it.
	 */
	entitlementStore?: EntitlementStore;
}

export interface TransitionOrderCommand {
	orderId: OrderId;
	toState: OrderState;
	/** Every command carries one (CLAUDE.md). NOT the dedup mechanism (review
	 *  round H4): the outbox enqueue is already deduped structurally by the
	 *  store's guarded flip + `UNIQUE(order_id, to_state)`, independent of this
	 *  key. Forwarded to `OrderStore.transition` for command-shape consistency. */
	idempotencyKey: IdempotencyKey;
	/** Who made the move, recorded on its audit event — the admin console passes
	 *  the signed-in operator (QA2: History showed "—"). Absent ⇒ no actor, as
	 *  for a flip no person made. */
	actor?: string;
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
	const res =
		pre.done ??
		(await applyTransition(deps, pre.order, cmd, emailTemplateForState(cmd.toState) !== null));
	await revokeIfRefunded(deps, res);
	return res;
}

/**
 * A move that leaves the order `refunded` — fresh, or the idempotent replay of one
 * already there — revokes its download access (see `revoke-entitlements.ts`).
 * Mark refunded is only allowed when nothing is left for the provider to return
 * ({@link markRefundedAllowed}), so `refunded` here means the money went back in
 * full. Runs after the flip is recorded; the replay finishes a crash in between.
 */
async function revokeIfRefunded(
	deps: TransitionOrderDeps,
	res: { ok: boolean; order?: Order },
): Promise<void> {
	if (res.ok && res.order !== undefined && res.order.state === "refunded") {
		await revokeOrderEntitlements(deps.entitlementStore, res.order);
	}
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
		...(cmd.actor !== undefined && cmd.actor.trim().length > 0 ? { actor: cmd.actor.trim() } : {}),
	});
	return { ok: true, transitioned: res.transitioned, order: res.order ?? order };
}

// -- the admin's status moves -------------------------------------------------

/**
 * How each payment method's money is confirmed: by its GATEWAY (Stripe's
 * `payment_intent.succeeded`) or OFFLINE, by a person
 * who saw the money arrive.
 *
 * A `Record` over every `PaymentMethod` on purpose: a new method (a "bank
 * transfer" or "cash on delivery") must declare which kind it is, and only an
 * `offline` one may be marked paid by hand. None is today.
 */
const PAYMENT_METHOD_SETTLEMENT: Readonly<Record<PaymentMethod, "gateway" | "offline">> = {
	stripe: "gateway",
};

/**
 * A per-method fact for a STORED method: from the current table when the method
 * is a `PaymentMethod`, else from its `LEGACY_PAYMENT_METHODS` entry, else
 * `undefined` — an unknown method, which every caller treats as fail-closed.
 */
function factForStored<K extends keyof LegacyMethodFacts, V>(
	table: Readonly<Record<PaymentMethod, V>>,
	stored: string,
	field: K,
): V | LegacyMethodFacts[K] | undefined {
	return isCurrentPaymentMethod(stored) ? table[stored] : legacyFact(stored, field);
}

/**
 * True iff an admin may mark an order paid by `method` BY HAND — only a method
 * declared `offline`. FAILS CLOSED: a gateway method is paid when its gateway says
 * so (the settle path's `markPaid`), and an order with NO method on file (`null`, a
 * historical or hand-seeded order) has nothing that could have been paid, so it is
 * refused too. With no offline method declared today, this is always false.
 */
export function manualPaymentAllowed(method: PaymentMethod | null): boolean {
	if (method === null) return false;
	// A legacy method is settled by its (removed) gateway; an unknown one has no
	// entry. Neither is offline.
	return factForStored(PAYMENT_METHOD_SETTLEMENT, method, "settlement") === "offline";
}

/**
 * How each payment method's money goes BACK: through its PROVIDER (a Stripe refund,
 * which Money → Refunds issues and records on the ledger) or OUTSIDE Otta (a method
 * that cannot refund automatically; the operator sends the money and records it). A
 * `Record` over every method, like {@link PAYMENT_METHOD_SETTLEMENT}, so a new
 * method must say which it is.
 */
const PAYMENT_METHOD_REFUNDS: Readonly<Record<PaymentMethod, "provider" | "outside">> = {
	stripe: "provider",
};

/**
 * How a STORED method's money goes back. The stored value is read as a `string`,
 * not trusted as a `PaymentMethod`: an order placed before a method was removed
 * (a legacy x402 order) still carries it, and its `LEGACY_PAYMENT_METHODS`
 * entry says `outside`. A method that is neither current nor named legacy is
 * `undefined`: NOT outside, so Mark refunded goes through the captured-money check.
 */
function refundRouteOf(stored: string): "provider" | "outside" | undefined {
	return factForStored(PAYMENT_METHOD_REFUNDS, stored, "refunds");
}

/** The two ledgers Mark refunded is decided from. */
export interface RefundLedgerFacts {
	/** `gateway`: the method the payment came through. Absent reads as NOT a
	 *  legacy method (fail-closed: see {@link markRefundedRefusal}). */
	payments: readonly { amount: number; status: string; gateway?: string }[];
	refunds: readonly { amount: number; status: string }[];
}

/**
 * Captured money the refunds ledger has not returned: `succeeded` payments less
 * RECORDED refunds only. A reserved or unverified row is a promise, not money
 * back (it may still void — review round 1). Never below zero.
 */
export function unrefundedCapturedCents(facts: RefundLedgerFacts): number {
	let captured = 0;
	for (const p of facts.payments) if (p.status === "succeeded") captured += p.amount;
	let returned = 0;
	for (const r of facts.refunds) if (r.status === "recorded") returned += r.amount;
	return Math.max(0, captured - returned);
}

/**
 * Why an admin may NOT mark this order refunded, or `null` when they may:
 *  - `REFUND_IN_FLIGHT` — a refund on the ledger is still reserved or unverified:
 *    its outcome decides whether money is still held, so it is resolved first
 *    (the cancel path's rule);
 *  - `REFUND_THROUGH_MONEY` — captured money its provider can still return
 *    ({@link markRefundedAllowed}).
 */
export function markRefundedRefusal(
	order: Pick<Order, "paymentMethod" | "reconciliationFlag">,
	facts: RefundLedgerFacts,
): "REFUND_IN_FLIGHT" | "REFUND_THROUGH_MONEY" | null {
	if (facts.refunds.some((r) => r.status === "reserved" || r.status === "unverified")) {
		return "REFUND_IN_FLIGHT";
	}
	// The `outside` shortcut holds only while every captured payment came through a
	// named legacy method too: money a current provider captured (a Stripe payment
	// on an order that somehow stores x402) still goes through the check below.
	if (
		order.paymentMethod !== null &&
		refundRouteOf(order.paymentMethod) === "outside" &&
		capturedOnlyThroughLegacy(facts.payments)
	) {
		return null;
	}
	if (unrefundedCapturedCents(facts) === 0) return null;
	return order.reconciliationFlag?.startsWith(PROVIDER_REFUNDED_FLAG_PREFIX) === true
		? null
		: "REFUND_THROUGH_MONEY";
}

/**
 * May an admin MARK this order refunded — a status move that moves no money? Only
 * where that cannot hide money still held (QA2 M4: a shipped Stripe order with
 * $6.50 captured was closed as "refunded" and its buyer's page said so):
 *  - its method returns money OUTSIDE Otta, so a refund made there is
 *    exactly what this records; or
 *  - the ledger shows NOTHING left to refund through the provider; or
 *  - the provider itself reported the payment refunded IN FULL — the flag
 *    `refundOrder` writes on that pre-flight answer
 *    ({@link PROVIDER_REFUNDED_FLAG_PREFIX}): the refund was made outside Otta, in
 *    the provider's dashboard. A partial one never unlocks it.
 * And never while a refund on the ledger is still reserved or unverified
 * (`REFUND_IN_FLIGHT`, {@link markRefundedRefusal}).
 * Otherwise the money goes back through Money → Refunds, which returns it and
 * emails the buyer.
 */
export function markRefundedAllowed(
	order: Pick<Order, "paymentMethod" | "reconciliationFlag">,
	facts: RefundLedgerFacts,
): boolean {
	return markRefundedRefusal(order, facts) === null;
}

/**
 * The status moves the admin console may OFFER for an order: the state machine's
 * legal moves, minus a manual `paid` that {@link manualPaymentAllowed} refuses,
 * minus `cancelled`, which an admin reaches only through Cancel order, and minus
 * `refunded` where {@link markRefundedAllowed} says money is still held. Read by
 * the console instead of `legalNextStates`, so it never renders a button
 * {@link transitionOrderAsAdmin} would refuse.
 */
export function adminNextStates(
	order: Pick<Order, "state" | "paymentMethod" | "reconciliationFlag">,
	facts: RefundLedgerFacts,
): OrderState[] {
	return legalNextStates(order.state).filter(
		(to) =>
			!(to === "paid" && !manualPaymentAllowed(order.paymentMethod)) &&
			to !== "cancelled" &&
			!(to === "refunded" && !markRefundedAllowed(order, facts)),
	);
}

export type TransitionOrderAsAdminResult =
	| TransitionOrderResult
	/** `pending → paid` asked for an order whose payment method is not declared
	 *  offline — its gateway settles it, or there is no method to settle at all. */
	| { ok: false; reason: "MANUAL_PAYMENT_NOT_ALLOWED" }
	/** A bare `→ cancelled` — Cancel order is the admin's only way to cancel. */
	| { ok: false; reason: "USE_CANCEL" }
	/** Mark refunded on an order whose captured money the ledger has not returned
	 *  through its provider ({@link markRefundedAllowed}): use Money → Refunds. */
	| { ok: false; reason: "REFUND_THROUGH_MONEY" }
	/** Mark refunded while a refund on the order is still reserved or unverified. */
	| { ok: false; reason: "REFUND_IN_FLIGHT" };

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
 *  - **`→ refunded` emails nobody, and only closes money that is not still held.**
 *    A manual Mark refunded moves no money — it records a refund made OUTSIDE Otta
 *    (the Stripe dashboard, a bank transfer) — so it must not send the buyer "your
 *    order has been refunded" on Otta's word, and it is refused
 *    (`REFUND_THROUGH_MONEY`) where {@link markRefundedAllowed} says the ledger
 *    still holds captured money its provider can return (QA2 M4). Money moved
 *    through `refundOrder` emails the buyer from the ledger write.
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
	if (pre.done !== undefined) {
		await revokeIfRefunded(deps, pre.done);
		return pre.done;
	}
	const order = pre.order;
	if (cmd.toState === "paid" && !manualPaymentAllowed(order.paymentMethod)) {
		return { ok: false, reason: "MANUAL_PAYMENT_NOT_ALLOWED" };
	}
	if (cmd.toState === "cancelled") return { ok: false, reason: "USE_CANCEL" };
	if (cmd.toState === "refunded") {
		// The one admin move decided by the money: read the ledgers (only for it).
		const ledger = await deps.orderStore.readOrderLedger(cmd.orderId);
		if (ledger === null) return { ok: false, reason: "ORDER_NOT_FOUND" };
		const refusal = markRefundedRefusal(ledger.order, ledger);
		if (refusal !== null) return { ok: false, reason: refusal };
	}
	const enqueueEmail = cmd.toState !== "refunded" && emailTemplateForState(cmd.toState) !== null;
	const res = await applyTransition(deps, order, cmd, enqueueEmail);
	await revokeIfRefunded(deps, res);
	return res;
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
	/** Rows older than this are completed unsent (`markEmailSkipped`, no attempt
	 *  spent) and reported through `onExpired`. Default {@link OUTBOX_EMAIL_MAX_AGE_MS}. */
	maxAgeMs?: number;
	/** Told about every row the drain completed unsent because it was too old.
	 *  Never passed to `onSent` or `onSkipped`. */
	onExpired?: (row: OutboxEmail) => void;
	/** Called when the transport reported no provider to send through
	 *  (`EmailTransportUnavailableError`): the row went back uncounted and the
	 *  drain stopped. Lets a caller report "not configured" rather than "sent 0". */
	onTransportUnavailable?: () => void;
	/** Uncounted timeouts a row is allowed. Default: {@link MAX_UNCOUNTED_TIMEOUTS}. */
	maxUncountedTimeouts?: number;
	/**
	 * Told about every row the drain SENT, after it is marked sent — never a row
	 * whose send failed. A caller that must say truthfully whether a particular email
	 * went out (the admin console, QA T1-6) needs which rows, not how many.
	 */
	onSent?: (row: OutboxEmail) => void;
	/**
	 * Told about every row the drain SKIPPED — completed with no send because the
	 * order has no email recipient (a `buyerRef` that is not an email address) — after it is marked skipped. Never told about a row it
	 * sent, and a skipped row is never passed to `onSent` or counted as sent, so a
	 * caller can say "no email was sent, and none will be" rather than "queued".
	 */
	onSkipped?: (row: OutboxEmail) => void;
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

/**
 * How long a row waits after the transport said it has no provider to send
 * through (`EmailTransportUnavailableError`). Uncounted, like an untried row;
 * longer, because a missing provider is an operator's fix, not a moment's.
 */
export const TRANSPORT_UNAVAILABLE_RETRY_MS = 5 * 60_000;

/**
 * The oldest an outbox email may be and still go out: 72 hours (a user decision,
 * ADR-0031). A row claimed after that is completed WITHOUT a send — terminal, no
 * attempt spent — so a store that had no email provider for days does not
 * flood its buyers with stale "shipped" or "cancelled" mail the moment one is
 * selected. Every template alike (a sign-in link never enters the outbox and
 * expires on its own).
 */
export const OUTBOX_EMAIL_MAX_AGE_MS = 72 * 60 * 60 * 1000;

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
 * marked sent lets the lease lapse and the row be re-claimed and re-sent; with no
 * idempotency key on EmDash's `ctx.email` such duplicates are bounded by
 * `maxAttempts`, not deduped (ADR-0031). A row older than `maxAgeMs` (72 h) is
 * completed unsent. Returns the number of emails actually sent — a row skipped
 * for want of a recipient (`markEmailSkipped`) is not one.
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

		// Too old to send (ADR-0031): completed, never sent, no attempt spent.
		const createdMs = row.createdAt === undefined ? Number.NaN : Date.parse(row.createdAt);
		if (
			Number.isFinite(createdMs) &&
			now.getTime() - createdMs > (options.maxAgeMs ?? OUTBOX_EMAIL_MAX_AGE_MS)
		) {
			await deps.orderStore.markEmailSkipped(row.id, nowIso);
			options.onExpired?.(row);
			continue;
		}

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
		// Any OTHER state email for an order whose money was captured (processing,
		// shipped, …) states what the ledger has refunded so far beside its "Paid"
		// total (QA round 2). A cancellation states its own refund.
		const refundedSoFar =
			row.notice === null &&
			row.toState !== "refunded" &&
			row.toState !== "cancelled" &&
			orderTotalLabel(row.toState) === "Paid"
				? await refundedTotal(deps.orderStore, order)
				: null;
		const stateData = {
			...buildOrderEmailData(order, row.toState),
			...(refundedSoFar !== null ? { refundedSoFarCents: refundedSoFar.amount } : {}),
		};

		let skipped = false;
		try {
			const to = await resolveRecipient(deps, order);
			// No recipient: the row is done, and it went nowhere. Completed as SKIPPED —
			// never as sent (ADR-0026: a write reports whether its email went) — inside
			// the same try as `markEmailSent`, so a store error here is handled exactly as
			// one there is.
			if (to === null) {
				await deps.orderStore.markEmailSkipped(row.id, nowIso);
				skipped = true;
			} else {
				await deps.emailSender.send({
					to,
					template,
					data:
						refunded === null
							? stateData
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
			}
		} catch (err) {
			// No provider to send through (ADR-0031): nothing was sent and nothing is
			// wrong with the row. Hand it back uncounted, backed off, and stop — every
			// other row would meet the same answer.
			if (isEmailTransportUnavailableError(err)) {
				await deps.orderStore.releaseEmailClaim(row.id, {
					retryAt: new Date(now.getTime() + TRANSPORT_UNAVAILABLE_RETRY_MS).toISOString(),
				});
				options.onTransportUnavailable?.();
				break;
			}
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
			continue;
		}
		// Outside the try: a caller's callback that throws must never be mistaken for a
		// failed send and reschedule a row that already went out.
		if (skipped) options.onSkipped?.(row);
		else options.onSent?.(row);
	}
	return sent;
}

/** Everything finalized on the order's refund ledger, or null when nothing is. */
async function refundedTotal(
	orderStore: OrderStore,
	order: Order,
): Promise<{ amount: number; currency: string } | null> {
	const total = sumFinalizedRefunds(await orderStore.listRefunds(order.id));
	return total === 0 ? null : { amount: total, currency: order.totals.currency };
}

/**
 * Whether an order has an email recipient, decided from the order alone (no read):
 * a linked customer has one, and a guest has one only when its `buyerRef` is an
 * email address — a hand-seeded or legacy buyerRef without `@` is not. `false` is final: {@link resolveRecipient} will skip every row of
 * the order. `true` is the drain's to confirm — a linked customer whose record is
 * gone falls back to the `buyerRef`. A caller that must report an email's fate
 * before any row is claimed (the admin console) asks this.
 */
export function orderHasEmailRecipient(order: Pick<Order, "customerId" | "buyerRef">): boolean {
	return order.customerId !== null || isEmailAddress(order.buyerRef);
}

/**
 * The order's email recipient, or none — the ONE place it is decided (ADR-0028
 * Decision 7). Every outbox row, state email or notice, reaches the buyer through
 * this function, so an order with no recipient is never emailed whatever the
 * template. `null` ⇒ the drain completes the row as skipped.
 */
async function resolveRecipient(
	deps: DispatchOrderEmailsDeps,
	order: Order,
): Promise<Email | null> {
	if (order.customerId !== null && deps.customerStore !== undefined) {
		const customer = await deps.customerStore.get(toCustomerId(order.customerId));
		if (customer !== null) return customer.email;
	}
	// Guest order: the email captured at checkout (buyerRef), branded as it was
	// accepted there and not re-normalized here. A buyerRef that is not an email
	// address at all (a hand-seeded or legacy buyerRef without `@`) is no recipient.
	return isEmailAddress(order.buyerRef) ? (order.buyerRef as Email) : null;
}

/** Template data, rendered from order fields passed explicitly — no template
 *  reaches back into a store (§6). */
export function buildOrderEmailData(order: Order, toState: OrderState): Record<string, unknown> {
	return {
		orderId: order.id,
		state: toState,
		currency: order.totals.currency,
		totalCents: order.totals.total,
		// The totals breakdown AS RECORDED (QA U-3), so the email states the same
		// rows the order page does. Whether shipping and tax were calculated at all
		// is read off the method snapshot exactly as the order page reads it (the
		// plugin's `orderTotalsFlags`): shipping follows the method, tax follows the
		// zone — or the tax snapshot's `located` (ADR-0032: a digital cart taxed at
		// the shop base address has no shipping zone). Uncalculated renders "Not
		// calculated", never "$0.00".
		subtotalCents: order.totals.subtotal,
		discountCents: order.totals.discount,
		shippingCents: order.totals.shipping,
		taxCents: order.totals.tax,
		// ADR-0035's amendment: the payment rounding, only when the email shows it
		// (non-zero) — every other order enqueues exactly the data it always did.
		...roundingEntry(
			"roundingCents",
			order.totals.rounding === 0 ? undefined : order.totals.rounding,
		),
		appliedCouponCode: order.totals.appliedCouponCode,
		shippingCalculated: snapshotField(order.totals.shippingMethodSnapshot, "methodId", true),
		taxCalculated:
			snapshotField(order.totals.shippingMethodSnapshot, "zoneId", false) || taxLocated(order),
		// ADR-0032: prices entered WITH tax — the tax is inside the subtotal, so the
		// email says so rather than reading as one more row to add.
		...(pricedWithTaxIncluded(order) ? { taxIncluded: true } : {}),
		// The order's line SNAPSHOT (title and unit price as bought), never the
		// live product: an email sent after a rename still names what was paid for.
		lines: order.lines.map((l) => ({
			sku: l.sku,
			title: l.title,
			quantity: l.quantity,
			unitPriceCents: l.unitPrice,
		})),
		// The immutable ship-to snapshot (ADR-0009), or null — without the contact
		// channel, which the email has no reason to repeat.
		shippingAddress:
			order.shippingAddress === null
				? null
				: {
						name: order.shippingAddress.name,
						line1: order.shippingAddress.line1,
						line2: order.shippingAddress.line2,
						city: order.shippingAddress.city,
						region: order.shippingAddress.region,
						postalCode: order.shippingAddress.postalCode,
						country: order.shippingAddress.country,
					},
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

/** Does the totals' opaque shipping-method snapshot carry this id? The same test
 *  the order page applies (`shippingMethodIdOf` requires a non-empty method id,
 *  `shippingZoneIdOf` any string zone id), so the email and the page agree on
 *  every order. The snapshot is written only by `createOrderFromCart`, as
 *  `{ zoneId, methodId, matchedRegion }`. */
function snapshotField(snapshot: unknown, key: "zoneId" | "methodId", nonEmpty: boolean): boolean {
	if (snapshot === null || typeof snapshot !== "object") return false;
	const value = (snapshot as Record<string, unknown>)[key];
	return typeof value === "string" && (!nonEmpty || value.length > 0);
}

/** Whether the order's frozen tax snapshot says a tax location matched a zone
 *  (ADR-0032). A snapshot written before the field reads as not located. */
function taxLocated(order: Order): boolean {
	const snapshot = readOrderTaxSnapshot(order.totals.taxBreakdown);
	return snapshot?.v === 1 && snapshot.located === true;
}

/** Whether the order's frozen tax snapshot says prices were entered with tax (ADR-0032). */
function pricedWithTaxIncluded(order: Order): boolean {
	const snapshot = readOrderTaxSnapshot(order.totals.taxBreakdown);
	return snapshot?.v === 1 && snapshot.pricesIncludeTax;
}
