import {
	customerId as toCustomerId,
	type Email,
	type IdempotencyKey,
	type OrderId,
} from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { CustomerStore } from "../ports/customer-store.js";
import type { EmailSender } from "../ports/email-sender.js";
import type { OrderStore } from "../ports/order-store.js";
import type { Order, OrderState, PaymentMethod } from "./model.js";
import { emailTemplateForState, isLegalOrderTransition, legalNextStates } from "./state-machine.js";

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
	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };
	// Idempotent no-op: already at the target (a redelivery / double admin call).
	if (order.state === cmd.toState) return { ok: true, transitioned: false, order };
	if (!isLegalOrderTransition(order.state, cmd.toState)) {
		return { ok: false, reason: "INVALID_TRANSITION" };
	}
	return applyTransition(deps, order, cmd, emailTemplateForState(cmd.toState) !== null);
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
 * A bare `→ cancelled` from `state` would close an order whose money may be
 * captured with no refund, no restock and a "cancelled" email (QA T1-4). Only an
 * order that was never paid (`pending`) may be cancelled by the bare move; every
 * other cancellable state goes through Cancel order, which records a reason and
 * settles the money.
 */
function bareCancelAllowed(state: OrderState): boolean {
	return state === "pending";
}

/**
 * The status moves the admin console may OFFER for an order: the state machine's
 * legal moves, minus a manual `paid` that {@link manualPaymentAllowed} refuses and
 * a bare `cancelled` on a paid order. Read by the console instead of
 * `legalNextStates`, so it never renders a button {@link transitionOrderAsAdmin}
 * would refuse.
 */
export function adminNextStates(order: Pick<Order, "state" | "paymentMethod">): OrderState[] {
	return legalNextStates(order.state).filter(
		(to) =>
			!(to === "paid" && !manualPaymentAllowed(order.paymentMethod)) &&
			!(to === "cancelled" && !bareCancelAllowed(order.state)),
	);
}

export type TransitionOrderAsAdminResult =
	| TransitionOrderResult
	/** `pending → paid` asked for an order whose payment method is not declared
	 *  offline — its gateway settles it, or there is no method to settle at all. */
	| { ok: false; reason: "MANUAL_PAYMENT_NOT_ALLOWED" }
	/** A bare `→ cancelled` asked for an order that may hold the buyer's money:
	 *  Cancel order (a reason on file, the money settled) is the way. */
	| { ok: false; reason: "USE_CANCEL" };

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
 *  - **No bare `→ cancelled` on a paid order.** It would cancel with the money kept,
 *    no restock and a "cancelled" email; Cancel order is the path.
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
	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };
	if (order.state === cmd.toState) return { ok: true, transitioned: false, order };
	if (!isLegalOrderTransition(order.state, cmd.toState)) {
		return { ok: false, reason: "INVALID_TRANSITION" };
	}
	if (cmd.toState === "paid" && !manualPaymentAllowed(order.paymentMethod)) {
		return { ok: false, reason: "MANUAL_PAYMENT_NOT_ALLOWED" };
	}
	if (cmd.toState === "cancelled" && !bareCancelAllowed(order.state)) {
		return { ok: false, reason: "USE_CANCEL" };
	}
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
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_LIMIT = 100;

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
	const now = deps.clock.now();
	const nowIso = now.toISOString();
	const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;

	let sent = 0;
	for (let i = 0; i < batchLimit; i++) {
		const row = await deps.orderStore.claimNextEmail(nowIso, leaseUntil);
		if (row === null) break;

		const template = emailTemplateForState(row.toState);
		const order = await deps.orderStore.getById(row.orderId);
		// A row with no template (defensive) or a vanished order can never be
		// delivered — mark it done so it doesn't wedge the queue.
		if (template === null || order === null) {
			await deps.orderStore.markEmailSent(row.id, nowIso);
			continue;
		}

		try {
			await deps.emailSender.send({
				to: await resolveRecipient(deps, order),
				template,
				data: buildOrderEmailData(order, row.toState),
				idempotencyKey: row.id,
			});
			await deps.orderStore.markEmailSent(row.id, nowIso);
			sent++;
		} catch {
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
					},
				}
			: {}),
	};
}
