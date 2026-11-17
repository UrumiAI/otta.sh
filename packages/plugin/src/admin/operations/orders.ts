/**
 * The admin ORDER operations: the decision half of every Orders write, with no
 * payload parsing and no notice.
 *
 * WHY THEY ARE HERE. These guards used to live inline in the Block Kit actions
 * (`orders-actions.ts`), one layer above `AdminOrdersSurface`: the refund ledger
 * re-read and its key (F-2a, `:v<n>` after a voided attempt), the re-read of the
 * order against the state the operator saw (DA-3a), and every write's derived
 * idempotency key. A second caller (the MCP tools) calling the surface directly
 * would skip all of them. So each write is one function here, and both callers
 * go through it: the action parses its payload, calls the operation, and turns the
 * outcome into a notice; an MCP route validates its input, calls the operation,
 * and turns the outcome into JSON. Moved verbatim — no rule changed on the way.
 *
 * INPUT IS TYPED, NOT PARSED. Reading an untrusted payload (integer minor-units
 * strings, closed sets, a watermark's presence) stays with each caller. What an
 * operation cannot safely run without, it ASSERTS and throws `RangeError` on — a
 * caller that let one through has a bug, and no write is attempted.
 *
 * Each signature is `(client, input, operator)`. `operator` is the signed-in admin
 * the host named — who a write records as having made it when the input named
 * nobody. Writes whose form always names its author take it for uniformity.
 */
import { ORDER_STATES, UNPAID_ORDER_STATES } from "@urumi.ai/otta-admin-presentation";
import type {
	AddNoteResult,
	AdminOrdersSurface,
	CancelOrderResult,
	InlineEmailStatus,
	RecordFulfillmentResult,
	ResolveReconciliationResult,
	ResolveUnverifiedRefundResult,
	RevokeDownloadAccessResult,
	TransitionOrderResult,
} from "../admin-orders-surface.js";

function assertInput(condition: boolean, message: string): asserts condition {
	if (!condition) throw new RangeError(message);
}

const nonBlank = (value: string): boolean => value.trim().length > 0;

/** Integer minor units, never a float (B-2). */
const isMinorUnits = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

// -- refunds ------------------------------------------------------------------

export interface RefundInput {
	orderId: string;
	/** Integer minor units, > 0. */
	amountCents: number;
	/** The FINALIZED ledger total the operator saw — the watermark (DA-3a) and the
	 *  third key component (F-2a). Integer minor units. */
	refundedSoFarCents: number;
	currency: string;
	reason?: string;
	/** Who refunded it; the operator, else `admin`, when absent or blank. */
	refundedBy?: string;
}

export type RefundOutcome =
	/** The ledger could not be re-read, so nothing was attempted. */
	| { kind: "ledger_unreadable" }
	/** This refund is already on the ledger (its own recorded row, or the
	 *  service's duplicate answer). Nothing more was refunded. */
	| { kind: "already_refunded" }
	/** The ledger moved since the operator saw it — another refund. Nothing was
	 *  refunded; `remainingCents` is what is refundable now. */
	| { kind: "stale_ledger"; remainingCents: number; currency: string }
	/** The write was attempted and refused; `reason` is the service's typed one. */
	| { kind: "failed"; reason: string | undefined; currency: string }
	| { kind: "refunded"; fullyRefunded: boolean; email: InlineEmailStatus | undefined };

/**
 * Refund an order, against the ledger watermark the operator saw.
 *
 * TWO RULES APPLY TOGETHER (see `orders-actions.ts`'s `refundOrderAction` for the
 * full rationale): DA-3a re-reads the ledger and refuses on a watermark mismatch,
 * and F-2a derives the key `admin-refund:${orderId}:${amountCents}:${refundedSoFarCents}`,
 * so a retry with the same inputs dedupes while a deliberate second refund at the
 * moved watermark applies. A VOIDED attempt spends its key: the key gains `:v<n>`,
 * `n` being the count of THIS refund's voided attempts on the live ledger.
 *
 * A retry after the refund went through finds its own `recorded` row and REPLAYS
 * it under the key it was recorded with (issue #405, item 3), so a revoke of
 * download access that a crash interrupted is finished; the answer is
 * `already_refunded` whatever the replay says.
 */
