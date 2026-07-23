import { cents, currency, idempotencyKey, orderId } from "@urumi/domain";
import { describe, expect, test } from "vitest";
import { createTestFacilitator, X402PaymentGateway } from "../src/index.js";

// ADR-0008: x402 cannot refund. On-chain settlement is irreversible and the
// adapter holds no signing wallet — `refundable` is false by construction and
// `refund` returns the capability statement UNSUPPORTED (never a thrown error).

const gateway = new X402PaymentGateway({
	facilitator: createTestFacilitator("secret"),
	payTo: "0xTEST",
	accepts: ["eip155:8453"],
});

describe("X402PaymentGateway refund capability (ADR-0008)", () => {
	test("declares refundable:false", () => {
		expect(gateway.refundable).toBe(false);
	});

	test("refund returns UNSUPPORTED — a capability statement, not a runtime error", async () => {
		const res = await gateway.refund({
			orderId: orderId("ord-1"),
			providerRef: "0xdeadbeef",
			amount: cents(500),
			currency: currency("USD"),
			priorRefunded: cents(0),
			idempotencyKey: idempotencyKey("rf-1"),
		});
		expect(res).toEqual({ ok: false, reason: "UNSUPPORTED" });
	});
});
