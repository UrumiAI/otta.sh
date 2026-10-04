import {
	adminNextStates,
	manualPaymentAllowed,
	markRefundedAllowed,
	markRefundedRefusal,
	PROVIDER_REFUNDED_FLAG_PREFIX,
	unrefundedCapturedCents,
} from "@otta-sh/domain";
import { describe, expect, test } from "vitest";

// The admin's status offer: the state machine's legal moves minus the ones a person
// must not make by hand. The use-case's refusals are pinned in the transition
// contract (both stores); this pins the pure offer the console renders buttons from.

/** Nothing captured, nothing refunded. */
const NOTHING = { payments: [], refunds: [] };
const CAPTURED = { payments: [{ amount: 1000, status: "succeeded" }], refunds: [] };

describe("adminNextStates", () => {
	test("a pending order is offered neither paid nor a bare cancelled", () => {
		for (const paymentMethod of ["stripe", "x402", null] as const) {
			expect(
				adminNextStates({ state: "pending", paymentMethod, reconciliationFlag: null }, NOTHING),
			).toEqual(["expired"]);
		}
	});

	test("no order is offered a bare cancelled — Cancel order records why", () => {
		expect(
			adminNextStates(
				{ state: "paid", paymentMethod: "stripe", reconciliationFlag: null },
				NOTHING,
			),
		).toEqual(["processing", "completed", "refunded"]);
		expect(
			adminNextStates(
				{ state: "processing", paymentMethod: "stripe", reconciliationFlag: null },
				NOTHING,
			),
		).toEqual(["shipped", "refunded"]);
		expect(
			adminNextStates(
				{ state: "cancelled", paymentMethod: "stripe", reconciliationFlag: null },
				NOTHING,
			),
		).toEqual([]);
	});
});

describe("manualPaymentAllowed", () => {
	test("fails closed: no method is declared offline, and no method on file is not one", () => {
		expect(manualPaymentAllowed("stripe")).toBe(false);
		expect(manualPaymentAllowed("x402")).toBe(false);
		expect(manualPaymentAllowed(null)).toBe(false);
	});
});

describe("Mark refunded is offered only where no money is left to return through the provider (QA2 M4)", () => {
	const stripePaid = {
		state: "paid" as const,
		paymentMethod: "stripe" as const,
		reconciliationFlag: null,
	};

	test("a Stripe order with captured, unrefunded money is not offered Mark refunded", () => {
		expect(adminNextStates(stripePaid, CAPTURED)).toEqual(["processing", "completed"]);
		expect(markRefundedAllowed(stripePaid, CAPTURED)).toBe(false);
	});

	test("partly refunded still leaves money to return: not offered", () => {
		const partly = {
			payments: [{ amount: 1000, status: "succeeded" }],
			refunds: [{ amount: 400, status: "recorded" }],
		};
		expect(unrefundedCapturedCents(partly)).toBe(600);
		expect(markRefundedAllowed(stripePaid, partly)).toBe(false);
	});

	test("nothing left to refund: only RECORDED refunds count as returned; voided rows do not", () => {
		const covered = {
			payments: [{ amount: 1000, status: "succeeded" }],
			refunds: [
				{ amount: 1000, status: "recorded" },
				{ amount: 1000, status: "voided" },
			],
		};
		expect(unrefundedCapturedCents(covered)).toBe(0);
		expect(markRefundedAllowed(stripePaid, covered)).toBe(true);
		// A failed or pending payment is not captured money.
		expect(
			unrefundedCapturedCents({ payments: [{ amount: 1000, status: "failed" }], refunds: [] }),
		).toBe(0);
	});

	test.each(["reserved", "unverified"])(
		"a %s refund is not money returned: Mark refunded is refused REFUND_IN_FLIGHT and not offered",
		(status) => {
			const inFlight = {
				payments: [{ amount: 1000, status: "succeeded" }],
				refunds: [{ amount: 1000, status }],
			};
			expect(unrefundedCapturedCents(inFlight)).toBe(1000);
			expect(markRefundedRefusal(stripePaid, inFlight)).toBe("REFUND_IN_FLIGHT");
			expect(markRefundedAllowed(stripePaid, inFlight)).toBe(false);
			expect(adminNextStates(stripePaid, inFlight)).not.toContain("refunded");
			// Even where the provider reported it refunded, or the method is outside:
			// an unresolved refund on the ledger is resolved first.
			const flagged = { ...stripePaid, reconciliationFlag: `${PROVIDER_REFUNDED_FLAG_PREFIX} — x` };
			expect(markRefundedRefusal(flagged, inFlight)).toBe("REFUND_IN_FLIGHT");
		},
	);

	test("a PARTIAL provider refund flag does not unlock Mark refunded", () => {
		const partial = {
			...stripePaid,
			reconciliationFlag:
				"Provider shows this payment partially refunded: 3.50 USD of 10.00 USD — x",
		};
		expect(markRefundedRefusal(partial, CAPTURED)).toBe("REFUND_THROUGH_MONEY");
	});

	test("the provider reported the payment already refunded (the ledger's flag): offered", () => {
		const flagged = {
			...stripePaid,
			reconciliationFlag: `${PROVIDER_REFUNDED_FLAG_PREFIX} — re_x`,
		};
		expect(markRefundedAllowed(flagged, CAPTURED)).toBe(true);
		expect(adminNextStates(flagged, CAPTURED)).toContain("refunded");
		// Any OTHER open flag is not that evidence.
		expect(
			markRefundedAllowed({ ...stripePaid, reconciliationFlag: "amount mismatch" }, CAPTURED),
		).toBe(false);
	});

	test("a method that returns money outside Otta (x402) keeps Mark refunded", () => {
		expect(markRefundedAllowed({ ...stripePaid, paymentMethod: "x402" }, CAPTURED)).toBe(true);
	});
});