export async function refundOrder(
	client: AdminOrdersSurface,
	input: RefundInput,
	operator: string | undefined,
): Promise<RefundOutcome> {
	const { orderId, amountCents, refundedSoFarCents: observedSoFar } = input;
	assertInput(
		isMinorUnits(amountCents) && amountCents > 0,
		"amountCents must be a positive integer",
	);
	assertInput(isMinorUnits(observedSoFar), "refundedSoFarCents must be a non-negative integer");
	assertInput(nonBlank(input.currency), "currency is required");
	const currency = input.currency.trim();
	const reason = (input.reason ?? "").trim();
	const refundedBy = (input.refundedBy ?? "").trim();
	// DA-3a: re-read, then compare against the watermark the operator SAW.
	const live = await client.getRefunds(orderId).catch(() => null);
	if (live === null) return { kind: "ledger_unreadable" };
	const liveCur = live.currency.length > 0 ? live.currency : currency;
	// The observed watermark is the third key component (F-2a) — NOT a nonce.
	const baseKey = `admin-refund:${orderId}:${amountCents}:${observedSoFar}`;
	if (live.finalizedTotalCents !== observedSoFar) {
		// THIS submission already recorded (a retry or a resubmitted page after it
		// went through): the ledger moved because of it.
		const ownRecorded = live.refunds.find(
			(r) =>
				r.status === "recorded" &&
				(r.idempotencyKey === baseKey || r.idempotencyKey.startsWith(`${baseKey}:v`)),
		);
		if (ownRecorded !== undefined) {
			// REPLAY IT, under the key it was recorded with (issue #405, item 3). The
			// refund is recorded before the order's download access is revoked, so a
			// process that died between the two left a `refunded` order whose grants
			// are still active — and THIS retry is the one that is meant to finish
			// the job. Answering from the ledger alone never reached the service, so
			// the revoke never ran. The domain resolves a `recorded` key as a benign
			// duplicate with NO provider call, and revokes there when the order is
			// `refunded`; `revokeByOrder` is idempotent, so on the ordinary
			// double-click this costs a read and changes nothing. The row's own
			// amount, currency and name are sent, so the domain's same-request check
			// matches by construction.
			//
			// Whatever the replay answers, the outcome stays `already_refunded`: the
			// money is on the ledger, and that is the caller's question. A refusal
			// here (the order's gateway unwired since, say) cannot heal the revoke,
			// and the residual is the one `refund-order.ts` names — a `refunded`
			// order, which the download route refuses on. A revoke that THROWS
			// propagates, so the caller sees a failure and tries again.
			const replay = await client.refundOrder(
				orderId,
				{
					amountCents: ownRecorded.amountCents,
					currency: ownRecorded.currency,
					refundedBy: ownRecorded.refundedBy,
				},
				{ idempotencyKey: ownRecorded.idempotencyKey },
			);
			// A refused replay is a revoke that did not finish — leave a trace. Status
			// and the typed reason code only: no order id, key, name or amount.
			if (!replay.ok) {
				console.warn(
					`[otta] refund replay refused (status ${String(replay.status)}, reason ${replay.reason ?? "none"}); download access may not have been revoked`,
				);
			}
			return { kind: "already_refunded" };
		}
		// The genuinely CONCURRENT case: the ledger moved between the confirm being
		// drawn and this call.
		return { kind: "stale_ledger", remainingCents: live.remainingCents, currency: liveCur };
	}
	const voidedAttempts = live.refunds.filter(
		(r) =>
			r.status === "voided" &&
			(r.idempotencyKey === baseKey || r.idempotencyKey.startsWith(`${baseKey}:v`)),
	).length;
	const key = voidedAttempts > 0 ? `${baseKey}:v${String(voidedAttempts)}` : baseKey;
	const result = await client.refundOrder(
		orderId,
		{
			amountCents,
			currency,
			...(reason.length > 0 ? { reason } : {}),
			// The given name, else the signed-in operator, else "admin".
			refundedBy: refundedBy.length > 0 ? refundedBy : (operator ?? "admin"),
		},
		{ idempotencyKey: key },
	);
	if (!result.ok) return { kind: "failed", reason: result.reason, currency: liveCur };
	// A benign replay: the SAME amount against the SAME watermark.
	if (result.duplicate) return { kind: "already_refunded" };
	return { kind: "refunded", fullyRefunded: result.fullyRefunded, email: result.email };
}

export interface ResolveUnverifiedRefundInput {
	orderId: string;
	/** The idempotency key of the `unverified` ledger row. */
	refundKey: string;
	outcome: "confirmed" | "voided";
	/** The provider's refund id; sent only with `confirmed`. */
	refundRef?: string;
}

/**
 * A person's answer to a refund whose provider outcome is UNKNOWN: `confirmed`
 * records it as refunded, `voided` releases it. No key — the domain refuses any
 * row that is not `unverified`, and a replay changes nothing. The operator is
 * recorded on the row, `admin` when the host named nobody.
 */
