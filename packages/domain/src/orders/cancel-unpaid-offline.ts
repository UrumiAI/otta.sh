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
import type { OrderStore } from "../ports/order-store.js";
import { cancelOrder } from "./cancel-order.js";

/** Who the auto-cancel is recorded as, on the cancellation and its audit event. */
export const AUTO_CANCEL_ACTOR = "otta:auto-cancel";

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
}

export interface CancelUnpaidOfflineResult {
	/** Orders this call cancelled. */
	cancelled: number;
	/** Due orders left alone (captured cash on file, or already moved on). */
	skipped: number;
	/** True when every due order the listing returned was looked at. */
	drained: boolean;
}

export async function cancelUnpaidOfflineOrders(
	deps: CancelUnpaidOfflineDeps,
	options: CancelUnpaidOfflineOptions,
): Promise<CancelUnpaidOfflineResult> {
	if (!(options.maxAgeDays > 0) || options.limit <= 0) {
		return { cancelled: 0, skipped: 0, drained: true };
	}
	const now = deps.clock.now();
	const cutoff = new Date(now.getTime() - options.maxAgeDays * DAY_MS).toISOString();
	const due = await deps.orderStore.listAwaitingPaymentBefore(cutoff, options.limit);
	let cancelled = 0;
	let skipped = 0;
	let looked = 0;
	for (const id of due) {
		if (options.shouldContinue !== undefined && !options.shouldContinue()) break;
		looked++;
		const order = await deps.orderStore.getById(id);
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
			deps.logger.error(
				`[domain] auto-cancel could not free the coupon use of order ${id}; it will be retried`,
				{ error: err instanceof Error ? err.message : String(err) },
			);
			skipped++;
			continue;
		}
		const res = await cancelOrder(
			{ orderStore: deps.orderStore, logger: deps.logger },
			{
				orderId: id,
				reason: "other",
				detail: `Not paid within ${String(options.maxAgeDays)} days`,
				cancelledBy: AUTO_CANCEL_ACTOR,
				idempotencyKey: idempotencyKey(`auto-cancel:${id}`),
			},
		);
		if (!res.ok || !res.cancelled) {
			skipped++;
			continue;
		}
		cancelled++;
	}
	return { cancelled, skipped, drained: looked === due.length && due.length < options.limit };
}
