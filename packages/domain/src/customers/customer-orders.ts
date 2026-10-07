import type { CustomerId } from "../money/ids.js";
import type { Order } from "../orders/model.js";
import type { CustomerStore } from "../ports/customer-store.js";
import type { OrderStore } from "../ports/order-store.js";
import type { SessionStore } from "../ports/session-store.js";

/**
 * What a SESSION may claim for its customer.
 *
 * A session is minted only by redeeming a magic link sent to the customer's email
 * (`verifyLogin`), so holding one proves that inbox exactly as the sign-in did. The
 * sign-in already turns that proof into ownership — it claims every guest order whose
 * buyer reference is the email (`linkGuestOrders`). These two use-cases make the same
 * claim with the same rule at the moment the shopper is ALREADY signed in, instead of
 * waiting for a sign-in they have no reason to repeat: before this, an order placed
 * while signed in stayed a guest order, missing from "Your orders" until the shopper
 * signed in again.
 *
 * The comparison is the guest-linking fold — lowercase on both sides, nothing else —
 * so an order owned at birth is exactly an order the next sign-in would have claimed.
 */
function sameInbox(buyerRef: string, customerEmail: string): boolean {
	return buyerRef.toLowerCase() === customerEmail.toLowerCase();
}

export interface CheckoutOwnerDeps {
	sessionStore: SessionStore;
	customerStore: CustomerStore;
	/** Told when a session or customer read fails. The checkout goes on as a guest
	 *  order; the domain does no logging of its own. */
	onError?: (err: unknown) => void;
}

/**
 * The account a signed-in checkout's order belongs to: the customer the SESSION
 * resolves to, when the order is placed under that customer's own email; otherwise
 * NOBODY.
 *
 * "Otherwise nobody" is the point. A shopper signed in as one address may order under
 * another (a gift, a work address); the session proves their inbox, not that one, so
 * filing the order under their account would attach someone else's address to it. It
 * stays a guest order, claimable by whoever proves the other inbox. An unknown,
 * expired or revoked session, or a customer that no longer exists, owns nothing.
 *
 * NEVER THROWS. The answer only decides who owns the order, so a store that cannot
 * give it right now must not cost the buyer the order itself: the failure goes to
 * `onError` and the order is a guest order, which the next sign-in — or the next
 * signed-in listing — claims.
 */
export async function checkoutOwner(
	deps: CheckoutOwnerDeps,
	input: { sessionToken: string; buyerRef: string },
): Promise<CustomerId | undefined> {
	try {
		const customerId = await deps.sessionStore.validate(input.sessionToken);
		if (customerId === null) return undefined;
		const customer = await deps.customerStore.get(customerId);
		if (customer === null) return undefined;
		return sameInbox(input.buyerRef, customer.email) ? customer.id : undefined;
	} catch (err) {
		deps.onError?.(err);
		return undefined;
	}
}

export interface CustomerOrdersDeps {
	customerStore: CustomerStore;
	orderStore: OrderStore;
	/**
	 * Told when the claim fails (storage contention past its retry budget, say).
	 * The list is served anyway — the claim is a convenience riding on a read, and
	 * the next listing tries again. The domain does no logging of its own; the
	 * caller decides what to do with it.
	 */
	onClaimError?: (err: unknown) => void;
}

/**
 * A signed-in customer's own orders, newest first — after claiming the guest orders
 * placed under their email, as the sign-in would have (ADR-0004, amended 2026-10-02).
 *
 * The claim catches what `checkoutOwner` cannot: an order placed as a guest (signed
 * out, or before this account existed) by the same inbox, while a session was already
 * open in this or another browser. Ownership is proven by the session (see module doc),
 * and the claim reaches only orders the customer's NEXT sign-in would claim anyway.
 *
 * `null` when the customer does not exist — the caller answers that exactly as it
 * answers an unusable session, never as "signed in, no orders".
 *
 * A failed claim does not fail the list: it is reported through `onClaimError` and the
 * orders already owned are listed.
 *
 * COST, per call: one customer read, then `linkGuestOrders` — one INDEXED query on the
 * folded email (the order store's `customerKey`, which holds the folded buyer reference
 * only while an order is unclaimed), plus one compare-and-set per order it actually
 * claims. Once an inbox's orders are claimed the query finds nothing, so the steady
 * state is one read and one empty indexed query on top of the list. It is not a scan.
 * Idempotent: a second call claims nothing new.
 */
export async function listCustomerOrders(
	deps: CustomerOrdersDeps,
	customerId: CustomerId,
): Promise<Order[] | null> {
	const customer = await deps.customerStore.get(customerId);
	if (customer === null) return null;
	try {
		await deps.orderStore.linkGuestOrders(customer.id, customer.email);
	} catch (err) {
		deps.onClaimError?.(err);
	}
	return deps.orderStore.listForCustomer(customer.id);
}
