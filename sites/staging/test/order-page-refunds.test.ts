/**
 * The public order page states refunds (QA2 X3). A cancelled order whose money
 * went back, and a paid order partly refunded, used to read exactly like ones
 * with no refund at all — only the email said so.
 *
 * The figure is the order's refunds LEDGER (`PublicOrderView.refundedCents`, the
 * plugin's recorded refunds, the same single ledger read the account page uses),
 * through the account page's own `orderRefundedNote`: "Refunded $X" as its own line
 * under the total, and NOTHING when the ledger shows none — which includes "Mark
 * refunded" (money returned outside Otta): the status then says "refunded" and the
 * page invents no amount.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { orderRefundedNote } from "../src/lib/account.js";
import { orderStamp } from "../src/lib/order-stamp.js";
import { splitAstro, templateOf } from "./astro-source.js";
import { SRC, viewCases } from "./theme-views.js";

const page = readFileSync(path.join(SRC, "pages/orders/[orderId].astro"), "utf8");

describe("the order page's refunded line", () => {
	test("is the account page's rule over the ledger's figure", () => {
		expect(splitAstro(page).frontmatter).toContain(
			"orderRefundedNote(order.refundedCents, order.currency)",
		);
		expect(orderRefundedNote(2000, "USD")).toBe("Refunded $20.00");
		expect(orderRefundedNote(0, "USD")).toBeNull();
	});

	test.each(viewCases("order"))(
		"%s prints it under the totals, only when there is one",
		(_l, { source }) => {
			const template = templateOf(source);
			expect(template).toMatch(/refundedNote !== null &&/);
			expect(template).toContain("{refundedNote}");
		},
	);

	test("a refund outside Otta (no ledger rows) is the status alone", () => {
		expect(
			orderStamp({
				state: "refunded",
				latePayment: "none",
				returnedFromStripe: false,
				holdLapsed: false,
				polling: false,
			})?.headline,
		).toBe("This order has been refunded.");
		expect(orderRefundedNote(0, "USD")).toBeNull();
	});
});

describe("refund timing reads the same everywhere (QA2 N5)", () => {
	test("the order page says business days, as the refund email does", () => {
		for (const latePayment of ["refunded", "refund_pending"] as const) {
			const body = orderStamp({
				state: "expired",
				latePayment,
				returnedFromStripe: false,
				holdLapsed: false,
				polling: false,
			})?.body;
			expect(body).toContain("5–10 business days");
		}
	});
});
