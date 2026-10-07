import { idempotencyKey, orderId } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { X402PaymentGateway } from "../src/index.js";

// Late-payment prevention asks every gateway to withdraw an expired order's
// intent. x402 has none to withdraw: its "intent" is a stateless page-gate
// challenge, and a payment is only ever a receipt the buyer brings back. The
// answer is the capability statement UNSUPPORTED — never a throw, never a network
// call — so the expiry sweep moves on without logging noise.

const gateway = new X402PaymentGateway({
	payTo: "0xTEST",
	accepts: ["eip155:8453"],
});

describe("X402PaymentGateway cancelIntent", () => {
	test("returns UNSUPPORTED — there is no standing intent to cancel", async () => {
		const res = await gateway.cancelIntent({
			orderId: orderId("ord-1"),
			intentId: "x402_ord-1",
			idempotencyKey: idempotencyKey("cancel-intent:x402_ord-1"),
		});
		expect(res).toEqual({ ok: false, reason: "UNSUPPORTED" });
	});
});
