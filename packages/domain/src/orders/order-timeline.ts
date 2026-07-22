import type { OrderId } from "../money/ids.js";
import type { OrderNotesStore } from "../ports/order-notes-store.js";
import type { OrderEvent, OrderStore } from "../ports/order-store.js";
import type { CancellationReason, OrderState, ReconciliationOutcome } from "./model.js";

export interface OrderTimelineDeps {
	orderStore: OrderStore;
	/** The append-only notes store — its notes are MERGED into the timeline at
	 *  read time (not re-written as events), keeping `order_events` the single
	 *  home of the state-change spine. */
	orderNotesStore: OrderNotesStore;
}

/**
 * One chronological entry in an order's timeline (admin-UX Increment 1, timeline
 * slice). A discriminated union — the domain produces STRUCTURED entries and the
 * plugin renders them (no presentation strings here). Entries come from two
 * sources, merged at read time:
 *  - `state_change` — the durably-audited `order_events` spine (written inside
 *    the guarded flip that moved the order).
 *  - everything else — DERIVED from records that already carry their own
 *    timestamp (`created` from `order.createdAt`, `note` from `order_notes`,
 *    `fulfillment`/`cancellation`/`reconciliation_resolved` from the order's
 *    mutable envelope), so they are never double-written.
 */
export type OrderTimelineEntry =
	| { kind: "created"; at: string }
	| {
			kind: "state_change";
			at: string;
			fromState: OrderState | null;
			toState: OrderState | null;
			actor: string | null;
	  }
	| { kind: "note"; at: string; author: string; body: string }
	| {
			kind: "fulfillment";
			at: string;
			carrier: string;
			trackingNumber: string;
			trackingUrl: string | null;
			shippedAt: string;
			recordedBy: string;
	  }
	| {
			kind: "cancellation";
			at: string;
			reason: CancellationReason;
			detail: string | null;
			cancelledBy: string;
	  }
	| {
			kind: "reconciliation_resolved";
			at: string;
			outcome: ReconciliationOutcome;
			reason: string;
			resolvedBy: string;
	  };

export interface OrderTimeline {
	orderId: OrderId;
	/** The merged history, oldest-first. */
	entries: OrderTimelineEntry[];
	/**
	 * True iff at least one durable `state_change` event exists — i.e. the order
	 * transitioned AFTER this slice shipped. When false but the order has clearly
	 * advanced past `pending`, its transitions predate the audit log; the surface
	 * should note that the state-change history is partial (the derived artifacts
	 * still show what they can).
	 */
	stateChangesAudited: boolean;
}

/**
 * The chronological tie-break RANK when two entries share a timestamp (common
 * under a fixed test clock, or when a flip and its derived artifact are stamped
 * at the same instant — a shipped `state_change` and its `fulfillment` detail).
 * A creation precedes everything at its instant; the state flip precedes the
 * rich artifact that rode along in the same transaction; a note is last. This
 * makes the merge DETERMINISTIC across the two sources regardless of iteration
 * order.
 */
const KIND_RANK: Record<OrderTimelineEntry["kind"], number> = {
	created: 0,
	state_change: 1,
	fulfillment: 2,
	cancellation: 3,
	reconciliation_resolved: 4,
	note: 5,
};

/**
 * Assemble an order's timeline (admin-UX Increment 1, timeline slice). Pure
 * orchestration — no IO of its own; read-only (no idempotency concern). Merges
 * the durably-audited `order_events` state-change spine with the order's derived
 * artifacts (creation, notes, fulfillment, cancellation, reconciliation
 * resolution) into ONE chronological view.
 *
 * Degrades gracefully for historical orders: those whose transitions predate the
 * audit table have no `state_change` events, but their `created` moment, notes,
 * and any recorded fulfillment/cancellation/resolution still populate the
 * timeline (`stateChangesAudited` is false, so the surface can say the
 * state-change history is partial). Returns null iff the order does not exist.
 */
export async function getOrderTimeline(
	deps: OrderTimelineDeps,
	orderId: OrderId,
): Promise<OrderTimeline | null> {
	const order = await deps.orderStore.getById(orderId);
	if (order === null) return null;

	const [events, notes] = await Promise.all([
		deps.orderStore.listEventsForOrder(orderId),
		deps.orderNotesStore.listForOrder(orderId),
	]);

	const entries: OrderTimelineEntry[] = [];
	// Creation is DERIVED from created_at (every order has one — so this is the
	// one entry every timeline, historical or not, always carries).
	entries.push({ kind: "created", at: order.createdAt });
	// The durably-audited state-change spine.
	for (const e of events) entries.push(stateChangeEntry(e));
	// Notes — merged from the append-only notes store, not re-written as events.
	for (const n of notes)
		entries.push({ kind: "note", at: n.createdAt, author: n.author, body: n.body });
	// The single-slot mutable-envelope artifacts — each carries its own timestamp.
	if (order.fulfillment !== null) {
		const f = order.fulfillment;
		entries.push({
			kind: "fulfillment",
			at: f.recordedAt,
			carrier: f.carrier,
			trackingNumber: f.trackingNumber,
			trackingUrl: f.trackingUrl,
			shippedAt: f.shippedAt,
			recordedBy: f.recordedBy,
		});
	}
	if (order.cancellation !== null) {
		const c = order.cancellation;
		entries.push({
			kind: "cancellation",
			at: c.cancelledAt,
			reason: c.reason,
			detail: c.detail,
			cancelledBy: c.cancelledBy,
		});
	}
	if (order.reconciliationResolution !== null) {
		const r = order.reconciliationResolution;
		entries.push({
			kind: "reconciliation_resolved",
			at: r.resolvedAt,
			outcome: r.outcome,
			reason: r.reason,
			resolvedBy: r.resolvedBy,
		});
	}

	// Stable chronological sort: `at` ASC, then the kind rank, then insertion
	// order. `Array.prototype.sort` is stable, so entries equal on (at, rank) keep
	// insertion order — which for `events`/`notes` is already the store's
	// chronological order, so a same-instant tie is resolved deterministically.
	const indexed = entries.map((entry, index) => ({ entry, index }));
	indexed.sort((a, b) => {
		if (a.entry.at !== b.entry.at) return a.entry.at < b.entry.at ? -1 : 1;
		const rank = KIND_RANK[a.entry.kind] - KIND_RANK[b.entry.kind];
		return rank !== 0 ? rank : a.index - b.index;
	});

	return {
		orderId,
		entries: indexed.map((i) => i.entry),
		stateChangesAudited: events.length > 0,
	};
}

function stateChangeEntry(e: OrderEvent): OrderTimelineEntry {
	return {
		kind: "state_change",
		at: e.at,
		fromState: e.fromState,
		toState: e.toState,
		actor: e.actor,
	};
}
