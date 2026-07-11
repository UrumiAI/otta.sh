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
import type { Order, OrderState } from "./model.js";
import { emailTemplateForState, isLegalOrderTransition } from "./state-machine.js";

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
	const template = emailTemplateForState(cmd.toState);
	const res = await deps.orderStore.transition({
		orderId: cmd.orderId,
		fromState: order.state,
		toState: cmd.toState,
		idempotencyKey: cmd.idempotencyKey,
		enqueueEmail: template !== null,
	});
	return { ok: true, transitioned: res.transitioned, order: res.order ?? order };
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
	};
}
