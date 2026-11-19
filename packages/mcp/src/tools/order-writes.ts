/**
 * The order WRITE tools. Each one validates its input, calls the plugin's admin
 * OPERATION (never a surface write directly — the operation owns the ledger and
 * order re-reads and every derived idempotency key, so a guard the console has
 * holds here too), and turns the operation's outcome into either success data or
 * a `toolFailure` with a stable code an agent can branch on.
 *
 * A refusal the service typed keeps the service's code (`REFUND_EXCEEDS_TOTAL`,
 * `USE_CANCEL`, `NO_DOWNLOADS`, …), except `ORDER_NOT_FOUND`, which is `NOT_FOUND`
 * like every other "no such order"; an untyped one falls back on its status
 * (404 → `NOT_FOUND`, 400 → `INVALID_INPUT`), else a per-tool code.
 */
import type { CancellationReason, OrderState, ReconciliationOutcome } from "@urumi.ai/otta-plugin";
import {
	addOrderNote,
	cancelOrder,
	recordFulfillment,
	refundOrder,
	resolveReconciliation,
	resolveUnverifiedRefund,
	revokeDownloadAccess,
	transitionOrder,
} from "@urumi.ai/otta-plugin";
import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { defined, MONEY_NOTE, operate } from "./common.js";
import { type Complete, unhandled } from "./unhandled.js";

/**
 * The order states, restated from `@urumi.ai/otta-admin-presentation`'s
 * `ORDER_STATES` (this package does not depend on it). A state outside the list
 * is refused at the schema, as the operation would refuse it.
 */
const ORDER_STATES = [
	"pending",
	"paid",
	"failed",
	"expired",
	"processing",
	"shipped",
	"delivered",
	"completed",
	"cancelled",
	"refunded",
	"awaiting_payment",
	"shipped_awaiting_payment",
] as const satisfies readonly OrderState[];

/** The domain's `CancellationReason`. */
const CANCELLATION_REASONS = [
	"customer_request",
	"fraud_suspected",
	"out_of_stock",
	"pricing_error",
	"other",
] as const satisfies readonly CancellationReason[];

/** The domain's `ReconciliationOutcome`. */
const RECONCILIATION_OUTCOMES = [
	"refunded",
	"fulfilled",
	"written_off",
	"restocked",
] as const satisfies readonly ReconciliationOutcome[];

const orderStatesComplete: Complete<OrderState, typeof ORDER_STATES> = true;
const cancellationReasonsComplete: Complete<CancellationReason, typeof CANCELLATION_REASONS> = true;
const reconciliationOutcomesComplete: Complete<
	ReconciliationOutcome,
	typeof RECONCILIATION_OUTCOMES
> = true;
void [orderStatesComplete, cancellationReasonsComplete, reconciliationOutcomesComplete];

const orderIdInput = z.string().min(1).describe("The order id from orders_list or orders_get.");
const observedStateInput = z
	.enum(ORDER_STATES)
	.describe(
		"The order's `state` exactly as orders_get returned it. If the order has moved since, nothing is changed and the call fails with STATE_CHANGED (details.liveState): read the order again and decide again.",
	);
const minorUnits = z.number().int().nonnegative();

/** A surface write's refusal → its typed reason, else a code from its status. */
function refuse(
	result: { status: number; reason?: string | undefined },
	fallback: string,
	message: string,
	details?: Record<string, unknown>,
): never {
	// One code for "no such order" across every tool, whichever layer said so.
	const reason = result.reason === "ORDER_NOT_FOUND" ? "NOT_FOUND" : result.reason;
	const code =
		reason ??
		(result.status === 404 ? "NOT_FOUND" : result.status === 400 ? "INVALID_INPUT" : fallback);
	return toolFailure(code, message, { status: result.status, ...details });
}

const notFound = (orderId: string): never =>
	toolFailure("NOT_FOUND", `No order ${orderId} (or it could not be read). Nothing was changed.`);

const stateChanged = (liveState: string): never =>
	toolFailure(
		"STATE_CHANGED",
		`The order is now ${liveState}, not the state you passed. Nothing was changed; read it again with orders_get.`,
		{ liveState },
	);

