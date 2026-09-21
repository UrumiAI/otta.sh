import { cents, currency, orderId } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import {
	createTestFacilitator,
	signX402Proof,
	X402FacilitatorUnavailableError,
	X402PaymentGateway,
	type X402Facilitator,
} from "../src/index.js";

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
			proof: await proofOn("eip155:1"), // validly signed, wrong network
		});
		expect(res).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
	});

	test("accepts the same proof on an accepted network", async () => {
		const res = await gateway.verifyConfirmation({
			kind: "page_gate",
			proof: await proofOn("eip155:8453"),
		});
		expect(res.ok).toBe(true);
	});

	// Revision 2: a facilitator OUTAGE must never read as a forged receipt. The
	// port's `ConfirmationResult` has three reasons and all three are terminal, so
	// "could not ask" cannot be expressed as one of them without lying — the
	// gateway therefore throws a classified, RETRYABLE error instead, exactly as
	// `payments-stripe` throws `PaymentIntentError({retryable})` rather than
	// folding an ambiguous Stripe failure into a definite refusal.
	test("an UNAVAILABLE facilitator throws a retryable error, never INVALID_SIGNATURE", async () => {
		const unavailable: X402Facilitator = {
			async verifyReceipt() {
				return { valid: false, unavailable: true };
			},
		};
		const g = new X402PaymentGateway({
			facilitator: unavailable,
			payTo: "0xTEST",
			accepts: ["eip155:8453"],
		});
		const raw = { kind: "page_gate", proof: await proofOn("eip155:8453") } as const;
		await expect(g.verifyConfirmation(raw)).rejects.toBeInstanceOf(X402FacilitatorUnavailableError);
		await expect(g.verifyConfirmation(raw)).rejects.toMatchObject({ retryable: true });
	});

	test("a facilitator that ANSWERED no is still a terminal INVALID_SIGNATURE", async () => {
		const answeredNo: X402Facilitator = {
			async verifyReceipt() {
				return { valid: false };
			},
		};
		const g = new X402PaymentGateway({
			facilitator: answeredNo,
			payTo: "0xTEST",
			accepts: ["eip155:8453"],
		});
		expect(
			await g.verifyConfirmation({ kind: "page_gate", proof: await proofOn("eip155:8453") }),
		).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
	});
});
