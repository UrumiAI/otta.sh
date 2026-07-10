import { cents, currency, orderId } from "@urumi/domain";
import { describe, expect, test } from "vitest";
import { createTestFacilitator, signX402Proof, X402PaymentGateway } from "../src/index.js";

// Review round (F4): seam hardening — a receipt settled on a network the
// gateway's challenge never offered proves nothing about our requirements and
// must be rejected before (and regardless of) facilitator verification.

const SECRET = "x402_facilitator_test_secret";

describe("X402PaymentGateway seam hardening", () => {
	const gateway = new X402PaymentGateway({
		facilitator: createTestFacilitator(SECRET),
		payTo: "0xTEST",
		accepts: ["eip155:8453"],
	});

	function proofOn(network: string) {
		return signX402Proof(
			{
				orderId: orderId("ord-1"),
				transaction: "0xdeadbeef",
				network,
				payer: "0xbuyer",
				amount: cents(900),
				currency: currency("USD"),
			},
			SECRET,
		);
	}

	test("rejects a proof settled on a network outside the gateway's accepts", async () => {
		const res = await gateway.verifyConfirmation({
			kind: "page_gate",
			proof: proofOn("eip155:1"), // validly signed, wrong network
		});
		expect(res).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
	});

	test("accepts the same proof on an accepted network", async () => {
		const res = await gateway.verifyConfirmation({
			kind: "page_gate",
			proof: proofOn("eip155:8453"),
		});
		expect(res.ok).toBe(true);
	});
});