export const ORDER_WRITE_TOOLS = [
	defineTool({
		name: "orders_transition",
		description:
			'Move an order to another state (for example paid → processing, shipped → delivered). Use one of the order\'s `allowedTransitions` from orders_get, and pass its current `state` as `observedState`. Cancelling is orders_cancel and refunding is orders_refund: a bare move to cancelled fails USE_CANCEL. Returns `{status: "transitioned" | "unchanged", settlement, email?}`; a refusal keeps the service\'s code (INVALID_TRANSITION, USE_CANCEL, MANUAL_PAYMENT_NOT_ALLOWED, REFUND_THROUGH_MONEY, REFUND_IN_FLIGHT, MARK_PAID_RETRY, NOT_FOUND).',
		input: z
			.object({
				orderId: orderIdInput,
				toState: z.enum(ORDER_STATES).describe("The state to move the order to."),
				observedState: observedStateInput,
			})
			.strict(),
		async run({ clients, input, operator }) {
			const outcome = await operate(() => transitionOrder(clients.orders, input, operator));
			switch (outcome.kind) {
				case "order_unreadable":
					return notFound(input.orderId);
				case "state_changed":
					return stateChanged(outcome.liveState);
				case "attempted": {
					const { result } = outcome;
					if (!result.ok) {
						return refuse(
							result,
							"TRANSITION_FAILED",
							`The order was not moved to ${input.toState}.`,
						);
					}
					return defined({
						status: result.transitioned ? "transitioned" : "unchanged",
						settlement: outcome.settlement,
						email: result.email,
					});
				}
				default:
					return unhandled(outcome);
			}
		},
	}),
	defineTool({
		name: "orders_record_fulfillment",
		description:
			'Record a shipment, which ships the order (processing → shipped, or awaiting_payment → shipped_awaiting_payment for an unpaid cash-on-delivery order) and emails the buyer the tracking. Retrying is safe: an order already shipped answers `{status: "unchanged"}`. Returns `{status: "recorded", state, email?}`; NOT_FULFILLABLE when the order cannot ship from its state.',
		input: z
			.object({
				orderId: orderIdInput,
				carrier: z.string().min(1).max(200).describe("The carrier, e.g. UPS."),
				trackingNumber: z.string().min(1).max(200),
				trackingUrl: z
					.string()
					.min(1)
					.optional()
					.describe("An http(s) tracking link; it is emailed to the buyer."),
				shippedAt: z
					.string()
					.min(1)
					.optional()
					.describe("When it shipped, a full ISO-8601 datetime. Defaults to now."),
			})
			.strict(),
		async run({ clients, input, operator }) {
			const result = await operate(() =>
				recordFulfillment(
					clients.orders,
					{
						orderId: input.orderId,
						carrier: input.carrier,
						trackingNumber: input.trackingNumber,
						...(input.trackingUrl === undefined ? {} : { trackingUrl: input.trackingUrl }),
						...(input.shippedAt === undefined ? {} : { shippedAt: input.shippedAt }),
						recordedBy: operator ?? "admin",
					},
					operator,
				),
			);
			if (!result.ok) {
				return refuse(result, "FULFILLMENT_FAILED", "The shipment was not recorded.");
			}
			return defined({
				status: result.recorded ? "recorded" : "unchanged",
				state: result.state,
				email: result.email,
			});
		},
	}),
	defineTool({
		name: "orders_cancel",
		description: `Cancel an order with a reason. A paid order is refunded what is still refundable, through its own payment provider, as part of the cancel. Pass the order's current \`state\` as \`observedState\`. For any order that is not unpaid you MUST choose \`restock\` (true returns the units to stock, false keeps them off sale); without it the call fails RESTOCK_CHOICE_REQUIRED and nothing changes. Returns \`{status: "cancelled" | "unchanged", restock, refund, restockedUnits, restockPending?, restockSkipped?, email?}\`. A refusal keeps the service's code (NOT_CANCELLABLE, REFUND_FAILED with details.refundFailure, CANCEL_LOST_AFTER_REFUND, CANCEL_INCOMPLETE_AFTER_REFUND, …) and its details say what DID move. ${MONEY_NOTE}`,
		destructive: true,
		input: z
			.object({
				orderId: orderIdInput,
				reason: z.enum(CANCELLATION_REASONS).describe("Why the order is cancelled."),
				observedState: observedStateInput,
				restock: z
					.boolean()
					.optional()
					.describe(
						"Return the items to stock. Required unless the order is unpaid (pending, awaiting_payment, shipped_awaiting_payment).",
					),
				detail: z
					.string()
					.max(4000)
					.optional()
					.describe("Free-text detail, most useful with `other`."),
			})
			.strict(),
		async run({ clients, input, operator }) {
			const outcome = await operate(() =>
				cancelOrder(
					clients.orders,
					{
						orderId: input.orderId,
						reason: input.reason,
						observedState: input.observedState,
						...(input.restock === undefined ? {} : { restock: input.restock }),
						...(input.detail === undefined ? {} : { detail: input.detail }),
					},
					operator,
				),
			);
			switch (outcome.kind) {
				case "order_unreadable":
					return notFound(input.orderId);
				case "state_changed":
					return stateChanged(outcome.liveState);
				case "restock_choice_required":
					return toolFailure(
						"RESTOCK_CHOICE_REQUIRED",
						"This order is paid, so say whether its items go back to stock: call again with restock true or false. Nothing was changed.",
					);
				case "attempted": {
					const { result, restock } = outcome;
					if (!result.ok) {
						const { ok: _ok, status: _status, reason: _reason, ...moved } = result;
						return refuse(result, "CANCEL_FAILED", "The order was not cancelled.", moved);
					}
					const { ok: _ok, cancelled, ...rest } = result;
					return defined({ status: cancelled ? "cancelled" : "unchanged", restock, ...rest });
				}
				default:
					return unhandled(outcome);
			}
		},
	}),
	defineTool({
		name: "orders_refund",
		description: `Refund money on an order, through its payment provider (or, for an offline method such as cash on delivery, record a refund made off-platform). Read the order with orders_get first: \`amountCents\` must not exceed \`refunds.remainingCents\`. Pass refundedSoFarCents exactly as orders_get returned it. Retrying with identical arguments is safe and never refunds twice. Returns \`{status: "refunded", fullyRefunded, email?}\`, or \`{status: "already_refunded"}\` when this refund is already on the ledger. Fails REFUND_LEDGER_CHANGED (details.remainingCents) when another refund moved the ledger since you read it: nothing was refunded; read the order again before deciding. Other refusals keep the service's code (REFUND_EXCEEDS_TOTAL, REFUND_GATEWAY_UNAVAILABLE, GATEWAY_TERMINAL, …). GATEWAY_UNVERIFIED means the provider's outcome is UNKNOWN: do not retry; check the provider, then answer it with orders_resolve_unverified_refund. ${MONEY_NOTE}`,
		destructive: true,
		input: z
			.object({
				orderId: orderIdInput,
				amountCents: z
					.number()
					.int()
					.positive()
					.describe("The amount to refund, integer minor units (500 = 5.00)."),
				refundedSoFarCents: minorUnits.describe(
					"`refunds.refundedSoFarCents` from orders_get, unchanged.",
				),
				currency: z.string().length(3).describe("The order's ISO-4217 currency code."),
				reason: z.string().max(4000).optional().describe("Why, for the ledger."),
			})
			.strict(),
		async run({ clients, input, operator }) {
			const outcome = await operate(() =>
				refundOrder(
					clients.orders,
					{
						orderId: input.orderId,
						amountCents: input.amountCents,
						refundedSoFarCents: input.refundedSoFarCents,
						currency: input.currency,
						...(input.reason === undefined ? {} : { reason: input.reason }),
					},
					operator,
				),
			);
			switch (outcome.kind) {
				case "ledger_unreadable":
					return notFound(input.orderId);
				case "already_refunded":
					return { status: "already_refunded" };
				case "stale_ledger":
					return toolFailure(
						"REFUND_LEDGER_CHANGED",
						"The order's refunds changed since you read them. Nothing was refunded; read the order again with orders_get before deciding.",
						{ remainingCents: outcome.remainingCents, currency: outcome.currency },
					);
				case "failed":
					return toolFailure(
						outcome.reason ?? "REFUND_FAILED",
						outcome.reason === "GATEWAY_UNVERIFIED"
							? "The payment provider's outcome is unknown: the refund may or may not have been issued. Do not retry; check the provider, then use orders_resolve_unverified_refund."
							: "The refund was not made.",
						{ currency: outcome.currency },
					);
				case "refunded":
					return defined({
						status: "refunded",
						fullyRefunded: outcome.fullyRefunded,
						email: outcome.email,
					});
				default:
					return unhandled(outcome);
			}
		},
	}),
	defineTool({
		name: "orders_resolve_unverified_refund",
		description:
			'Answer a refund whose provider outcome is unknown (an `unverified` row in orders_get\'s `refunds`, identified by its idempotency key): `confirmed` records it as refunded (pass the provider\'s refund id as `refundRef`), `voided` releases it. Check the payment provider first. Retrying the same answer changes nothing. Returns `{status: "resolved" | "unchanged", fullyRefunded, email?, followUp?}`.',
		input: z
			.object({
				orderId: orderIdInput,
				refundKey: z.string().min(1).describe("The unverified refund row's `idempotencyKey`."),
				outcome: z.enum(["confirmed", "voided"]),
				refundRef: z
					.string()
					.min(1)
					.optional()
					.describe("The provider's refund id; used only with `confirmed`."),
			})
			.strict(),
		async run({ clients, input, operator }) {
			const result = await operate(() =>
				resolveUnverifiedRefund(
					clients.orders,
					{
						orderId: input.orderId,
						refundKey: input.refundKey,
						outcome: input.outcome,
						...(input.refundRef === undefined ? {} : { refundRef: input.refundRef }),
					},
					operator,
				),
			);
			if (!result.ok) {
				return refuse(result, "RESOLVE_REFUND_FAILED", "The refund was not resolved.");
			}
			const { ok: _ok, changed, ...rest } = result;
			return defined({ status: changed ? "resolved" : "unchanged", ...rest });
		},
	}),
	defineTool({
		name: "orders_resolve_reconciliation",
		description:
			'Clear an order\'s reconciliation flag with a disposition. Pass `expectedFlag` exactly as orders_get\'s `reconciliationFlag` returned it: if a new anomaly was flagged since, nothing is cleared and the call fails RECONCILIATION_FLAG_CHANGED. Returns `{status: "resolved" | "unchanged"}`; NOT_IN_RECONCILIATION when the order carries no flag.',
		input: z
			.object({
				orderId: orderIdInput,
				expectedFlag: z.string().min(1).describe("The order's `reconciliationFlag`, unchanged."),
				outcome: z.enum(RECONCILIATION_OUTCOMES).describe("How it was resolved."),
				reason: z.string().min(1).max(4000).describe("Why, for the record."),
			})
			.strict(),
		async run({ clients, input, operator }) {
			const result = await operate(() =>
				resolveReconciliation(
					clients.orders,
					{ ...input, resolvedBy: operator ?? "admin" },
					operator,
				),
			);
			if (!result.ok) {
				return refuse(result, "RESOLVE_RECONCILIATION_FAILED", "The flag was not cleared.");
			}
			return { status: result.resolved ? "resolved" : "unchanged" };
		},
	}),
	defineTool({
		name: "orders_add_note",
		description:
			'Add an internal note to an order (never shown to the buyer), authored by you. Adding the same note twice is a no-op. Returns `{status: "appended" | "unchanged", note}`.',
		input: z
			.object({
				orderId: orderIdInput,
				body: z.string().min(1).max(4000).describe("The note text."),
			})
			.strict(),
		async run({ clients, input, operator }) {
			const result = await operate(() =>
				addOrderNote(
					clients.orders,
					{ orderId: input.orderId, author: operator ?? "admin", body: input.body },
					operator,
				),
			);
			if (!result.ok) return refuse(result, "NOTE_FAILED", "The note was not added.");
			return { status: result.appended ? "appended" : "unchanged", note: result.note };
		},
	}),
	defineTool({
		name: "orders_revoke_download_access",
		description:
			'Close a paid order\'s digital download links. This cannot be undone; the order and its money are unchanged. Returns `{status: "revoked" | "unchanged"}`; NO_DOWNLOADS when the order has no digital line, NOT_DELIVERABLE when it is not a paid order.',
		destructive: true,
		input: z.object({ orderId: orderIdInput }).strict(),
		async run({ clients, input, operator }) {
			const result = await operate(() =>
				revokeDownloadAccess(clients.orders, { orderId: input.orderId }, operator),
			);
			if (!result.ok) return refuse(result, "REVOKE_FAILED", "Download access was not revoked.");
			return { status: result.revoked ? "revoked" : "unchanged" };
		},
	}),
];
