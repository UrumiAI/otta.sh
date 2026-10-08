/**
 * Order model (Phase 4 §4). An order is an **immutable** record minted from a
 * cart: its line items snapshot price + title at purchase time, so a later
 * product edit never rewrites them (the headline snapshot invariant). Money is
 * branded `Cents` throughout — a plain `number` reaching a money field is a
 * compile error (DEVELOPMENT.md §4).
 */

import type { Cents, Currency } from "../money/cents.js";
import type { IdempotencyKey, OrderId, ProductId, ReservationId, Sku } from "../money/ids.js";

/**
 * Order state machine (Phase 4 §4 + Phase 5 §5). Phase 4 ships
 * `pending`/`paid`/`failed`/`expired`; Phase 5 adds the fulfillment + terminal
 * states. The legal-transition table + per-state email template live in
 * `orders/state-machine.ts` (a single exported map, not scattered conditionals).
 */
export type OrderState =
	| "pending"
	| "paid"
	| "failed"
	| "expired"
	// Phase 5 additions:
	| "processing"
	| "shipped"
	| "delivered"
	| "completed"
	| "cancelled"
	| "refunded";

/** A line's fulfillment path — copied from `product_commerce.product_kind` onto
 *  the order line so settle's commit-vs-grant branch has a stable input (§4). */
export type FulfillmentKind = "physical" | "digital";

/** The payment gateways (§5). One today; the alias is the seam a second gateway slots into. */
export type PaymentMethod = "stripe";

/**
 * A customer email about an order that is NOT a state transition. The outbox was
 * built keyed on `(orderId, toState)` because every order email used to announce a
 * state change; a late payment refunded on an already-`expired` order changes no
 * state, yet the buyer must hear about money that left their card and came back.
 * A notice rides the same outbox (durable retry, lease, at-least-once delivery) and
 * is first-wins per `(orderId, notice)` exactly as a state email is per
 * `(orderId, toState)`.
 *
 * - `late-payment-refunded` — a payment succeeded after the order had expired or
 *   been cancelled, and it was refunded automatically (`settleOrder`).
 * - `refund-issued` — an admin refund that left money captured (a partial refund),
 *   announced by the write that finalized it; or a cancellation's refund whose order
 *   shipped before the cancel landed, so no cancelled email will carry it
 *   (ADR-0026). One per refund.
 *
 * A notice is first-wins per `(orderId, kind, refundId)` — `refundId` absent
 * reads as none — so each refund announces itself once, however often the step
 * that enqueued it is replayed.
 */
export type OrderNotice = "late-payment-refunded" | "refund-issued";

/**
 * The admin's disposition when clearing a reconciliation flag (admin-UX
 * Increment 1). A resolution is a RECORD of the decision, never itself a money
 * movement: `refunded` means the refund was carried out through the ordinary
 * `refunded` state transition (or out of band), `fulfilled` means the order was
 * honored as-is (stock re-sourced), `written_off` means the loss/false-alarm was
 * accepted. The order's state machine + line snapshots are untouched either way.
 */
/** `restocked`: a cancellation's stuck restock landed (issue #364) — written by
 *  Otta itself when it clears its own flag; not an operator choice. */
export type ReconciliationOutcome = "refunded" | "fulfilled" | "written_off" | "restocked";

/**
 * The audit record written when an admin resolves an order's reconciliation flag
 * (admin-UX Increment 1). Populated atomically with clearing `reconciliationFlag`;
 * `null` while the order was never flagged OR is still awaiting resolution. The
 * original anomaly detail stays queryable in `payment_events` (settle records it
 * there); this record captures only the human disposition.
 */
export interface ReconciliationResolution {
	outcome: ReconciliationOutcome;
	/** Free-text justification (trimmed, required non-empty by the use-case). */
	reason: string;
	/** Who resolved it (free text, resolved by the caller — the domain does not
	 *  model admin identity), mirroring an order note's `author`. */
	resolvedBy: string;
	/** Server-assigned ISO-8601 UTC timestamp (from the store's clock). */
	resolvedAt: string;
}

/**
 * The structured reasons an admin may give when cancelling an order (admin-UX
 * Increment 1, "cancel with reason" slice). A small closed set — commerce
 * disposition, never free text alone — so cancellations are reportable; `other`
 * is the escape hatch and is where the optional `detail` free text matters most.
 */
export type CancellationReason =
	| "customer_request"
	| "fraud_suspected"
	| "out_of_stock"
	| "pricing_error"
	| "other";

/**
 * The cancellation recorded on an order (admin-UX Increment 1). A SINGLE-SLOT
 * record: this domain's state machine cancels an order exactly once (`cancelled`
 * is terminal — no outbound transition, `state-machine.ts`), so an order carries
 * at most one cancellation. Part of the mutable envelope — recording it NEVER
 * touches line items or prices (the snapshot invariant). Populated atomically
 * with the `{pending,paid,processing} → cancelled` transition by `cancelOrder`;
 * `null` until the order is cancelled through that path. A `cancelled` order
 * reached via the bare `transitionOrder` (back-compat callers) has `state
 * === "cancelled"` but `cancellation === null` — an honest "cancelled, no reason
 * on file" state, mirroring `fulfillment`'s shipped-without-tracking case.
 */