export async function resolveUnverifiedRefund(
	client: AdminOrdersSurface,
	input: ResolveUnverifiedRefundInput,
	operator: string | undefined,
): Promise<ResolveUnverifiedRefundResult> {
	assertInput(nonBlank(input.refundKey), "refundKey is required");
	const refundRef = (input.refundRef ?? "").trim();
	return await client.resolveUnverifiedRefund(input.orderId, {
		refundKey: input.refundKey.trim(),
		outcome: input.outcome,
		...(input.outcome === "confirmed" && refundRef.length > 0 ? { refundRef } : {}),
		resolvedBy: operator ?? "admin",
	});
}

// -- status moves and cancellation ----------------------------------------------

/** The settlement of the order a transition re-read: what the caller's copy
 *  branches on (ADR-0044's cash-on-delivery wording). */
export type OrderSettlement = "gateway" | "offline" | null;

export interface TransitionInput {
	orderId: string;
	/** One of `ORDER_STATES`. */
	toState: string;
	/** The order state the operator saw — the DA-3a watermark. Required. */
	observedState: string;
}

export type TransitionOutcome =
	/** The order could not be re-read, so nothing was attempted. */
	| { kind: "order_unreadable" }
	/** The order moved since the operator saw it; nothing was attempted. */
	| { kind: "state_changed"; liveState: string }
	| { kind: "attempted"; result: TransitionOrderResult; settlement: OrderSettlement };

/**
 * Move an order to `toState`, refusing when it is no longer in the state the
 * operator saw (DA-3a, mandatory: `shipped → refunded` is legal, so the domain's
 * guarded flip is no defence against a decision made while looking at `paid`).
 * Key `admin-transition:${orderId}:${toState}`; the operator is the recorded actor.
 */
export async function transitionOrder(
	client: AdminOrdersSurface,
	input: TransitionInput,
	operator: string | undefined,
): Promise<TransitionOutcome> {
	const { orderId, toState } = input;
	assertInput(
		(ORDER_STATES as readonly string[]).includes(toState),
		`unknown order state: ${toState}`,
	);
	assertInput(nonBlank(input.observedState), "observedState is required");
	const observedState = input.observedState.trim();
	const live = await client.getOrder(orderId).catch(() => null);
	if (live === null) return { kind: "order_unreadable" };
	if (live.order.state !== observedState) {
		return { kind: "state_changed", liveState: live.order.state };
	}
	const key = `admin-transition:${orderId}:${toState}`;
	const result = await client.transitionOrder(orderId, toState, {
		idempotencyKey: key,
		...(operator !== undefined ? { actor: operator } : {}),
	});
	return { kind: "attempted", result, settlement: live.order.settlement };
}

export interface CancelInput {
	orderId: string;
	/** A `CancellationReason` wire value; the service validates it. */
	reason: string;
	/** The order state the operator saw — the DA-3a watermark. Required. */
	observedState: string;
	detail?: string;
	/** Who cancelled it; the operator, else `admin`, when absent or blank. */
	cancelledBy?: string;
	/** Return the items to stock. REQUIRED for any order that is not unpaid
	 *  (issue #364): absent there is `restock_choice_required`, never a guess. */
	restock?: boolean;
}

export type CancelOutcome =
	| { kind: "order_unreadable" }
	| { kind: "state_changed"; liveState: string }
	/** A paid-side order's cancel with no restock choice; nothing was attempted. */
	| { kind: "restock_choice_required" }
	/** `restock` is the choice the write was sent with. */
	| { kind: "attempted"; result: CancelOrderResult; restock: boolean };

/**
 * Cancel an order with a structured reason, refusing when it is no longer in the
 * state the operator saw (DA-3a). A paid order is refunded and — unless
 * `restock` is false — restocked by the service. Key `admin-cancel:${orderId}`;
 * the refund and restock legs derive theirs from it, so a retry replays one
 * cancellation rather than refunding twice.
 */
export async function cancelOrder(
	client: AdminOrdersSurface,
	input: CancelInput,
	operator: string | undefined,
): Promise<CancelOutcome> {
	const { orderId, reason } = input;
	assertInput(nonBlank(input.observedState), "observedState is required");
	const observedState = input.observedState.trim();
	const detail = (input.detail ?? "").trim();
	const cancelledBy = (input.cancelledBy ?? "").trim();
	const live = await client.getOrder(orderId).catch(() => null);
	if (live === null) return { kind: "order_unreadable" };
	if (live.order.state !== observedState) {
		return { kind: "state_changed", liveState: live.order.state };
	}
	// An UNPAID order's cancel releases its held stock whatever the choice says, so
	// none is required there. On any other order an absent choice is refused.
	if (!UNPAID_ORDER_STATES.has(observedState) && input.restock === undefined) {
		return { kind: "restock_choice_required" };
	}
	const restock = input.restock !== false;
	const key = `admin-cancel:${orderId}`;
	const result = await client.cancelOrder(
		orderId,
		{
			reason,
			...(detail.length > 0 ? { detail } : {}),
			// The given name, else the signed-in operator, else "admin".
			cancelledBy: cancelledBy.length > 0 ? cancelledBy : (operator ?? "admin"),
			restock,
		},
		{ idempotencyKey: key },
	);
	return { kind: "attempted", result, restock };
}

