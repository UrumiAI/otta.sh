import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import {
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	type OrderId,
} from "../money/ids.js";
import type { AppendOrderNoteInput, OrderNotesStore } from "../ports/order-notes-store.js";
import type { CreateOrderInput, OrderStore } from "../ports/order-store.js";
import type { OrderState } from "../orders/model.js";
import { cancelOrder } from "../orders/cancel-order.js";
import { getOrderTimeline } from "../orders/order-timeline.js";
import { recordFulfillment } from "../orders/record-fulfillment.js";
import { resolveReconciliation } from "../orders/resolve-reconciliation.js";
import { transitionOrder } from "../orders/transition.js";

const USD = currency("USD");

/** The two stores over ONE backing store, plus a `tick` to advance the shared
 *  clock so successive flips get DISTINCT `at` timestamps (proving chronological
 *  ordering, not just the id tie-break). The fake and each Kysely dialect drive a
 *  FixedClock. */
export interface OrderTimelineHarness {
	orderStore: OrderStore;
	orderNotesStore: OrderNotesStore;
	tick(ms: number): void;
}

export interface OrderTimelineContractOptions {
	dialect: string;
}

function pendingInput(
	id: string,
	key: string,
	overrides: Partial<CreateOrderInput> = {},
): CreateOrderInput {
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
				quantity: 3,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		...overrides,
	};
}

function drive(h: OrderTimelineHarness, id: OrderId, to: OrderState) {
	return transitionOrder(
		{ orderStore: h.orderStore },
		{ orderId: id, toState: to, idempotencyKey: idempotencyKey(`t:${id}:${to}`) },
	);
}

function addNote(
	h: OrderTimelineHarness,
	input: Omit<AppendOrderNoteInput, "idempotencyKey"> & { key: string },
) {
	return h.orderNotesStore.append({
		orderId: input.orderId,
		author: input.author,
		body: input.body,
		idempotencyKey: idempotencyKey(input.key),
	});
}

/**
 * The reusable order timeline / audit spec (admin-UX Increment 1, timeline
 * slice). Encodes: every guarded state flip records EXACTLY ONE `state_change`
 * event (with the from/to states, and the actor when the domain knows one); a
 * replayed or 0-row flip records NONE (audit never double-counts a replay); the
 * timeline MERGES that state-change spine with the order's derived artifacts
 * (created / notes / fulfillment / cancellation / reconciliation resolution) into
 * one chronological view; and a historical order (no events) still yields a
 * useful partial timeline. Runs against the fake first, then each SQL dialect.
 * The Postgres-required exactly-one-event-under-race cases live in the
 * store-postgres dialects test (a fake/SQLite can't race).
 */
