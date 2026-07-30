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
import { describe, expect, test } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgOrderTimelineHarness,
	makeSqliteOrderTimelineHarness,
	teardownOrderFlow,
} from "./order-harness.js";
import { afterEach } from "vitest";

// The order timeline / audit spec on the real adapters (admin-UX Increment 1,
// timeline slice). SQLite verifies the DDL + the state-change audit written
// inside each guarded flip + the merge read; Postgres additionally runs the
// exactly-one-event-under-concurrency races below (SQLite serializes writes, so
// it can't race).

afterEach(teardownOrderFlow);

orderTimelineContract(makeSqliteOrderTimelineHarness, { dialect: "sqlite" });

const USD = currency("USD");

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

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	orderTimelineContract(makePgOrderTimelineHarness, { dialect: "pg" });

	// Concurrency (Postgres-required, like the no-oversell race): N concurrent
	// markPaid on the SAME pending order flip it EXACTLY ONCE — the guarded `WHERE
	// state='pending'` UPDATE lets one caller win. The state-change audit rides
	// that guarded flip transaction, so EXACTLY ONE `state_change` event is
	// written — a replay/lost race is a 0-row flip and records none. This is the
	// audit analogue of the outbox `UNIQUE(order_id, to_state)` exactly-once.
	test("concurrent state flips write exactly one audit event (no double audit under a race)", async () => {
		const h = await makePgOrderTimelineHarness();
		const id = orderId("ord-audit-race");
		await h.orderStore.createFromCart(pendingInput("ord-audit-race", "key-audit-race"));

		const N = 12;
		const results = await Promise.all(Array.from({ length: N }, () => h.orderStore.markPaid(id)));
		// Exactly one caller won the guarded flip; the rest are benign 0-row misses.
		expect(results.filter((won) => won)).toHaveLength(1);

		const events = await h.orderStore.listEventsForOrder(id);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ fromState: "pending", toState: "paid" });
	}, 60_000);
});
