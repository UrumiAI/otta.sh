/**
 * The domain's `orderTimelineContract` against `EmdashOrderStore`, on both Node
 * dialects, in full — no staging and no todos.
 *
 * The timeline merges four kinds of history off documents rather than tables: the
 * state-change spine from the order document's own append-only `events[]`, the notes
 * from `InMemoryOrderNotesStore` (the notes adapter is INC-B8's), and the fulfillment,
 * cancellation and reconciliation artifacts from the fields the guarded flips wrote.
 * `countingIds` makes the same-instant `(at, id)` tie-break append order.
 *
 * Plus the Postgres-only exactly-one-audit-event race the deleted
 * `@otta-sh/store-postgres` suite of the same name carried, re-pointed at
 * `EmdashOrderStore`. It is the audit half of the transition invariant, and it is
 * Postgres-required for the same reason every other race here is: better-sqlite3
 * serializes writes in one process, so it can verify the write's SHAPE and never
 * the contention.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	type CreateOrderInput,
} from "@otta-sh/domain";
import { orderTimelineContract } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, orderTimelineHarness } from "./order-harness.js";

const USD = currency("USD");

/** One pending, physically-reserved order — the SQL suite's own seed, unchanged. */
function pendingInput(id: string, key: string): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey(key),
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

describeEachDialect("EmdashOrderStore timeline", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	orderTimelineContract(
		async () => orderTimelineHarness(makeOrderHarness(bound.storage, { countingIds: true })),
		{ dialect: ctx.dialect },
	);

	// Concurrency (Postgres-required, like the no-oversell race): N concurrent
	// markPaid on the SAME pending order flip it EXACTLY ONCE — the guarded
	// `state === fromState` check plus the pinned compare-and-set lets one caller
	// win. The state-change audit is appended INSIDE that one guarded write (`#flipped`
	// composes the new state and the event together), so EXACTLY ONE `state_change`
	// event is written — a replay or a lost race is a 0-row flip and records none.
	// This is the audit analogue of the outbox's first-wins `(orderId, toState)`.
	test.runIf(ctx.canRace)(
		"concurrent state flips write exactly one audit event (no double audit under a race)",
		async () => {
			const h = makeOrderHarness(bound.storage, { countingIds: true });
			const id = orderId("ord-audit-race");
			await h.store.createFromCart(pendingInput("ord-audit-race", "key-audit-race"));

			const N = 12;
			const results = await Promise.all(Array.from({ length: N }, () => h.store.markPaid(id)));
			// Exactly one caller won the guarded flip; the rest are benign 0-row misses.
			expect(results.filter((won) => won)).toHaveLength(1);

			const events = await h.store.listEventsForOrder(id);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ fromState: "pending", toState: "paid" });
			expect((await h.store.getById(id))?.state).toBe("paid");
		},
		120_000,
	);
});