export function orderTimelineContract(
	makeHarness: () => Promise<OrderTimelineHarness>,
	opts: OrderTimelineContractOptions,
): void {
	describe(`orderTimelineContract [${opts.dialect}]`, () => {
		test("each guarded state flip records exactly one state_change event (from/to/actor)", async () => {
			const h = await makeHarness();
			const id = orderId("ord-audit-1");
			await h.orderStore.createFromCart(pendingInput("ord-audit-1", "key-a1"));
			h.tick(1000);
			await drive(h, id, "paid");
			h.tick(1000);
			await drive(h, id, "processing");
			h.tick(1000);
			await recordFulfillment(
				{ orderStore: h.orderStore },
				{
					orderId: id,
					carrier: "UPS",
					trackingNumber: "1Z-1",
					recordedBy: "dispatch-desk",
					idempotencyKey: idempotencyKey(`f:${id}`),
				},
			);

			const events = await h.orderStore.listEventsForOrder(id);
			expect(events.map((e) => [e.fromState, e.toState])).toEqual([
				["pending", "paid"],
				["paid", "processing"],
				["processing", "shipped"],
			]);
			// Bare transitions carry no modeled actor; the fulfillment flip stamps the
			// recorder as its actor.
			expect(events.map((e) => e.actor)).toEqual([null, null, "dispatch-desk"]);
			expect(events.every((e) => e.kind === "state_change")).toBe(true);
			// createFromCart is NOT a flip — creation is derived, never an event.
			expect(events).toHaveLength(3);
		});

		test("a replayed transition records no duplicate event (a 0-row flip audits nothing)", async () => {
			const h = await makeHarness();
			const id = orderId("ord-audit-2");
			await h.orderStore.createFromCart(pendingInput("ord-audit-2", "key-a2"));
			// markPaid twice: the first wins (pending→paid), the second is a 0-row miss.
			expect(await h.orderStore.markPaid(id)).toBe(true);
			expect(await h.orderStore.markPaid(id)).toBe(false);
			const events = await h.orderStore.listEventsForOrder(id);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ fromState: "pending", toState: "paid" });
		});

		test("cancel records a cancelled state_change event with the canceller as actor", async () => {
			const h = await makeHarness();
			const id = orderId("ord-audit-3");
			await h.orderStore.createFromCart(pendingInput("ord-audit-3", "key-a3"));
			await cancelOrder(
				{ orderStore: h.orderStore },
				{
					orderId: id,
					reason: "customer_request",
					detail: null,
					cancelledBy: "ops@shop",
					idempotencyKey: idempotencyKey(`c:${id}`),
				},
			);
			const events = await h.orderStore.listEventsForOrder(id);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				fromState: "pending",
				toState: "cancelled",
				actor: "ops@shop",
			});
		});

		test("expire records an expired state_change event", async () => {
			const h = await makeHarness();
			const id = orderId("ord-audit-4");
			await h.orderStore.createFromCart(pendingInput("ord-audit-4", "key-a4"));
			// The hold deadline is in the past relative to this `now`.
			expect(await h.orderStore.expire(id, "2026-07-10T01:00:00.000Z")).toBe(true);
			const events = await h.orderStore.listEventsForOrder(id);
			expect(events.map((e) => e.toState)).toEqual(["expired"]);
		});

		test("events are scoped to one order — another order's events never leak in", async () => {
			const h = await makeHarness();
			await h.orderStore.createFromCart(pendingInput("ord-A", "key-A"));
			await h.orderStore.createFromCart(pendingInput("ord-B", "key-B"));
			await h.orderStore.markPaid(orderId("ord-A"));
			const a = await h.orderStore.listEventsForOrder(orderId("ord-A"));
			const b = await h.orderStore.listEventsForOrder(orderId("ord-B"));
			expect(a.map((e) => e.toState)).toEqual(["paid"]);
			expect(b).toEqual([]);
		});

		test("the timeline merges the created moment, state changes, and notes in chronological order", async () => {
			const h = await makeHarness();
			const id = orderId("ord-tl-1");
			await h.orderStore.createFromCart(pendingInput("ord-tl-1", "key-tl1")); // created @ T0
			h.tick(1000);
			await addNote(h, { orderId: id, author: "alice", body: "gift-wrap please", key: "n1" }); // @ T1
			h.tick(1000);
			await drive(h, id, "paid"); // @ T2
			h.tick(1000);
			await addNote(h, { orderId: id, author: "bob", body: "called back", key: "n2" }); // @ T3

			const timeline = await getOrderTimeline(
				{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
				id,
			);
			expect(timeline).not.toBeNull();
			expect(timeline?.entries.map((e) => e.kind)).toEqual([
				"created",
				"note",
				"state_change",
				"note",
			]);
			expect(timeline?.stateChangesAudited).toBe(true);
			// The bodies/states land on the right entries.
			const kinds = timeline?.entries ?? [];
			expect(kinds[1]).toMatchObject({ kind: "note", author: "alice" });
			expect(kinds[2]).toMatchObject({ kind: "state_change", toState: "paid" });
			expect(kinds[3]).toMatchObject({ kind: "note", author: "bob" });
		});

		test("the timeline places the fulfillment, cancellation, and reconciliation artifacts at their timestamps", async () => {
			const h = await makeHarness();
			const id = orderId("ord-tl-2");
			await h.orderStore.createFromCart(pendingInput("ord-tl-2", "key-tl2"));
			h.tick(1000);
			await drive(h, id, "paid");
			h.tick(1000);
			await drive(h, id, "processing");
			h.tick(1000);
			await recordFulfillment(
				{ orderStore: h.orderStore },
				{
					orderId: id,
					carrier: "DHL",
					trackingNumber: "DH-9",
					recordedBy: "shipper",
					idempotencyKey: idempotencyKey(`f:${id}`),
				},
			);

			const timeline = await getOrderTimeline(
				{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
				id,
			);
			const entries = timeline?.entries ?? [];
			// created, →paid, →processing, →shipped, then the fulfillment detail (same
			// instant as the shipped flip — the state_change sorts before it).
			expect(entries.map((e) => e.kind)).toEqual([
				"created",
				"state_change",
				"state_change",
				"state_change",
				"fulfillment",
			]);
			expect(entries.at(-1)).toMatchObject({
				kind: "fulfillment",
				carrier: "DHL",
				recordedBy: "shipper",
			});
			expect(entries[3]).toMatchObject({ kind: "state_change", toState: "shipped" });
		});

		test("a historical order (no events) still yields a partial timeline and degrades gracefully", async () => {
			const h = await makeHarness();
			const id = orderId("ord-hist");
			await h.orderStore.createFromCart(pendingInput("ord-hist", "key-hist"));
			// Flag then resolve reconciliation — a resolve is NOT a state flip, so it
			// records no event; the order thus has zero state_change events.
			await h.orderStore.flagReconciliation(id, "commit lost for reservation res-1");
			h.tick(1000);
			await resolveReconciliation(
				{ orderStore: h.orderStore },
				{
					orderId: id,
					expectedFlag: "commit lost for reservation res-1",
					outcome: "written_off",
					reason: "false alarm",
					resolvedBy: "ops@shop",
					idempotencyKey: idempotencyKey(`rr:${id}`),
				},
			);
			h.tick(1000);
			await addNote(h, { orderId: id, author: "ops", body: "closed out", key: "n-h" });

			const timeline = await getOrderTimeline(
				{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
				id,
			);
			expect(timeline?.stateChangesAudited).toBe(false);
			expect(timeline?.entries.map((e) => e.kind)).toEqual([
				"created",
				"reconciliation_resolved",
				"note",
			]);
			expect(timeline?.entries[1]).toMatchObject({
				kind: "reconciliation_resolved",
				outcome: "written_off",
				resolvedBy: "ops@shop",
			});
		});

		test("same-instant entries keep a deterministic order via the kind rank", async () => {
			// No tick: creation, the note, and the paid flip all share T0. The kind
			// rank orders them created < state_change < note regardless of iteration.
			const h = await makeHarness();
			const id = orderId("ord-tie");
			await h.orderStore.createFromCart(pendingInput("ord-tie", "key-tie"));
			await addNote(h, { orderId: id, author: "a", body: "note at T0", key: "n-tie" });
			await h.orderStore.markPaid(id);
			const timeline = await getOrderTimeline(
				{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
				id,
			);
			expect(timeline?.entries.map((e) => e.kind)).toEqual(["created", "state_change", "note"]);
		});

		test("getOrderTimeline returns null for a missing order", async () => {
			const h = await makeHarness();
			expect(
				await getOrderTimeline(
					{ orderStore: h.orderStore, orderNotesStore: h.orderNotesStore },
					orderId("nope"),
				),
			).toBeNull();
		});
	});
}
