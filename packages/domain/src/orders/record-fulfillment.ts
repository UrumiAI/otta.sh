import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { OrderStore } from "../ports/order-store.js";
import type { Order } from "./model.js";
import { emailTemplateForState } from "./state-machine.js";

export interface RecordFulfillmentDeps {
	orderStore: OrderStore;
}

export interface RecordFulfillmentCommand {
	orderId: OrderId;
	/** Shipping carrier (free text) — trimmed + required non-empty. */
	carrier: string;
	/** Carrier tracking number (free text) — trimmed + required non-empty. */
	trackingNumber: string;
	/** Optional carrier tracking URL — trimmed; an empty/blank value normalizes to
	 *  null (the buyer's tracking link is optional, unlike carrier + number). */
	trackingUrl?: string | null;
	/** When the order shipped (ISO-8601 UTC). Optional — null/absent ⇒ the store
	 *  stamps its own clock at record time (the common "ship it now" case). */
	shippedAt?: string | null;
	/** Who recorded it — trimmed + required non-empty (mirrors an order note's
	 *  `author`; the domain does not model admin identity). */
	recordedBy: string;
	/** Every command carries one (CLAUDE.md); the store's guarded flip enforces
	 *  once-only. */
	idempotencyKey: IdempotencyKey;
}

export type RecordFulfillmentFailure =
	| "ORDER_NOT_FOUND"
	/** The order is not in a state where fulfillment is meaningful — recording
	 *  fulfillment ships the order (`processing → shipped`), so the order must be
	 *  in `processing`. Anything else (draft/pending/paid/cancelled/refunded/…, or
	 *  already shipped by the bare transition without fulfillment) is rejected: the
	 *  admin should move the order to `processing` first and ship it via this form. */
	| "NOT_FULFILLABLE"
	| "EMPTY_CARRIER"
	| "EMPTY_TRACKING_NUMBER"
	| "EMPTY_RECORDER";

export type RecordFulfillmentOutcome =
	| { ok: true; recorded: boolean; order: Order }
	| { ok: false; reason: RecordFulfillmentFailure };

/**
 * Record an order's shipping fulfillment (admin-UX Increment 1). Pure
 * orchestration — no IO of its own: validate, confirm the order is in the one
 * state where shipping is legal (`processing` — the sole pre-`shipped` state in
 * the machine), then delegate the guarded "record + ship + enqueue email"
 * compose to the store.
 *
 * Recording fulfillment IS the act of shipping: it drives the `processing →
 * shipped` transition atomically with writing the tracking envelope and enqueuing
 * the shipped email, so the buyer's shipped notification always carries tracking
 * (never the old empty "your order is on its way"). It only ever touches the
 * mutable fulfillment envelope + the guarded state flip — NEVER line items, prices
 * or totals (the snapshot invariant).
 *
 * Legality + idempotency, mirroring `transitionOrder`/`resolveReconciliation`:
 *  - a **`processing`** order ships once; the store's guarded `WHERE
 *    state='processing'` flip makes concurrent/replayed calls a 0-row no-op, so
 *    exactly one fulfillment is written and exactly one shipped email enqueued;
 *  - an **already-shipped-with-fulfillment** order is an idempotent no-op success
 *    (`recorded:false`) — a redelivery / double-submit is not an error;
 *  - any **other state** (incl. an order shipped by the bare transition without
 *    fulfillment, or a cancelled/refunded/pending order) is rejected
 *    `NOT_FULFILLABLE` — you cannot ship what is not ready to ship.
 */
export async function recordFulfillment(
	deps: RecordFulfillmentDeps,
	cmd: RecordFulfillmentCommand,
): Promise<RecordFulfillmentOutcome> {
	const carrier = cmd.carrier.trim();
	const trackingNumber = cmd.trackingNumber.trim();
	const recordedBy = cmd.recordedBy.trim();
	if (carrier.length === 0) return { ok: false, reason: "EMPTY_CARRIER" };
	if (trackingNumber.length === 0) return { ok: false, reason: "EMPTY_TRACKING_NUMBER" };
	if (recordedBy.length === 0) return { ok: false, reason: "EMPTY_RECORDER" };
	// The tracking URL is optional: trim and treat a blank as "none" (null).
	const trimmedUrl = (cmd.trackingUrl ?? "").trim();
	const trackingUrl = trimmedUrl.length === 0 ? null : trimmedUrl;
	// A blank shippedAt likewise normalizes to null so the store stamps its clock.
	const trimmedShippedAt = (cmd.shippedAt ?? "").trim();
	const shippedAt = trimmedShippedAt.length === 0 ? null : trimmedShippedAt;

	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };

	// Already shipped WITH fulfillment ⇒ benign idempotent no-op (a replay / double
	// submit). Any other non-`processing` state (incl. shipped-without-fulfillment,
	// i.e. shipped by the bare transition) is not fulfillable via this compose.
	if (order.state === "shipped") {
		if (order.fulfillment !== null) return { ok: true, recorded: false, order };
		return { ok: false, reason: "NOT_FULFILLABLE" };
	}
	if (order.state !== "processing") return { ok: false, reason: "NOT_FULFILLABLE" };

	const res = await deps.orderStore.recordFulfillment({
		orderId: cmd.orderId,
		carrier,
		trackingNumber,
		trackingUrl,
		shippedAt,
		recordedBy,
		idempotencyKey: cmd.idempotencyKey,
		// `shipped` always has a template — symmetric with `transitionOrder`.
		enqueueEmail: emailTemplateForState("shipped") !== null,
	});
	if (res.recorded) return { ok: true, recorded: true, order: res.order ?? order };

	// The guarded flip missed (0 rows) — someone moved the order out of `processing`
	// between our read and the UPDATE. Disambiguate on the fresh row: shipped WITH
	// fulfillment ⇒ a concurrent record won (benign no-op); anything else (a
	// concurrent cancel, refund, vanished) ⇒ not fulfillable.
	const fresh = res.order;
	if (fresh !== null && fresh.state === "shipped" && fresh.fulfillment !== null) {
		return { ok: true, recorded: false, order: fresh };
	}
	return { ok: false, reason: "NOT_FULFILLABLE" };
}
