import { orderTotalLabel, recordedRefundTotal } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";

// What the figure under an order's totals is called — ONE rule for the order
// page, the account's order page and the order emails, so they cannot drift.
// The figure is the order's total; the label says whether it was PAID. A refund
// is a separate fact, said by the order's status and (where the ledger knows it)
// a separate refunded amount — never by relabelling the total: "Mark refunded"
// records money returned outside Otta (ADR-0026), and a ledger refund can be
// capped below the total, so "Refunded $total" is not always true.

describe("orderTotalLabel", () => {
	test.each(["paid", "processing", "shipped", "delivered", "completed", "refunded"])(
		"%s: the money was captured, so the total is what was Paid",
		(state) => {
			expect(orderTotalLabel(state)).toBe("Paid");
		},
	);

	test.each(["pending", "expired", "failed", "cancelled", "something_new"])(
		"%s: nothing kept was paid, so it is only a Total",
		(state) => {
			expect(orderTotalLabel(state)).toBe("Total");
		},
	);
});

describe("recordedRefundTotal", () => {
	test("only RECORDED refunds are money returned — a reserved or unverified row is a promise", () => {
		expect(
			recordedRefundTotal([
				{ amount: 500, status: "recorded" },
				{ amount: 200, status: "reserved" },
				{ amount: 300, status: "recorded" },
			] as never),
		).toBe(800);
		expect(recordedRefundTotal([])).toBe(0);
	});
});
