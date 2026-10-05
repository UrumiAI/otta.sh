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
		resolveUnverifiedRefund: refuse("resolveUnverifiedRefund"),
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
		expect(description).toContain("1 item restocked");
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

	test("the lost race's refund email is sent inline, and the notice says whether it went", async () => {
		const outcome = {
			ok: false as const,
			status: 409,
			reason: "CANCEL_LOST_AFTER_REFUND",
			refund: { amountCents: 2400, currency: "USD" },
			restockedUnits: 0,
			movedTo: "shipped",
		};
		const sent = await cancel({ ...outcome, email: "sent" });
		expect(String(sent.notice?.description)).toContain("Buyer emailed about the refund.");
		const queued = await cancel({ ...outcome, email: "queued" });
		expect(String(queued.notice?.description)).toContain(
			"Refund email queued; retried automatically.",
		);
		// The warning is never what fitting the banner cuts.
		for (const result of [sent, queued]) {
			expect(String(result.notice?.description)).toContain(
				"don’t ship or refund it again unchecked",
			);
			expect(String(result.notice?.description).endsWith("…")).toBe(false);
		}
	});

	test("a lost race with no refund titles the notice by what did move", async () => {
		const base = {
			ok: false as const,
			status: 409,
			reason: "CANCEL_LOST_AFTER_REFUND",
			refund: null,
			movedTo: "shipped",
		};
		expect((await cancel({ ...base, restockedUnits: 2 })).notice?.title).toBe(
			"Restocked, but the order was not cancelled",
		);
		expect((await cancel({ ...base, restockedUnits: 0 })).notice?.title).toBe(
			"Not cancelled — the order moved first",
		);
	});
});
