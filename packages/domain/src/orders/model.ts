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

/** The two payment gateways (§5). */
export type PaymentMethod = "stripe" | "x402";

/**
 * The admin's disposition when clearing a reconciliation flag (admin-UX
 * Increment 1). A resolution is a RECORD of the decision, never itself a money
 * movement: `refunded` means the refund was carried out through the ordinary
 * `refunded` state transition (or out of band), `fulfilled` means the order was
 * honored as-is (stock re-sourced), `written_off` means the loss/false-alarm was
 * accepted. The order's state machine + line snapshots are untouched either way.
 */
export type ReconciliationOutcome = "refunded" | "fulfilled" | "written_off";

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
}
