/**
 * Auto-cancel of stale unpaid OFFLINE orders (ADR-0044 §6, decision B): a
 * cash-on-delivery order still `awaiting_payment` after the merchant's window
 * (default 14 days) has its coupon use freed first (nobody chose to keep it,
 * unlike a merchant cancel), then is cancelled — its stock released by the
 * cancel's own release intent, and the buyer emailed the ordinary cancelled email.
 *
 * Never cancelled here:
 *  - a `shipped_awaiting_payment` order: the goods are out (the listing is
 *    `awaiting_payment` only);
 *  - an order whose ledger already shows captured money — a Mark paid that died
 *    between recording the cash and its flip. Cancelling would keep attested cash
 *    behind a "cancelled" email, so it is flagged for a person instead (never over
 *    another flag) and counted as skipped.
 */
import { idempotencyKey } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { CouponStore } from "../ports/coupon-store.js";
import type { Logger } from "../ports/logger.js";
import type { AwaitingPaymentCursor, OrderStore } from "../ports/order-store.js";
import { emailTemplateForState } from "./state-machine.js";

/** Who the auto-cancel is recorded as, on the cancellation and its audit event. */
export const AUTO_CANCEL_ACTOR = "otta:auto-cancel";

/**
 * Thrown by a caller's coupon store when it DEFERS a release rather than failing
 * it — the plugin's sweep, when the tick's query budget cannot afford the whole
 * release. Not a fault: the order stays listed and a later run frees the use, so
 * it is logged at info, never at error (review round 3, R3-4).
 */
export class CouponReleaseDeferredError extends Error {
	constructor(message = "coupon release deferred to a later run") {
		super(message);
		this.name = "CouponReleaseDeferredError";
	}
}

/** The window a store gets when it never saved one (ADR-0044). */
export const DEFAULT_OFFLINE_AUTO_CANCEL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CancelUnpaidOfflineDeps {
	orderStore: OrderStore;
	couponStore: Pick<CouponStore, "releaseByOrder">;
	clock: Clock;
	logger: Logger;
}

export interface CancelUnpaidOfflineOptions {
	/** Orders placed more than this many days ago are due. 0 (or less) ⇒ off. */
	maxAgeDays: number;
	/** At most this many orders are read and acted on. */
	limit: number;
	/** Asked before each order; `false` ends the batch (the sweep's budget). */
	shouldContinue?: () => boolean;
	/**
	 * Where the previous run stopped (its `cursor`): only orders after it are read.
	 * Omitted ⇒ from the oldest due order.
	 */
	after?: AwaitingPaymentCursor;
}

export interface CancelUnpaidOfflineResult {
	/** Orders this call cancelled. */
	cancelled: number;
	/** Due orders left alone (captured cash on file, or already moved on). */
	skipped: number;
	/** True when every due order the listing returned was looked at. */
	drained: boolean;
	/**
	 * Where the next run starts (pass it back as `after`): past every order this run
	 * looked at — cancelled or skipped (cash on file and flagged, a failed or deferred
	 * coupon release, an order that moved on). Without it, an order skipped at the
	 * head of the listing is read first on every run, and a tick that affords one
	 * order (Workers Free) never reaches the younger ones behind it. A deferred
	 * release is walked past too: on a budget that can never afford it, it would
	 * otherwise be the new blocked head. `null` once the walk has drained, so the next
	 * pass starts over at the oldest and looks at every skipped order again.
	 */
	cursor: AwaitingPaymentCursor | null;
}

export async function cancelUnpaidOfflineOrders(
	deps: CancelUnpaidOfflineDeps,
	options: CancelUnpaidOfflineOptions,
): Promise<CancelUnpaidOfflineResult> {
	if (!(options.maxAgeDays > 0) || options.limit <= 0) {
		return { cancelled: 0, skipped: 0, drained: true, cursor: null };
	}
	const now = deps.clock.now();
	const cutoff = new Date(now.getTime() - options.maxAgeDays * DAY_MS).toISOString();
	const due = await deps.orderStore.listAwaitingPaymentBefore(cutoff, options.limit, options.after);
	let cancelled = 0;
	let skipped = 0;
	let looked = 0;
	let cursor: AwaitingPaymentCursor | null = options.after ?? null;
	for (const id of due) {
		if (options.shouldContinue !== undefined && !options.shouldContinue()) break;
		looked++;
		const order = await deps.orderStore.getById(id);
		// Looked at: whatever becomes of it below, the walk moves past it.
		if (order !== null) cursor = { createdAt: order.createdAt, orderId: order.id };
		if (order === null || order.state !== "awaiting_payment") {
			skipped++;
			continue;
		}
		const captured = await deps.orderStore.getCapturedPayments(id);
		if (captured.some((p) => p.status === "succeeded")) {
			if (order.reconciliationFlag === null) {
				await deps.orderStore.flagReconciliation(
					id,
					`cash recorded on an unpaid cash-on-delivery order past its ${String(options.maxAgeDays)}-day window: finish Mark paid, or refund and cancel it`,
					{ expectedFlag: null },
				);
			}
			skipped++;
			continue;
		}
		// The coupon use goes back FIRST (ADR-0044 §6): idempotent and order-scoped,
		// so a run that fails here leaves the order listed and the next run retries
		// both. Released after the cancel, a failure would strand the use for good —
		// the coupon-orphans leg judges a redemption only once.
		try {
			await deps.couponStore.releaseByOrder(order);
		} catch (err) {
			if (err instanceof CouponReleaseDeferredError) {
				deps.logger.info(
					`[domain] auto-cancel deferred order ${id} to a later run (its coupon release did not fit)`,
				);
			} else {
				deps.logger.error(
					`[domain] auto-cancel could not free the coupon use of order ${id}; it will be retried`,
					{ error: err instanceof Error ? err.message : String(err) },
				);
			}
			skipped++;
			continue;
		}
		// The store's GUARDED flip from `awaiting_payment` — never the generic
		// `cancelOrder`, which re-reads the order and would cancel it from wherever
		// it now is: a Mark paid that won since the read above would be cancelled
		// with its cash (paid → cancelled is legal). Lost here, the order is left as
		// the winner left it.
		const res = await deps.orderStore.cancelOrder({
			orderId: id,
			fromState: "awaiting_payment",
			reason: "other",
			detail: `Not paid within ${String(options.maxAgeDays)} days`,
			cancelledBy: AUTO_CANCEL_ACTOR,
			idempotencyKey: idempotencyKey(`auto-cancel:${id}`),
			enqueueEmail: emailTemplateForState("cancelled") !== null,
		});
		if (!res.cancelled) {
			// The use was freed and the cancel did not land — a concurrent move (a Mark
			// paid) won. The order keeps its discount; the coupon may be used once more
			// than its cap allows (ADR-0044 §6). Not re-redeemed: made visible instead.
			if (order.totals.appliedCouponCode !== null) {
				deps.logger.warn(
					`[domain] auto-cancel freed coupon ${order.totals.appliedCouponCode}'s use for order ${id}, then the order moved before it could be cancelled; the coupon may be used once more than its cap`,
					{ orderId: id, coupon: order.totals.appliedCouponCode },
				);
			}
			skipped++;
			continue;
		}
		cancelled++;
	}
	const drained = looked === due.length && due.length < options.limit;
	return { cancelled, skipped, drained, cursor: drained ? null : cursor };
}
