import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { OrderStore } from "../ports/order-store.js";

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

export type ResolveUnverifiedRefundResult =
	| {
			ok: true;
			outcome: "confirmed" | "voided";
			changed: boolean;
			fullyRefunded: boolean;
			/** The resolved row's id — what its refund email is keyed by. */
			refundId: string;
	  }
	| {
			ok: false;
			reason: "ORDER_NOT_FOUND" | "REFUND_NOT_FOUND" | "NOT_UNVERIFIED" | "EMPTY_RESOLVED_BY";
	  };

export function resolveUnverifiedRefund(
	deps: { orderStore: OrderStore },
	cmd: ResolveUnverifiedRefundCommand,
): Promise<ResolveUnverifiedRefundResult> {
	return attempt(deps, cmd, true);
}

async function attempt(
	deps: { orderStore: OrderStore },
	cmd: ResolveUnverifiedRefundCommand,
	retryOnRace: boolean,
): Promise<ResolveUnverifiedRefundResult> {
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
			refundId: row.id,
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
		return { ok: true, outcome: "voided", changed: true, fullyRefunded: false, refundId: row.id };
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
	return {
		ok: true,
		outcome: "confirmed",
		changed: !finalized.alreadyFinalized,
		fullyRefunded: finalized.fullyRefunded,
		refundId: row.id,
	};
}