export interface OrderCancellation {
	reason: CancellationReason;
	/** Optional free-text elaboration (trimmed; `null` when the admin gave none).
	 *  Bounded by the service schema — the domain accepts whatever it is handed. */
	detail: string | null;
	/** Who cancelled it (free text, like a note author — the domain does not
	 *  model admin identity). */
	cancelledBy: string;
	/** Server-assigned ISO-8601 UTC timestamp the cancellation was recorded (from
	 *  the store's clock) — the presence witness that a reason is on file. */
	cancelledAt: string;
	/**
	 * The money the cancellation returned to the buyer (QA T1-4): the refund
	 * `cancelOrderWithRefund` issued BEFORE the flip, so the cancelled email can say
	 * a refund is on its way and for how much. `null` when nothing was refunded — an
	 * unpaid order, or a paid one with nothing captured. ABSENT on a cancellation
	 * recorded before the field existed, which reads the same as `null`.
	 */
	refund?: CancellationRefund | null;
	/** Whether the cancellation returned the order's physical units to stock. ABSENT
	 *  (an older cancellation) reads as `false`. A pending order's held stock is
	 *  released by the cancel itself either way; this is about SOLD units. */
	restocked?: boolean;
	/**
	 * The restock this cancellation still OWES (issue #364). `cancelOrderWithRefund`
	 * restocks only after its flip lands, so the flip records what it is about to
	 * return — the cancellation's key and the lines — and the restock clears it when
	 * the units are back. Non-null ⇒ the units have NOT come back yet; a replay of the
	 * cancellation or the sweep finishes it under the recorded key, exactly once.
	 * ABSENT or `null` ⇒ nothing is owed.
	 */
	restockPending?: CancellationRestockPending | null;
}

/** A cancellation's outstanding restock: each line is returned under
 *  `<idempotencyKey>:restock:<lineId>`, the keys the inventory spends once. */
export interface CancellationRestockPending {
	idempotencyKey: string;
	lineIds: string[];
	/** Consecutive sweep attempts that failed to finish it. ABSENT ⇒ 0. At
	 *  `CANCELLATION_RESTOCK_FLAG_AFTER` the order is flagged for the operator. */
	failures?: number;
	/** ISO-8601 instant before which the sweep does not retry it — the back-off a
	 *  flagged restock earns (`cancellationRestockBackoffMs`). ABSENT ⇒ due now. */
	retryAt?: string;
}

/** The refund a cancellation issued — integer minor units in the order's currency. */
export interface CancellationRefund {
	amount: Cents;
	currency: Currency;
}

/**
 * The shipping fulfillment recorded on an order (admin-UX Increment 1). A
 * SINGLE-SLOT record: this domain's state machine ships an order exactly once
 * (`processing → shipped`, one `shipped` state — no partial/split fulfillment),
 * so an order carries at most one fulfillment. It is part of the order's mutable
 * envelope — recording it NEVER touches line items or prices (the snapshot
 * invariant). Populated atomically with the `processing → shipped` transition by
 * `recordFulfillment`; `null` until the order is shipped with tracking. Once set,
 * it is what the shipped-notification email renders (so "shipped" is no longer an
 * empty email).
 */
export interface OrderFulfillment {
	/** The shipping carrier (free text, e.g. "UPS"), trimmed non-empty. */
	carrier: string;
	/** The carrier tracking number (free text), trimmed non-empty. */
	trackingNumber: string;
	/** An optional carrier tracking URL; null when the admin recorded none. */
	trackingUrl: string | null;
	/** When the order shipped (ISO-8601 UTC). Admin-supplied, or the server clock
	 *  at record time when the admin left it blank. */
	shippedAt: string;
	/** Who recorded the fulfillment (free text, like a note author — the domain
	 *  does not model admin identity). */
	recordedBy: string;
	/** Server-assigned ISO-8601 UTC timestamp the fulfillment was recorded (from
	 *  the store's clock) — the presence witness that the order was fulfilled. */
	recordedAt: string;
}

/**
 * The shipping address snapshotted onto an order at checkout (ADR-0009). A single
 * **immutable** slot written **once by `createFromCart`** (unlike
 * `fulfillment`/`cancellation`, which the admin writes later) and **never**
 * rewritten — the line-item snapshot precedent exactly. It is a frozen COPY, never
 * a live pointer into the mutable profile `AddressStore`: editing or deleting the
 * customer's saved address book can never change what a placed order shipped to.
 *
 * Fields mirror the profile `Address` **minus the profile concerns**
 * (`id`/`customerId`/`isDefault`/`kind`) **plus** an optional contact channel
 * (`email`/`phone`). Required fields (`name`/`line1`/`city`/`postalCode`/`country`)
 * are non-empty; the rest are `null` when not supplied. `null` on the order means
 * *no ship-to on file* — a historical order minted before ADR-0009, or a
 * digital-only order with no destination (honest absence, never fabricated).
 */
