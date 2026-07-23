import {
	customerId as toCustomerId,
	email as toEmail,
	type Email,
	type OrderId,
} from "../money/ids.js";
import type { Address, Customer } from "../customers/model.js";
import type { AddressStore } from "../ports/address-store.js";
import type { CustomerStore } from "../ports/customer-store.js";
import type { OrderCustomerKey, OrderStore, OrderSummary } from "../ports/order-store.js";
import type { SessionStore, SessionSummary } from "../ports/session-store.js";

export interface OrderCustomerContextDeps {
	orderStore: OrderStore;
	customerStore: CustomerStore;
	addressStore: AddressStore;
	sessionStore: SessionStore;
	/** Cap on `recentOrders` (default {@link DEFAULT_RECENT_ORDERS_LIMIT}). */
	recentOrdersLimit?: number;
}

export const DEFAULT_RECENT_ORDERS_LIMIT = 5;

/**
 * How the order was tied to a customer account:
 * - `"claimed"` — `orders.customer_id` is set (a past login already linked it).
 * - `"unclaimed"` — the order itself is not linked (`customer_id` NULL, or the
 *   linked row is dangling), but an account EXISTS for its `buyer_ref` email;
 *   `linkGuestOrders` will claim it at that customer's next login.
 * - `"guest"` — no account exists for this order's identity at all.
 */
export type CustomerLinkage = "claimed" | "unclaimed" | "guest";

export interface OrderCustomerIdentity {
	/** The resolved account id, or null when no account exists (`linkage:"guest"`). */
	customerId: string | null;
	/** The order's own claim token (usually the checkout email), always present. */
	buyerRef: string;
	email: string | null;
	displayName: string | null;
	emailVerifiedAt: string | null;
	linkage: CustomerLinkage;
}

export interface OrderCustomerContext {
	identity: OrderCustomerIdentity;
	/** The customer's CURRENT saved profile address book — prefill/context only
	 *  (ADR-0009). The order's own immutable ship-to now lives on
	 *  `Order.shippingAddress`; this book is the mutable profile data a checkout
	 *  MAY prefill from, never the authoritative destination for this order. Empty
	 *  for a guest. */
	addresses: Address[];
	/** Token-free session history, newest-first. Empty for a guest. */
	sessions: SessionSummary[];
	/** Total orders for this person under the union customer key. */
	orderCount: number;
	/** The person's other most-recent orders (excludes the viewed order),
	 *  newest-first, capped at `recentOrdersLimit`. */
	recentOrders: OrderSummary[];
}

/**
 * Assemble the admin "who is this customer?" panel for one order (admin-UX
 * Increment 1). Pure orchestration — no IO of its own; read-only (no
 * idempotency concern).
 *
 * Identity resolution deliberately does NOT stop at `orders.customer_id`:
 * orders are born `customer_id = NULL` and only back-linked at the customer's
 * NEXT magic-link login, so an unlinked order of a well-known account is the
 * COMMON path, not an edge. The fallback resolves the account by
 * `getByEmail(buyerRef)` (guarded — a buyer_ref is a claim token and not
 * guaranteed email-shaped), and every aggregate uses the UNION customer key
 * (`customer_id OR buyer_ref`), so the count and recent orders are identical no
 * matter which of the person's orders the admin opened.
 *
 * Returns null iff the order does not exist.
 */
export async function getOrderCustomerContext(
	deps: OrderCustomerContextDeps,
	orderId: OrderId,
): Promise<OrderCustomerContext | null> {
	const order = await deps.orderStore.getById(orderId);
	if (order === null) return null;
	const limit = deps.recentOrdersLimit ?? DEFAULT_RECENT_ORDERS_LIMIT;

	// -- resolve the account (claimed → by-email fallback → guest) -------------
	let customer: Customer | null = null;
	let linkage: CustomerLinkage = "guest";
	if (order.customerId !== null) {
		customer = await deps.customerStore.get(toCustomerId(order.customerId));
		if (customer !== null) linkage = "claimed";
	}
	if (customer === null) {
		const refEmail = asEmailOrNull(order.buyerRef);
		if (refEmail !== null) {
			customer = await deps.customerStore.getByEmail(refEmail);
			if (customer !== null) linkage = "unclaimed";
		}
	}

	// -- the union customer key: identical from ANY of the person's orders -----
	// With an account: id + canonical account email (what linkGuestOrders links
	// on). Without one: whatever keys the order itself carries — including a
	// dangling customer_id, so a defensive degrade still counts consistently.
	//
	// TRUST BOUNDARY: treating buyer_ref as ownership proof is the trust
	// assumption `linkGuestOrders` established (a magic-link login proves the
	// inbox, then claims every order whose buyer_ref matches that email) — this
	// use-case propagates it into a PII-surfacing ADMIN read, and it holds on
	// the unresolved/guest path too, where NO login ever proved anything.
	// Consequence: buyer_ref is caller-supplied at checkout, so anyone who
	// places an order with an arbitrary email as its buyer_ref makes that order
	// surface under that customer's context here (inflating orderCount /
	// recentOrders). Admin-side read only — nothing customer-facing exposes
	// this — and the same spoofed ref would be claimed by linkGuestOrders at
	// the victim's next login anyway; but do NOT reuse this union key on any
	// customer-facing surface without a real ownership check.
	const key: OrderCustomerKey =
		customer !== null
			? { customerId: customer.id, buyerRef: customer.email }
			: {
					...(order.customerId !== null ? { customerId: order.customerId } : {}),
					buyerRef: order.buyerRef,
				};

	const [addresses, sessions, orderCount, recent] = await Promise.all([
		customer !== null ? deps.addressStore.list(customer.id) : emptyAddresses(),
		customer !== null ? deps.sessionStore.listForCustomer(customer.id) : emptySessions(),
		deps.orderStore.countOrders({ customer: key }),
		// Fetch limit+1 so the page stays full when the viewed order is among the
		// newest; then remove self IF present and slice to the cap (the viewed
		// order may be older than all of them — the slice keeps the cap exact).
		deps.orderStore.listOrders({ customer: key }, { limit: limit + 1 }),
	]);
	const recentOrders = recent.orders.filter((o) => o.id !== order.id).slice(0, limit);

	const identity: OrderCustomerIdentity =
		customer !== null
			? {
					customerId: customer.id,
					buyerRef: order.buyerRef,
					email: customer.email,
					displayName: customer.displayName,
					emailVerifiedAt: customer.emailVerifiedAt,
					linkage,
				}
			: {
					// A dangling customer_id (row vanished) is surfaced honestly rather
					// than thrown on — the panel degrades, the order stays viewable.
					customerId: order.customerId,
					buyerRef: order.buyerRef,
					email: null,
					displayName: null,
					emailVerifiedAt: null,
					linkage: "guest",
				};

	return { identity, addresses, sessions, orderCount, recentOrders };
}

/** Guarded email brand: buyer_ref is "email OR session claim token" — a
 *  non-email ref (e.g. `session:abc`) must resolve to null, never throw. */
function asEmailOrNull(value: string): Email | null {
	if (!value.includes("@")) return null;
	try {
		return toEmail(value);
	} catch {
		return null;
	}
}

async function emptyAddresses(): Promise<Address[]> {
	return [];
}

async function emptySessions(): Promise<SessionSummary[]> {
	return [];
}