// -- fulfilment, notes, downloads, reconciliation -------------------------------

export interface RecordFulfillmentInput {
	orderId: string;
	carrier: string;
	trackingNumber: string;
	/** An http(s) URL; it is emailed to the buyer. */
	trackingUrl?: string;
	/** A full ISO datetime. */
	shippedAt?: string;
	recordedBy: string;
}

/**
 * Record a shipment, which ships the order. Key `admin-record-fulfillment:${orderId}`.
 * The tracking URL must be http(s) — the bound the service schema enforces, held
 * here too because the value is emailed to the buyer.
 */
export async function recordFulfillment(
	client: AdminOrdersSurface,
	input: RecordFulfillmentInput,
	_operator: string | undefined,
): Promise<RecordFulfillmentResult> {
	const { orderId } = input;
	const carrier = input.carrier.trim();
	const trackingNumber = input.trackingNumber.trim();
	const recordedBy = input.recordedBy.trim();
	const trackingUrl = (input.trackingUrl ?? "").trim();
	assertInput(
		carrier.length > 0 && trackingNumber.length > 0 && recordedBy.length > 0,
		"carrier, trackingNumber and recordedBy are required",
	);
	assertInput(
		trackingUrl.length === 0 || /^https?:\/\/\S+$/i.test(trackingUrl),
		"trackingUrl must be an http(s) URL",
	);
	const shippedAt = input.shippedAt;
	return await client.recordFulfillment(
		orderId,
		{
			carrier,
			trackingNumber,
			...(trackingUrl.length > 0 ? { trackingUrl } : {}),
			...(shippedAt !== undefined && shippedAt.length > 0 ? { shippedAt } : {}),
			recordedBy,
		},
		{ idempotencyKey: `admin-record-fulfillment:${orderId}` },
	);
}

export interface AddNoteInput {
	orderId: string;
	author: string;
	body: string;
}

/** Append a note. Content-derived key `admin-note:${orderId}:${author}:${body}`
 *  (F-2a): the same note twice is a no-op, a new note appends. */
export async function addOrderNote(
	client: AdminOrdersSurface,
	input: AddNoteInput,
	_operator: string | undefined,
): Promise<AddNoteResult> {
	const author = input.author.trim();
	const body = input.body.trim();
	assertInput(author.length > 0 && body.length > 0, "author and body are required");
	return await client.addNote(
		input.orderId,
		{ author, body },
		{ idempotencyKey: `admin-note:${input.orderId}:${author}:${body}` },
	);
}

export interface RevokeDownloadAccessInput {
	orderId: string;
}

/** Close a paid order's download access by hand (issue #447). One key per order,
 *  `admin-revoke-downloads:${orderId}` — revocation is terminal. Recorded as the
 *  operator, `admin` when the host named nobody. */
export async function revokeDownloadAccess(
	client: AdminOrdersSurface,
	input: RevokeDownloadAccessInput,
	operator: string | undefined,
): Promise<RevokeDownloadAccessResult> {
	const orderId = input.orderId.trim();
	assertInput(orderId.length > 0, "orderId is required");
	return await client.revokeDownloadAccess(
		orderId,
		{ revokedBy: operator ?? "admin" },
		{ idempotencyKey: `admin-revoke-downloads:${orderId}` },
	);
}

export interface ResolveReconciliationInput {
	orderId: string;
	/** The flag AS DISPLAYED — the compare-and-clear key. */
	expectedFlag: string;
	outcome: string;
	reason: string;
	resolvedBy: string;
}

/**
 * Resolve an order's reconciliation flag, compare-and-clear against the flag the
 * operator saw. Key `admin-resolve-reconciliation:${orderId}` — carried verbatim,
 * including its known follow-up (no `expectedFlag` component; see the module
 * header of `orders-actions.ts`).
 */
export async function resolveReconciliation(
	client: AdminOrdersSurface,
	input: ResolveReconciliationInput,
	_operator: string | undefined,
): Promise<ResolveReconciliationResult> {
	const reason = input.reason.trim();
	const resolvedBy = input.resolvedBy.trim();
	assertInput(reason.length > 0 && resolvedBy.length > 0, "reason and resolvedBy are required");
	return await client.resolveReconciliation(
		input.orderId,
		{ expectedFlag: input.expectedFlag, outcome: input.outcome, reason, resolvedBy },
		{ idempotencyKey: `admin-resolve-reconciliation:${input.orderId}` },
	);
}
