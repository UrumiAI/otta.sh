/**
 * Order model (Phase 4 §4). An order is an **immutable** record minted from a
 * cart: its line items snapshot price + title at purchase time, so a later
 * product edit never rewrites them (the headline snapshot invariant). Money is
 * branded `Cents` throughout — a plain `number` reaching a money field is a
 * compile error (DEVELOPMENT.md §4).
 */

import type { Cents, Currency } from "../money/cents.js";
import type { IdempotencyKey, OrderId, ProductId, ReservationId, Sku } from "../money/ids.js";

/** Order state machine (§4). `paid`/`failed`/`expired` are terminal for Phase 4;
 *  `fulfilled/refunded/cancelled` are Phase-5 extensions. */
export type OrderState = "pending" | "paid" | "failed" | "expired";

/** A line's fulfillment path — copied from `product_commerce.product_kind` onto
 *  the order line so settle's commit-vs-grant branch has a stable input (§4). */
export type FulfillmentKind = "physical" | "digital";

/** The two payment gateways (§5). */
export type PaymentMethod = "stripe" | "x402";

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
	 * happy path.
	 */
	reconciliationFlag: string | null;
}
