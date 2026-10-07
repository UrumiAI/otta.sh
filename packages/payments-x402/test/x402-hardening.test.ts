import { cents, currency, orderId, type RawConfirmation } from "@otta-sh/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { X402PaymentGateway } from "../src/index.js";

// ADR-0028, increment 2: the receipt-forwarding model is retired, and until
// increment 7 the gateway settles NOTHING. A `page_gate` still carries an
// `X402Proof` that any caller can fill in, and the facilitator call that used to
// stand between it and a paid order is gone. So `verifyConfirmation` refuses
// every confirmation, however plausible, and never reaches the network.
// Decision 2's invariant — no client-supplied JSON ever reaches a `page_gate`
// confirmation — rests on this refusal and on the settle route's deletion.

const gateway = new X402PaymentGateway({ payTo: "0xTEST", accepts: ["eip155:8453"] });

function pageGate(overrides: Partial<{ network: string; signature: string }> = {}) {
	return {
		kind: "page_gate",
		proof: {
			orderId: orderId("ord-1"),
			transaction: "0xdeadbeef",
			network: overrides.network ?? "eip155:8453",
			payer: "0xbuyer",
			amount: cents(900),
			currency: currency("USD"),
			signature: overrides.signature ?? "ab".repeat(32),
		},
	} as const satisfies RawConfirmation;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("X402PaymentGateway refuses every confirmation until ADR-0028 increment 7", () => {
	test("a well-formed page_gate on an accepted network is MALFORMED, not settled", async () => {
		expect(await gateway.verifyConfirmation(pageGate())).toEqual({
			ok: false,
			reason: "MALFORMED",
		});
	});

	test("a page_gate on a network the challenge never offered is MALFORMED too", async () => {
		expect(await gateway.verifyConfirmation(pageGate({ network: "eip155:1" }))).toEqual({
			ok: false,
			reason: "MALFORMED",
		});
	});

	test("a page_gate with an empty signature is MALFORMED", async () => {
		expect(await gateway.verifyConfirmation(pageGate({ signature: "" }))).toEqual({
			ok: false,
			reason: "MALFORMED",
		});
	});

	test("a webhook-shaped confirmation is MALFORMED (x402 has no webhooks)", async () => {
		expect(
			await gateway.verifyConfirmation({ kind: "webhook", body: new Uint8Array(), headers: {} }),
		).toEqual({ ok: false, reason: "MALFORMED" });
	});

	test("the refusal makes no network call: the gateway holds no transport at all", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await gateway.verifyConfirmation(pageGate());
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
