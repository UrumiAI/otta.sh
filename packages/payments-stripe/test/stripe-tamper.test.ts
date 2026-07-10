import { orderId } from "@urumi/domain";
import { describe, expect, test } from "vitest";
import { signStripeWebhook, StripePaymentGateway } from "../src/index.js";

const SECRET = "whsec_test_phase4";

describe("StripePaymentGateway verifyConfirmation", () => {
	const gateway = new StripePaymentGateway({ webhookSecret: SECRET });

	function signed(amountCents: number) {
		return signStripeWebhook(
			{
				eventId: "evt_1",
				type: "payment_intent.succeeded",
				paymentIntentId: "pi_1",
				orderId: "ord-1",
				amountCents,
				currency: "usd",
			},
			SECRET,
		);
	}

	test("verifies a correctly signed payment_intent.succeeded", async () => {
		const s = signed(1500);
		const res = await gateway.verifyConfirmation({
			kind: "webhook",
			body: s.body,
			headers: { "Stripe-Signature": s.signatureHeader },
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.outcome).toBe("succeeded");
		expect(res.orderId).toBe(orderId("ord-1"));
		expect(res.amount).toBe(1500);
		expect(res.currency).toBe("USD");
		expect(res.dedupeKey).toBe("evt_1");
	});

	test("rejects a body whose bytes were altered after signing", async () => {
		const s = signed(1500);
		// Flip the amount in the raw bytes WITHOUT re-signing: HMAC must fail.
		const tampered = new TextEncoder().encode(
			new TextDecoder().decode(s.body).replace('"amount":1500', '"amount":1'),
		);
		const res = await gateway.verifyConfirmation({
			kind: "webhook",
			body: tampered,
			headers: { "Stripe-Signature": s.signatureHeader },
		});
		expect(res).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
	});

	test("rejects a missing signature header", async () => {
		const s = signed(1500);
		const res = await gateway.verifyConfirmation({ kind: "webhook", body: s.body, headers: {} });
		expect(res).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
	});
});
