import { idempotencyKey as toIdempotencyKey } from "../money/ids.js";
import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type { CancellationReason, Order, OrderState } from "./model.js";
import type { OrderStore, RefundRecord } from "../ports/order-store.js";
import { cancelOrderWithRefund, type RestockSkip } from "./cancel-order.js";
import { finishResolvedLatePaymentRefund } from "./late-payment.js";
import { unverifiedRefundFlagPrefix } from "./refund-order.js";

/**
 * A person resolves a refund whose outcome is UNKNOWN (review round 2, ADR-0026
 * amended 2026-10-03).
 *
 * WHY IT EXISTS. A refund whose provider call timed out is held `unverified`: it
 * keeps its ceiling capacity (the safe direction) until someone checks the
 * provider. Nothing else ever settles it — a same-key retry answers
 * GATEWAY_UNVERIFIED without calling the provider, no webhook finalizes it, and
 * Mark refunded and cancel-with-refund both refuse `REFUND_IN_FLIGHT` while it
 * stands — so without this the order could never be closed.
 *
 * TWO ANSWERS, both idempotent:
 *  - `confirmed` — the provider shows the refund: the row is FINALIZED exactly as
 *    the gateway's own success would be (`finalizeRefund`): recorded, the ceiling
 *    flip to `refunded` when it completes the refund, and the same one refund
 *    email. `refundRef` is the provider's refund id when the operator has it,
 *    else a marker naming the operator's confirmation.
 *  - `voided` — it did not happen: `unverified → voided`, capacity released.
 * Either way the operator is recorded on the row (`resolvedBy`). A replay of the
 * same answer is `changed: false`; any row that is not `unverified` (reserved,
 * or already settled the other way) is refused, and so is a key that is not this
 * order's.
 *
 * THEN WHAT THE REFUND WAS FOR (#364). Settling the row is not the end when the
 * refund was part of something larger (`RefundPurpose`); the order must end as it
 * would have had the provider answered the first time ({@link ResolveFollowUp}):
 *  - `cancellation` — confirmed: the cancel is RESUMED (`cancelOrderWithRefund`
 *    under the cancellation's own key, its first attempt's restock choice). It
 *    finds its refund settled, so it calls no provider, and finishes restock, flip
 *    and the one cancelled email. If the order can no longer be cancelled (it
 *    shipped meanwhile) it is flagged for a person and the refund announces itself
 *    (`refund-issued`, once). Voided: the order is still paid, and Cancel order
 *    again refunds and cancels it under a fresh attempt key.
 *  - `late-payment` — confirmed: the automatic path's own finish (flag resolved,
 *    one `late-payment-refunded` notice). Voided: flagged to refund by hand.
 *  - `refund` — nothing more (`followUp: null`).
 * The follow-up runs on a REPLAY of `confirmed` too, so a crash between the
 * finalize and the follow-up heals on the next click. Every step is keyed or
 * first-wins, so nothing is refunded, restocked or emailed twice.
 */
export interface ResolveUnverifiedRefundCommand {
	orderId: OrderId;
	/** The refund row's own idempotency key — how the ledger names it. */
	refundKey: IdempotencyKey;
	outcome: "confirmed" | "voided";
	/** The provider's refund id, for `confirmed`. Optional. */
	refundRef?: string;
	resolvedBy: string;
}

/**
 * What became of the thing a resolved refund was FOR (#364); `null` for a plain
 * refund.
 *  - `cancellation`/`cancelled` — the order is cancelled (`cancelledNow`: by this
 *    call, so its cancelled email is new).
 *  - `cancellation`/`already_cancelled` — another path had cancelled the order
 *    WITHOUT this refund on its record, so its cancelled email never mentioned
 *    the money: the refund's `refund-issued` notice tells the buyer (once).
 *  - `cancellation`/`not_cancelled` — the refund is settled but the order had left
 *    every cancellable state (`state`); it is flagged (unless a flag naming this
 *    cancellation is already there), and the refund's `refund-issued` notice
 *    tells the buyer (once). Both are re-checked on EVERY pass, replays included,
 *    so a crash or an order that ships between passes still ends flagged and told.
 *  - `cancellation`/`cancel_again` — the cancel did not finish here (it did not
 *    run, or stopped part-way); Cancel order again finishes it without refunding
 *    twice. After a void it is the plain next step: the order is still paid.
 *  - `late-payment`/`finished` — flag resolved, the buyer's notice enqueued once.
 *  - `late-payment`/`refund_manually` — the payment is still held; flagged.
 */
