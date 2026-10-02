/**
 * What the console says after a cancel whose money MOVED but whose order did not
 * close, or that could not move the money at all (QA T1-4; ADR-0026). Driven through
 * the real dispatch table over a surface that answers with a fixed outcome — the
 * outcomes themselves are pinned in the domain's cancelWithRefundContract.
 */
import { describe, expect, test } from "vitest";
import type { AdminOrdersSurface, CancelOrderResult } from "../src/admin/admin-orders-surface.js";
import { dispatchOrdersAction, type OrdersActionResult } from "../src/admin/orders-actions.js";

const ORDER_ID = "order-cancel-copy";

function refuse(method: string) {
	return (): never => {
		throw new Error(`${method} must not be called here`);
	};
}

function surface(outcome: CancelOrderResult): AdminOrdersSurface {
	return {
		getOrder: () =>
			Promise.resolve({
				order: { id: ORDER_ID, state: "paid" } as never,
				allowedTransitions: [],
			}),
		cancelOrder: () => Promise.resolve(outcome),
		transitionOrder: refuse("transitionOrder"),
		recordFulfillment: refuse("recordFulfillment"),
		getRefunds: refuse("getRefunds"),
		refundOrder: refuse("refundOrder"),
		listOrders: refuse("listOrders"),
		resolveReconciliation: refuse("resolveReconciliation"),
		getCustomerContext: refuse("getCustomerContext"),
		getTimeline: refuse("getTimeline"),
		listNotes: refuse("listNotes"),
		addNote: refuse("addNote"),
	};
}

async function cancel(outcome: CancelOrderResult): Promise<OrdersActionResult> {
	const result = await dispatchOrdersAction(
		"orders:cancel-customer_request",
		{ orderId: ORDER_ID, reason: "customer_request", state: "paid", restock: "true" },
		surface(outcome),
	);
	expect(result).toBeDefined();
	return result as OrdersActionResult;
}

describe("the cancel notices when the money and the order part ways", () => {
	test("refunded, but the cancel did not finish: click again, it will not refund twice", async () => {
		const result = await cancel({
			ok: false,
			status: 409,
			reason: "CANCEL_INCOMPLETE_AFTER_REFUND",
			refund: { amountCents: 2400, currency: "USD" },
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Refunded, but the cancel didn’t finish");
		expect(result.notice?.description).toBe(
			"Refunded $24.00, but the cancel didn’t finish — click Cancel order again (it will not refund twice).",
		);
	});

	test("refunded, but the order moved on: the notice names the state it moved to", async () => {
		const result = await cancel({
			ok: false,
			status: 409,
			reason: "CANCEL_LOST_AFTER_REFUND",
			refund: { amountCents: 2400, currency: "USD" },
			restockedUnits: 1,
			movedTo: "delivered",
		});
		const description = String(result.notice?.description);
		expect(description).toContain("moved to delivered");
		expect(description).not.toContain("shipped first");
		expect(description).toContain("1 item was returned to stock");
	});

	test("a refund Otta cannot issue: a full manual refund closes the order, so restock by hand", async () => {
		const result = await cancel({ ok: false, status: 409, reason: "REFUND_NOT_AUTOMATIC" });
		const description = String(result.notice?.description);
		expect(description).toContain("Money → Refunds");
		expect(description).toContain("closes the order as refunded");
		expect(description).toContain("restock");
	});

	test("a retried cancel that kept the first attempt's restock says the units came back, whatever the box says", async () => {
		// The operator unticked Return to stock on the retry; the first attempt had
		// already restocked, and the domain kept that choice (ADR-0026).
		const result = await dispatchOrdersAction(
			"orders:cancel-customer_request",
			{ orderId: ORDER_ID, reason: "customer_request", state: "paid", restock: "false" },
			surface({
				ok: true,
				cancelled: true,
				refund: { amountCents: 2400, currency: "USD" },
				restockedUnits: 2,
				restockSkipped: [],
			}),
		);
		const description = String(result?.notice?.description);
		expect(description).toContain("2 items returned to stock");
		expect(description).not.toContain("Nothing was returned to stock");
	});

	test("a busy store after the refund says so, and that clicking again will not refund twice", async () => {
		const result = await cancel({
			ok: false,
			status: 409,
			reason: "CANCEL_INCOMPLETE_AFTER_REFUND",
			refund: { amountCents: 2400, currency: "USD" },
			retryable: true,
		});
		expect(result.notice?.description).toBe(
			"Refunded $24.00; the store was busy — click Cancel order again (it will not refund twice).",
		);
	});
});
