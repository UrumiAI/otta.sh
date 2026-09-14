/**
 * The outbox dispatcher's retry + lease semantics against `EmdashOrderStore` — the
 * SQL adapters' `outbox-dispatch.dialects.test.ts`, re-pointed at the document store
 * (the original is untouched).
 *
 * Two properties, and they are the two the SQL got from a predicate the filter algebra
 * cannot express (`sent_at IS NULL AND status != 'failed' AND (lease_until IS NULL OR
 * lease_until <= :now)` — an OR and a negation). ADR-0019 R2 replaces it with ONE
 * denormalized indexed field, {@link OrderDoc.emailDueAt}: `null` when the message is
 * sent or failed, otherwise `max(dueAt, leaseUntil)`. The claim is then a single
 * compare-and-set that re-applies the same due predicate to the entry it picked, so:
 *
 * - a crashed dispatcher's entry becomes claimable again once its lease lapses, with
 *   `attempts` incremented on each claim; and
 * - a failed send returns the entry to `pending` with its due time moved FORWARD, so
 *   the same drain loop does not re-pick it and the next cron tick delivers it exactly
 *   once.
 *
 * The settle half (`markEmailSent` / `rescheduleEmail`) runs through the
 * `outbox_keys/{entryId}` locator INC-B4 added, so these cases also exercise the
 * locator on the happy path — `order-lists.dialects.test.ts` pins it directly, and
 * `order-crash-seams.dialects.test.ts` pins its heal.
 */
import {
	cents,
	currency,
	dispatchOrderEmails,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	type CreateOrderInput,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

const USD = currency("USD");

function pendingInput(): CreateOrderInput {
	return {
		orderId: orderId("ord-1"),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey("key-1"),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(500), total: cents(500), currency: USD },
	};
}

describeEachDialect("outbox dispatcher", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);

	test("a crashed dispatcher run leaves the row claimable again after its lease expires", async () => {
		const h = makeOrderHarness(bound.storage, { countingIds: true });
		await h.store.createFromCart(pendingInput());
		await h.store.markPaid(orderId("ord-1")); // enqueues one confirmation entry

		const now = "2026-07-10T00:00:00.000Z";
		const lease = "2026-07-10T00:05:00.000Z";
		const first = await h.store.claimNextEmail(now, lease);
		expect(first).not.toBeNull();

		// Simulate a crash: the entry is 'sending' but never marked sent. A second
		// claim within the lease window finds nothing — `emailDueAt` now holds the
		// lease, which is not yet `<= now`.
		expect(await h.store.claimNextEmail(now, lease)).toBeNull();

		// After the lease expires, the same entry is claimable again (reclaimed).
		const afterLease = "2026-07-10T00:06:00.000Z";
		const reclaimed = await h.store.claimNextEmail(afterLease, "2026-07-10T00:11:00.000Z");
		expect(reclaimed?.id).toBe(first?.id);
		expect(reclaimed?.attempts).toBe(2); // incremented on each claim
	});

	test("a failed send returns the row to pending; the next dispatch delivers it exactly once", async () => {
		const h = makeOrderHarness(bound.storage, { countingIds: true });
		await h.store.createFromCart(pendingInput());
		await h.store.markPaid(orderId("ord-1"));

		const deps = { orderStore: h.store, emailSender: h.emailSender, clock: h.clock };
		h.emailSender.failNextSends(1); // first send throws
		expect(await dispatchOrderEmails(deps)).toBe(0); // failed → backed off, nothing delivered
		// The backoff moved `dueAt` forward, so the entry is not claimable this tick.
		expect(await dispatchOrderEmails(deps)).toBe(0);
		// Next cron tick (past the backoff) delivers it exactly once.
		h.clock.advance(10 * 60 * 1000);
		expect(await dispatchOrderEmails(deps)).toBe(1);
		expect(await dispatchOrderEmails(deps)).toBe(0); // no double-send
		expect(h.emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
	});
});