export type ResolveFollowUp =
	| {
			purpose: "cancellation";
			outcome: "cancelled";
			cancelledNow: boolean;
			/** The cancellation's restock choice (its first attempt's). */
			restock: boolean;
			restockedUnits: number;
			restockSkipped: RestockSkip[];
			/** The flip landed but its restock did not finish: the units are not all
			 *  back yet, and the sweep (or a replay) returns them. */
			restockPending: boolean;
	  }
	| {
			purpose: "cancellation";
			outcome: "already_cancelled";
			/** This call enqueued the refund's own `refund-issued` notice (false: it
			 *  was already enqueued by an earlier pass, or the write failed). */
			refundEmailQueued: boolean;
	  }
	| {
			purpose: "cancellation";
			outcome: "not_cancelled";
			state: OrderState | null;
			/** The order carries a flag naming this cancellation (written now or before). */
			flagged: boolean;
			/** As in `already_cancelled`. */
			refundEmailQueued: boolean;
	  }
	| { purpose: "cancellation"; outcome: "cancel_again" }
	| { purpose: "late-payment"; outcome: "finished" }
	| { purpose: "late-payment"; outcome: "refund_manually"; flagged: boolean };

export interface ResolveUnverifiedRefundDeps {
	orderStore: OrderStore;
	/** Where a resumed cancellation restocks. Without it a confirmed cancellation
	 *  refund is settled but the cancel is left for Cancel order again
	 *  (`cancel_again`). */
	inventoryStore?: InventoryStore;
	/** Forwarded to the resumed cancel — see `CancelOrderWithRefundDeps`. */
	isRetryable?: (err: unknown) => boolean;
}

export type ResolveUnverifiedRefundResult =
	| {
			ok: true;
			outcome: "confirmed" | "voided";
			changed: boolean;
			fullyRefunded: boolean;
			/** The resolved row's id — what its refund email is keyed by. */
			refundId: string;
			/** What the refund was for, finished (or not) — see {@link ResolveFollowUp}. */
			followUp: ResolveFollowUp | null;
	  }
	| {
			ok: false;
			reason: "ORDER_NOT_FOUND" | "REFUND_NOT_FOUND" | "NOT_UNVERIFIED" | "EMPTY_RESOLVED_BY";
	  };

export async function resolveUnverifiedRefund(
	deps: ResolveUnverifiedRefundDeps,
	cmd: ResolveUnverifiedRefundCommand,
): Promise<ResolveUnverifiedRefundResult> {
	const res = await attempt(deps, cmd, true);
	if (!res.ok) return res;
	const followUp = await finishPurpose(deps, cmd, res.row, res.changed);
	return {
		ok: true,
		outcome: res.outcome,
		changed: res.changed,
		// A resumed cancellation never flips `→ refunded`, so the settle's answer stands.
		fullyRefunded: res.fullyRefunded,
		refundId: res.row.id,
		followUp,
	};
}

type Settled =
	| {
			ok: true;
			outcome: "confirmed" | "voided";
			changed: boolean;
			fullyRefunded: boolean;
			row: RefundRecord;
	  }
	| Extract<ResolveUnverifiedRefundResult, { ok: false }>;

async function attempt(
	deps: ResolveUnverifiedRefundDeps,
	cmd: ResolveUnverifiedRefundCommand,
	retryOnRace: boolean,
): Promise<Settled> {
	const resolvedBy = cmd.resolvedBy.trim();
	if (resolvedBy.length === 0) return { ok: false, reason: "EMPTY_RESOLVED_BY" };
	const ledger = await deps.orderStore.readOrderLedger(cmd.orderId);
	if (ledger === null) return { ok: false, reason: "ORDER_NOT_FOUND" };
	const row = ledger.refunds.find((r) => r.idempotencyKey === cmd.refundKey);
	if (row === undefined) return { ok: false, reason: "REFUND_NOT_FOUND" };

	const settled = cmd.outcome === "confirmed" ? "recorded" : "voided";
	if (row.status === settled && row.resolvedBy !== undefined) {
		// The same answer again (a double click, a retried request): nothing moves.
		return {
			ok: true,
			outcome: cmd.outcome,
			changed: false,
			fullyRefunded: ledger.order.state === "refunded",
			row,
		};
	}
	if (row.status !== "unverified") return { ok: false, reason: "NOT_UNVERIFIED" };

	if (cmd.outcome === "voided") {
		const voided = await deps.orderStore.voidUnverifiedRefund({
			idempotencyKey: cmd.refundKey,
			resolvedBy,
		});
		// A concurrent resolver got there first: re-read and answer as a replay or
		// a refusal, whichever it became.
		if (!voided) {
			return retryOnRace ? attempt(deps, cmd, false) : { ok: false, reason: "NOT_UNVERIFIED" };
		}
		await clearItsFlag(deps, ledger.order, row, cmd, resolvedBy);
		return { ok: true, outcome: "voided", changed: true, fullyRefunded: false, row };
	}

	const refundRef =
		cmd.refundRef !== undefined && cmd.refundRef.trim().length > 0
			? cmd.refundRef.trim()
			: `confirmed-by-operator:${cmd.refundKey}`;
	const finalized = await deps.orderStore.finalizeRefund({
		idempotencyKey: cmd.refundKey,
		refundRef,
		resolvedBy,
	});
	if (!finalized.found) {
		return retryOnRace ? attempt(deps, cmd, false) : { ok: false, reason: "NOT_UNVERIFIED" };
	}
	await clearItsFlag(deps, finalized.order ?? ledger.order, row, cmd, resolvedBy);
	return {
		ok: true,
		outcome: "confirmed",
		changed: !finalized.alreadyFinalized,
		fullyRefunded: finalized.fullyRefunded,
		row: finalized.refund ?? row,
	};
}

