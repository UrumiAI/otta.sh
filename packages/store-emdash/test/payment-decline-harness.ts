/**
 * The `paymentDeclineContract` harness (ADR-0021) over the document store, factored
 * out so all three dialects run it — the two Node ones through
 * `payment-decline-contract.dialects.test.ts` and D1 through its own spec, which
 * cannot import a `.dialects.test.ts` (that file pulls in `better-sqlite3` and `pg`
 * at module scope, neither of which exists inside `workerd`).
 *
 * Every store the decline touches is REAL here: the order, inventory, coupon and
 * payment-event documents are the ones a deployed site writes, because the spec is
 * about what one path (the decline settle) leaves for another (the expiry sweep or
 * the success settle) in those documents. Only the entitlement store — which a
 * physical order never reaches — is the order harness's in-memory one.
 */
import { idempotencyKey } from "@otta-sh/domain";
import type { PaymentDeclineHarness } from "@otta-sh/domain/testing";
import { EmdashPaymentEventStore, type StorageAccess } from "../src/index.js";
import { makeCouponHarness } from "./coupon-harness.js";
import { makeOrderHarness } from "./order-harness.js";

/** Build the decline harness over an already-bound `StorageAccess`. */
export function makePaymentDeclineHarness(storage: StorageAccess): PaymentDeclineHarness {
	const orders = makeOrderHarness(storage);
	const couponStore = makeCouponHarness(storage, { clock: orders.clock }).store;
	const paymentEventStore = new EmdashPaymentEventStore({ storage });
	return {
		settleDeps: { ...orders.settleDeps, paymentEventStore },
		expireDeps: { ...orders.expireDeps, couponStore },
		async holdForCheckout(sku, qty, key, expiresAt) {
			// The store's OWN `held`-scoped stamp — the write the cart adapter's attach
			// guard uses — so the seeded hold is one the production path can produce.
			const reserved = await orders.inventory.reserve(sku, qty, idempotencyKey(key));
			if (!reserved.ok) throw new Error(`reserve failed for ${sku}: ${reserved.reason}`);
			const stamped = await orders.inventory.stampHoldDeadline(reserved.reservationId, expiresAt);
			if (!stamped) throw new Error(`could not stamp the hold under key ${key}`);
			return reserved.reservationId;
		},
	};
}
