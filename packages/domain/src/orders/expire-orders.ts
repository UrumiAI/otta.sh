import type { Clock } from "../ports/clock.js";
import type { CouponStore } from "../ports/coupon-store.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type { OrderId } from "../money/ids.js";
import type { OrderStore } from "../ports/order-store.js";
import type { UnitBackoff } from "../sweep/backoff.js";
import {
	listLimitFor,
	mayContinue,
	type SweepBatchOptions,
	type SweepBatchResult,
} from "../sweep/batch.js";

export interface ExpireOrdersDeps {
	orderStore: OrderStore;
	inventoryStore: InventoryStore;
	/** Phase 6 (review I2): release the expired order's coupon, symmetric with
	 *  the inventory-hold release below. */
	couponStore: CouponStore;
	clock: Clock;
}

/**
 * Order-level expiry (§5) — a **real `orders`-table guarded transition**, NOT a
 * reuse of the Phase-3 reservation sweep. For each unpaid past-TTL order, the
 * guarded `pending → expired` flip (which re-checks `hold_expires_at <= now`
 * atomically) fires exactly once; only the winner then `release`s the order's
 * adopted reservations, so stock returns exactly once even under a double-sweep
 * race. Clock-driven; run by a self-interval or the `POST /internal/expire-orders`
 * trigger. Returns the count of orders actually expired.
 */
export async function expireOrders(deps: ExpireOrdersDeps, at?: Date): Promise<number> {
	return (await expireOrdersBatch(deps, at)).count;
}

/** {@link expireOrdersBatch}'s options: the sweep bite, plus an optional pre-listed
 *  due set. */
export interface ExpireOrdersBatchOptions extends SweepBatchOptions {
	/**
	 * The candidates, already listed by the caller — the scheduled sweep lists them
	 * once as its cheap "is there any work?" check and hands the same list here, so
	 * the tick never pays for the list twice. Listed as `limit + 1` (like the
	 * use-case's own list), so a set longer than the bite still reports
	 * `drained: false`. Each is re-checked by the guarded flip, so a stale entry
	 * (paid, cancelled, expired since) is a clean no-op.
	 */
	readonly due?: readonly OrderId[];
	/**
	 * QA3 N1: leave out (via the port's `listExpirable`) every order whose payment
	 * intent is due for withdrawal and not yet withdrawn, so no order expires while
	 * the buyer can still pay it. The scheduled sweep sets it, and withdraws those
	 * intents first (`cancelDueIntents`). Default false: the use-case on its own stays
	 * the pure state-and-stock transition ADR-0022 decision 2 describes, and a caller
	 * that does not withdraw intents would otherwise never expire such an order.
	 */
	readonly excludeIntentDue?: boolean;
	/**
	 * Review round 3, B I4: orders whose flip threw wait here before they are tried
	 * again, and the call reads past them — it lists that many more candidates and
	 * leaves the waiting ones out (a pre-listed `due` is filtered the same way). So
	 * `limit` orders that fail every time cannot hold the head of the list and starve
	 * the orders behind them. The caller keeps it across calls (the scheduled sweep
	 * holds one per process). Default: none, so a failed order is listed again next
	 * call, as before.
	 */
	readonly backoff?: UnitBackoff;
}

/**
 * `expireOrders`, bounded: at most `limit` orders attempted, each only while
 * `shouldContinue` allows, reporting whether the expirable set was `drained`.
 * The scheduled sweep calls this so a backlog drains over several ticks instead of
 * overrunning the host's hook timeout (see `sweep/batch.ts`). Stopping between two
 * orders is safe: each order's flip-then-release is its own guarded unit, and an
 * order not reached is still `pending` and still listed next time.
 *
 * ONE ORDER IS ONE STORE FLIP, NOT A FLIP AND A RE-READ (QA2 M2). The flip answers
 * with the order it wrote (`expireWithOrder`), and the holds go back in ONE
 * batched, order-scoped call — and only when the store has not already released
 * them itself (the document store completes the release intent its flip records,
 * in the same call). On the Workers Free preset the old shape — re-read, then a
 * release per line on top of the store's own — was 22 storage calls an order,
 * most of a tick.
 */