/** Finish what the resolved refund was for — see {@link ResolveFollowUp}. */
async function finishPurpose(
	deps: ResolveUnverifiedRefundDeps,
	cmd: ResolveUnverifiedRefundCommand,
	row: RefundRecord,
	changed: boolean,
): Promise<ResolveFollowUp | null> {
	const purpose = row.purpose ?? "refund";
	if (purpose === "late-payment") {
		const done = await finishResolvedLatePaymentRefund(
			deps,
			row,
			cmd.outcome,
			cmd.resolvedBy.trim(),
			cmd.outcome === "voided" && !changed,
		);
		return done === null ? null : { purpose: "late-payment", ...done };
	}
	if (purpose !== "cancellation") return null;
	if (cmd.outcome === "voided") return { purpose: "cancellation", outcome: "cancel_again" };
	return resumeCancellation(deps, row);
}

/**
 * The cancellation a confirmed refund belonged to, resumed under its own key: the
 * row's key is `<cancel key>:refund` or `<cancel key>:refund:<n>`
 * (`cancelOrderWithRefund`'s attempt keys), and its reason is the one that
 * function wrote (`order cancelled (<reason>)`). The canceller is the operator who
 * started it (`refundedBy`); the free-text detail is not on the row, so the
 * resumed envelope records none. Anything unreadable is left for Cancel order
 * again, which asks the operator for the reason anew.
 */
async function resumeCancellation(
	deps: ResolveUnverifiedRefundDeps,
	row: RefundRecord,
): Promise<ResolveFollowUp> {
	const again = { purpose: "cancellation", outcome: "cancel_again" } as const;
	const cancelKey = /^(.+):refund(?::\d+)?$/.exec(row.idempotencyKey)?.[1];
	const reason = cancellationReasonOf(row.reason);
	if (deps.inventoryStore === undefined || cancelKey === undefined || reason === null) {
		return again;
	}
	// A row written before `restock` existed defaults as the cancel itself does
	// (`restock: true`, the console's default) — the cancel would read it the same.
	const restock = row.restock ?? true;
	let res: Awaited<ReturnType<typeof cancelOrderWithRefund>>;
	try {
		res = await cancelOrderWithRefund(
			{
				orderStore: deps.orderStore,
				inventoryStore: deps.inventoryStore,
				...(deps.isRetryable !== undefined ? { isRetryable: deps.isRetryable } : {}),
			},
			// No gateway: the refund is settled, so the resumed cancel never needs one.
			null,
			{
				orderId: row.orderId,
				reason,
				detail: null,
				cancelledBy: row.refundedBy,
				restock,
				idempotencyKey: toIdempotencyKey(cancelKey),
			},
		);
	} catch {
		// The refund is resolved either way; the cancel is the operator's next click.
		return again;
	}
	if (res.ok) {
		const carried = res.refund;
		if (
			!res.cancelled &&
			(carried === null || carried.amount !== row.amount || carried.currency !== row.currency)
		) {
			// Cancelled by ANOTHER path, without this refund on its record: its email
			// never mentioned the money, so the refund announces itself.
			return {
				purpose: "cancellation",
				outcome: "already_cancelled",
				refundEmailQueued: await announceRefund(deps, row),
			};
		}
		return {
			purpose: "cancellation",
			outcome: "cancelled",
			cancelledNow: res.cancelled,
			restock,
			restockedUnits: res.restockedUnits,
			restockSkipped: res.restockSkipped,
			restockPending: res.restockPending,
		};
	}
	if (res.reason === "CANCEL_LOST_AFTER_REFUND") {
		// The cancel itself flagged the order and announced the refund.
		return {
			purpose: "cancellation",
			outcome: "not_cancelled",
			state: res.movedTo,
			flagged: true,
			refundEmailQueued: true,
		};
	}
	if (res.reason !== "NOT_CANCELLABLE") return again;
	const order = await deps.orderStore.getById(row.orderId);
	if (order?.state === "cancelled") {
		// Cancelled with no reason on file (the bare transition): the money went back
		// on a cancelled order — only the buyer is missing the news.
		return {
			purpose: "cancellation",
			outcome: "already_cancelled",
			refundEmailQueued: await announceRefund(deps, row),
		};
	}
	// The order left every cancellable state (it shipped) before the refund was
	// confirmed. The money is back and cannot be un-refunded: tell the buyer and flag
	// it for a person, as the cancel's own lost path does. On EVERY pass — a replay
	// after a crash, or after the order shipped, must still heal — but the flag only
	// when the order's flag does not already name this cancellation.
	const refundEmailQueued = await announceRefund(deps, row);
	const mine = `a cancellation (key ${cancelKey})`;
	let flagged = order?.reconciliationFlag?.startsWith(mine) === true;
	if (!flagged && order !== null) {
		flagged = await bestEffort(() =>
			deps.orderStore.flagReconciliation(
				row.orderId,
				`${mine} refunded ${String(row.amount)} ${row.currency} (confirmed at the provider), but the order is ${order.state} and could not be cancelled — contact the buyer, then stop the shipment or use Mark refunded; do not ship or refund it again unchecked`,
			),
		);
	}
	return {
		purpose: "cancellation",
		outcome: "not_cancelled",
		state: order?.state ?? null,
		flagged,
		refundEmailQueued,
	};
}