export interface OrderAddress {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	country: string;
	/** Optional contact channel captured at checkout (null when not supplied). */
	email: string | null;
	phone: string | null;
}

/**
 * An order line — **insert-once, never updated** (§4). `title`, `unitPrice`, and
 * `currency` are snapshots taken at creation; they are stored on the line, never
 * joined live from `product_commerce`, which is what makes the immutability
 * structural. A **physical** line carries its adopted reservation; a **digital**
 * line carries `reservationId = null` (digital never reserves, §6).
 */
export interface OrderLine {
	id: string;
	orderId: OrderId;
	productId: ProductId;
	sku: Sku;
	/** Snapshot of the product title at purchase time. */
	title: string;
	/** Snapshot of the unit price (branded minor units). */
	unitPrice: Cents;
	/** Snapshot of the currency. */
	currency: Currency;
	quantity: number;
	fulfillmentKind: FulfillmentKind;
	/** The adopted Phase-3 reservation (physical); null for digital. */
	reservationId: ReservationId | null;
}

/**
 * The 1:1 order totals row (§4). This is the authoritative order-total home for
 * the whole repo; `orders` carries no money. Phase 4 writes the **stub**
 * (`subtotal = total = Σ(unitPrice × quantity)`; discount/shipping/tax `0`; the
 * three nullable columns `null`). Phase 6 replaces the computation feeding this
 * one write — same columns, still written once at creation.
 */
export interface OrderTotals {
	orderId: OrderId;
	currency: Currency;
	subtotal: Cents;
	discount: Cents;
	shipping: Cents;
	tax: Cents;
	total: Cents;
	appliedCouponCode: string | null;
	shippingMethodSnapshot: unknown | null;
	/** Untyped on read: v1 (ADR-0030), the legacy shape, or null — read it
	 *  through `readOrderTaxSnapshot`. */
	taxBreakdown: unknown | null;
}

export interface Order {
	id: OrderId;
	cartId: string | null;
	currency: Currency;
	state: OrderState;
	idempotencyKey: IdempotencyKey;
	/** Checkout hold TTL deadline (ISO-8601 UTC); drives the order-level expiry. */
	holdExpiresAt: string;
	paymentMethod: PaymentMethod | null;
	/** Email/session claim token — the pre-Phase-5 entitlement key (§6). */
	buyerRef: string;
	/** Phase-5 hook; nullable, populated by Phase 5 (§4). */
	customerId: string | null;
	createdAt: string;
	updatedAt: string;
	lines: OrderLine[];
	totals: OrderTotals;
	/**
	 * The immutable shipping-address snapshot captured at checkout (ADR-0009), or
	 * `null` when none was captured — a historical order predating capture, or a
	 * digital-only order with no destination. Written **once** by
	 * `createFromCart` and part of the frozen order snapshot: a later edit to the
	 * customer's profile address book never rewrites it (the snapshot invariant).
	 */
	shippingAddress: OrderAddress | null;
	/**
	 * Whether the order was placed under the payment account's buyer-address
	 * requirement (issue #382 — an India-based Stripe account): the
	 * `addressRequired` its checkout enforced, frozen in the creating insert. It
	 * also DECIDES whether the order's payment carries a provider-side customer
	 * (`intentInputFor`), so the place check and every intent of the order —
	 * first, replay, resume — answer from this one snapshot and can never
	 * disagree. ABSENT on orders created before it existed; those keep the
	 * gateway's own decision, as before.
	 */
	buyerAddressRequired?: boolean;
	/**
	 * Set when settle could not commit an adopted hold that should have been
	 * present (§5): the order is `paid` (money received) but stock was lost, so
	 * it is flagged for manual reconciliation — never a silent no-op. Null on the
	 * happy path. **Cleared** (back to null) when an admin resolves the flag
	 * (admin-UX Increment 1), which also writes `reconciliationResolution`.
	 */
	reconciliationFlag: string | null;
	/**
	 * The admin disposition recorded when the reconciliation flag was resolved
	 * (admin-UX Increment 1); null while the order was never flagged OR is still
	 * awaiting resolution. Distinguishes an ALREADY-RESOLVED order (flag null +
	 * this set) from a NEVER-FLAGGED one (both null) — so a resolve replay is a
	 * benign no-op rather than an error.
	 */
	reconciliationResolution: ReconciliationResolution | null;
	/**
	 * The shipping fulfillment recorded on this order (admin-UX Increment 1);
	 * `null` until the order is shipped with tracking via `recordFulfillment`.
	 * Single-slot (this domain ships once). Part of the mutable envelope — it never
	 * affects line items or totals (the snapshot invariant).
	 */
	fulfillment: OrderFulfillment | null;
	/**
	 * The structured cancellation recorded on this order (admin-UX Increment 1);
	 * `null` while never cancelled, OR cancelled via the bare `transitionOrder`
	 * without a reason (back-compat). Single-slot (cancellation is terminal). Part
	 * of the mutable envelope — it never affects line items or totals (the
	 * snapshot invariant).
	 */
	cancellation: OrderCancellation | null;
}
