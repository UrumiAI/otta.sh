/**
 * The console's notices say what became of the buyer's email — TRULY (QA T1-6).
 *
 * The writes used to answer "the buyer has been emailed" while the email sat in the
 * outbox for up to 15 minutes. Each admin write now sends it inline and reports
 * `email: "sent" | "queued" | "unconfigured"` (absent when it enqueued none), and
 * these cases pin that the copy follows that value and nothing else: "emailed" only
 * when it was sent, "queued — within a few minutes" when it was not yet, and "no
 * email" when the store has no provider. The inline send itself is pinned over a
 * real store in `admin-order-emails-inline.test.ts`.
 */
import { describe, expect, test } from "vitest";
import type {
	AdminOrdersSurface,
	InlineEmailStatus,
	OrderDetailResult,
} from "../src/admin/admin-orders-surface.js";
import { dispatchOrdersAction, type OrdersActionResult } from "../src/admin/orders-actions.js";

const ORDER_ID = "order-email-copy";

const SENT = "The buyer has been emailed.";
const QUEUED = "The buyer’s email is queued — it will go out within a few minutes.";
const UNCONFIGURED = "No email was sent — this store has no email provider set up.";

function refuse(method: string) {
	return (): never => {
		throw new Error(`${method} must not be called here`);
	};
}

/** A surface whose order sits in `state` and whose writes report `email`. */
function surface(state: string, email: InlineEmailStatus | undefined): AdminOrdersSurface {
	const detail: OrderDetailResult = {
		order: { id: ORDER_ID, state } as OrderDetailResult["order"],
		allowedTransitions: [],
	};
	const withEmail = email === undefined ? {} : { email };
	return {
		getOrder: () => Promise.resolve(detail),
		transitionOrder: () => Promise.resolve({ ok: true, transitioned: true, ...withEmail }),
		recordFulfillment: () => Promise.resolve({ ok: true, recorded: true, ...withEmail }),
		cancelOrder: () =>
			Promise.resolve({
				ok: true,
				cancelled: true,
				refund: { amountCents: 2400, currency: "USD" },
				restockedUnits: 1,
				...withEmail,
			}),
		getRefunds: () =>
			Promise.resolve({
				refunds: [],
				currency: "USD",
				capturedTotalCents: 2400,
				refundedTotalCents: 0,
				finalizedTotalCents: 0,
				ceilingCents: 2400,
				remainingCents: 2400,
				paymentMethod: "stripe",
				refundable: true,
			}),
		refundOrder: () =>
			Promise.resolve({
				ok: true,
				recorded: true,
				duplicate: false,
				fullyRefunded: false,
				...withEmail,
			}),
		listOrders: refuse("listOrders"),
		resolveReconciliation: refuse("resolveReconciliation"),
		getCustomerContext: refuse("getCustomerContext"),
		getTimeline: refuse("getTimeline"),
		listNotes: refuse("listNotes"),
		addNote: refuse("addNote"),
	};
}

async function act(
	client: AdminOrdersSurface,
	actionId: string,
	payload: Record<string, string>,
): Promise<OrdersActionResult> {
	const result = await dispatchOrdersAction(actionId, payload, client);
	expect(result, `${actionId} is not registered`).toBeDefined();
	return result as OrdersActionResult;
}

const WRITES: ReadonlyArray<{
	name: string;
	state: string;
	actionId: string;
	payload: Record<string, string>;
}> = [
	{
		name: "a status move",
		state: "paid",
		actionId: "orders:transition-processing",
		payload: { orderId: ORDER_ID, toState: "processing", state: "paid" },
	},
	{
		name: "a fulfilment",
		state: "processing",
		actionId: "orders:record-fulfillment",
		payload: { orderId: ORDER_ID, carrier: "UPS", trackingNumber: "1Z", recordedBy: "carol" },
	},
	{
		name: "a cancel",
		state: "paid",
		actionId: "orders:cancel-customer_request",
		payload: { orderId: ORDER_ID, reason: "customer_request", state: "paid" },
	},
	{
		name: "a partial refund",
		state: "paid",
		actionId: "orders:refund",
		payload: {
			orderId: ORDER_ID,
			amountCents: "500",
			refundedSoFarCents: "0",
			currency: "USD",
			refundedBy: "carol",
		},
	},
];

describe("each admin write's notice states what became of the buyer's email", () => {
	for (const write of WRITES) {
		test(`${write.name}: "emailed" only when the email was sent`, async () => {
			const sent = await act(surface(write.state, "sent"), write.actionId, write.payload);
			// (The fulfilment's reads "…emailed their tracking.")
			expect(sent.notice?.description).toContain("The buyer has been emailed");

			const queued = await act(surface(write.state, "queued"), write.actionId, write.payload);
			expect(queued.notice?.description).toContain(QUEUED);
			expect(queued.notice?.description).not.toContain("has been emailed");

			const none = await act(surface(write.state, "unconfigured"), write.actionId, write.payload);
			expect(none.notice?.description).toContain(UNCONFIGURED);
			expect(none.notice?.description).not.toContain("has been emailed");
		});
	}

	test("a status move that emails nobody (Mark refunded) says so and claims no email", async () => {
		const result = await act(surface("paid", undefined), "orders:transition-refunded", {
			orderId: ORDER_ID,
			toState: "refunded",
			state: "paid",
		});
		// The mark-paid guard's own notice (ADR-0026 Decision 3), unchanged by C.
		expect(result.notice).toEqual({
			variant: "default",
			title: "Marked refunded",
			description: "No money moved and the buyer was not emailed.",
		});
	});

	test("a status move names the state it moved the order to", async () => {
		const result = await act(surface("paid", "sent"), "orders:transition-processing", {
			orderId: ORDER_ID,
			toState: "processing",
			state: "paid",
		});
		expect(result.notice).toEqual({
			variant: "default",
			title: "Order marked processing",
			description: SENT,
		});
	});
});
