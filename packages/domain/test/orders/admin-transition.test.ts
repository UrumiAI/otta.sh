import { adminNextStates, manualPaymentAllowed } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";

// The admin's status offer: the state machine's legal moves minus the ones a person
// must not make by hand. The use-case's refusals are pinned in the transition
// contract (both stores); this pins the pure offer the console renders buttons from.

describe("adminNextStates", () => {
	test("a pending order is offered neither paid nor a bare cancelled", () => {
		for (const paymentMethod of ["stripe", "x402", null] as const) {
			expect(adminNextStates({ state: "pending", paymentMethod })).toEqual(["expired"]);
		}
	});

	test("no order is offered a bare cancelled — Cancel order records why", () => {
		expect(adminNextStates({ state: "paid", paymentMethod: "stripe" })).toEqual([
			"processing",
			"completed",
			"refunded",
		]);
		expect(adminNextStates({ state: "processing", paymentMethod: "stripe" })).toEqual([
			"shipped",
			"refunded",
		]);
		expect(adminNextStates({ state: "cancelled", paymentMethod: "stripe" })).toEqual([]);
	});
});

describe("manualPaymentAllowed", () => {
	test("fails closed: no method is declared offline, and no method on file is not one", () => {
		expect(manualPaymentAllowed("stripe")).toBe(false);
		expect(manualPaymentAllowed("x402")).toBe(false);
		expect(manualPaymentAllowed(null)).toBe(false);
	});
});