/** The refund's own `refund-issued` notice (first-wins per refund): true iff THIS
 *  call enqueued it. */
async function announceRefund(
	deps: ResolveUnverifiedRefundDeps,
	row: RefundRecord,
): Promise<boolean> {
	try {
		return await deps.orderStore.enqueueNotice(row.orderId, {
			kind: "refund-issued",
			amount: row.amount,
			currency: row.currency,
			refundId: row.id,
		});
	} catch {
		return false;
	}
}

const CANCELLATION_REASONS: ReadonlySet<string> = new Set<CancellationReason>([
	"customer_request",
	"fraud_suspected",
	"out_of_stock",
	"pricing_error",
	"other",
]);

/** The cancellation reason a cancellation's refund row carries, or `null`. */
function cancellationReasonOf(text: string | null): CancellationReason | null {
	const found = /^order cancelled \(([a-z_]+)\)$/.exec(text ?? "")?.[1];
	return found !== undefined && CANCELLATION_REASONS.has(found)
		? (found as CancellationReason)
		: null;
}

/** Run a write whose failure must not surface; true iff it succeeded, so the
 *  answer can say what was actually written. */
async function bestEffort(write: () => Promise<unknown>): Promise<boolean> {
	try {
		await write();
		return true;
	} catch {
		// Best effort: the refund is resolved either way, and the answer says so.
		return false;
	}
}

/**
 * Clear the flag that sent the operator here — the refund path's "never
 * finalized" flag for THIS refund — by compare-and-clear on its exact text (as
 * cancel-with-refund clears its own). Any other flag is left for a person. Best
 * effort: the refund is already resolved, and a flag that changed in between is
 * simply not cleared.
 */
async function clearItsFlag(
	deps: { orderStore: OrderStore },
	order: Order,
	row: RefundRecord,
	cmd: ResolveUnverifiedRefundCommand,
	resolvedBy: string,
): Promise<void> {
	const flag = order.reconciliationFlag;
	if (flag === null) return;
	if (!flag.startsWith(unverifiedRefundFlagPrefix(row.amount, row.currency, row.idempotencyKey))) {
		return;
	}
	try {
		await deps.orderStore.resolveReconciliation({
			orderId: cmd.orderId,
			expectedFlag: flag,
			outcome: cmd.outcome === "confirmed" ? "refunded" : "written_off",
			reason:
				cmd.outcome === "confirmed"
					? "The unverified refund was confirmed at the provider and recorded."
					: "The unverified refund was confirmed as never issued and voided.",
			resolvedBy,
			idempotencyKey: toIdempotencyKey(`${cmd.refundKey}:resolve-unverified`),
		});
	} catch {
		// Best effort: the refund itself is resolved either way.
	}
}