export async function expireOrdersBatch(
	deps: ExpireOrdersDeps,
	at?: Date,
	options: ExpireOrdersBatchOptions = {},
): Promise<SweepBatchResult> {
	const instant = at ?? deps.clock.now();
	const now = instant.toISOString();
	const { backoff } = options;
	const waiting = backoff?.waiting(instant.getTime()) ?? new Set<string>();
	const listed =
		options.due ??
		(await deps.orderStore.listExpirable(now, {
			...listLimitFor(options, waiting.size),
			...(options.excludeIntentDue === true ? { excludeIntentDue: true } : {}),
		}));
	const ids = waiting.size === 0 ? listed : listed.filter((id) => !waiting.has(id));
	let expired = 0;
	let attempted = 0;
	for (const id of ids) {
		if (!mayContinue(options, attempted)) return { count: expired, drained: false };
		attempted++;
		// ONE ORDER IS ONE UNIT (review round 2, A R2-A1): a throw from one order's
		// flip or release is logged and the batch moves on, so it can neither end the
		// tick early nor leave the orders after it holding their stock. Nothing is
		// lost by catching: an order whose flip threw is still `pending` and listed
		// again (after its back-off, when there is one); one whose release threw is
		// `expired` with its release intent still outstanding (the document store
		// records it with the flip), which the hold-intent sweeper completes. An error
		// that stops the whole call (`stopsBatch`: the tick's query ceiling) is not
		// one order's failure, so it is rethrown (review round 3, A I2).
		let won: Awaited<ReturnType<OrderStore["expireWithOrder"]>>;
		try {
			won = await deps.orderStore.expireWithOrder(id, now);
		} catch (err) {
			if (options.stopsBatch?.(err) === true) throw err;
			backoff?.failed(id, instant.getTime());
			logUnitFailure(`expiring order ${id}`, err);
			continue;
		}
		backoff?.succeeded(id);
		if (won === null) continue; // someone else won the transition (paid/cancelled/expired)
		expired++;
		const { order } = won;
		if (!won.holdsReleased) {
			// Order-SCOPED release (review G2): only a hold THIS order adopted is
			// released — a line pointing at another order's reservation (a stale
			// pre-fence order) is a silent skip, never a foreign release or a throw
			// that would crash every subsequent sweep run. One call for every line.
			const reservationIds = order.lines.flatMap((line) =>
				line.reservationId === null ? [] : [line.reservationId],
			);
			if (reservationIds.length > 0) {
				try {
					await deps.inventoryStore.releaseAdoptedMany(reservationIds, order.id);
				} catch (err) {
					if (options.stopsBatch?.(err) === true) throw err;
					logUnitFailure(`releasing the holds of expired order ${order.id}`, err);
				}
			}
		}
		// Review I2: free the coupon too — symmetric with the inventory release.
		// Order-scoped + idempotent (a double-sweep releases exactly once). Only an
		// order that CARRIED a coupon holds a redemption: checkout redeems a coupon
		// only when it discounts, and stamps `appliedCouponCode` in the same order
		// (I4), so a coupon-less order is skipped — one storage read saved per order.
		// The flip above is already durable, so a crash HERE would strand the use:
		// the plugin's coupon sweeper releases any redemption whose order is
		// `expired` as the retry, which also covers an order whose stamp is missing.
		if (order.totals.appliedCouponCode !== null) {
			try {
				await deps.couponStore.releaseByOrder(order.id);
			} catch (err) {
				if (options.stopsBatch?.(err) === true) throw err;
				logUnitFailure(`releasing the coupon of expired order ${order.id}`, err);
			}
		}
	}
	return { count: expired, drained: true };
}

/** One order's step failed; the batch goes on. */
function logUnitFailure(step: string, err: unknown): void {
	console.error(`[domain] order expiry: ${step} failed; the batch continues`, {
		error: describeErrorForLog(err),
	});
}

/** Longest message kept in a log line. */
const LOG_MESSAGE_MAX = 160;

/**
 * An error as a log line may carry it (review round 3, B I5): its `name`, a
 * string or numeric `code`, and a SHORT message with every quoted run and
 * anything shaped like an email replaced. Today's storage and domain errors carry
 * no stored values, but an adapter's driver message may quote one (a row's
 * text, a key), and this line goes to the worker log.
 */
function describeErrorForLog(err: unknown): {
	name: string;
	code?: string;
	message: string;
} {
	const name = err instanceof Error ? err.name : typeof err;
	const rawCode =
		typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
	const code =
		typeof rawCode === "string" || typeof rawCode === "number"
			? scrub(String(rawCode)).slice(0, 32)
			: undefined;
	const message = scrub(err instanceof Error ? err.message : String(err));
	return {
		name: scrub(name).slice(0, 64),
		...(code === undefined ? {} : { code }),
		message: message.length > LOG_MESSAGE_MAX ? `${message.slice(0, LOG_MESSAGE_MAX)}…` : message,
	};
}

function scrub(text: string): string {
	return (
		text
			// Quoted runs: the usual place a driver puts a value.
			.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<value>")
			.replace(/[^\s@<>]+@[^\s@<>]+/g, "<value>")
			// Control characters, lone surrogates and the like: printable text only.
			.replace(/[^\x20-\x7E]/g, "?")
	);
}
