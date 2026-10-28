import { createHmac } from "node:crypto";
import { orderId } from "@urumi.ai/otta-domain";
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
		const s = await signed(1500);
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
		const s = await signed(1500);
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
		const s = await signed(1500);
		const res = await gateway.verifyConfirmation({ kind: "webhook", body: s.body, headers: {} });
		expect(res).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
	});

	// -- review round: freshness window + secret-rotation (F3) -----------------

	test("rejects a correctly-signed webhook whose timestamp is outside the freshness window", async () => {
		// Signed with the RIGHT secret but a stale `t` (10 min ago > the 300s
		// default tolerance): replay hardening rejects it as INVALID_SIGNATURE.
		const stale = await signStripeWebhook(
			{
				eventId: "evt_stale",
				type: "payment_intent.succeeded",
				paymentIntentId: "pi_stale",
				orderId: "ord-1",
				amountCents: 1500,
				currency: "usd",
			},
			SECRET,
			{ timestamp: Math.floor(Date.now() / 1000) - 600 },
		);
		const res = await gateway.verifyConfirmation({
			kind: "webhook",
			body: stale.body,
			headers: { "Stripe-Signature": stale.signatureHeader },
		});
		expect(res).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
	});

	test("accepts a stale-but-signed webhook when the tolerance window is widened (configurable)", async () => {
		const lenient = new StripePaymentGateway({ webhookSecret: SECRET, toleranceSeconds: 3600 });
		const stale = await signStripeWebhook(
			{
				eventId: "evt_stale2",
				type: "payment_intent.succeeded",
				paymentIntentId: "pi_stale2",
				orderId: "ord-1",
				amountCents: 1500,
				currency: "usd",
			},
			SECRET,
			{ timestamp: Math.floor(Date.now() / 1000) - 600 },
		);
		const res = await lenient.verifyConfirmation({
			kind: "webhook",
			body: stale.body,
			headers: { "Stripe-Signature": stale.signatureHeader },
		});
		expect(res.ok).toBe(true);
	});

	test("accepts a header carrying multiple v1 signatures when ANY matches (secret rotation)", async () => {
		const s = await signed(1500);
		// During rotation Stripe signs with each active secret and sends one v1
		// per signature. Prepend a bogus v1 (the "old secret") before the real one.
		const [tPart, realV1] = s.signatureHeader.split(",");
		const rotated = `${tPart},v1=${"0".repeat(64)},${realV1}`;
		const res = await gateway.verifyConfirmation({
			kind: "webhook",
			body: s.body,
			headers: { "Stripe-Signature": rotated },
		});
		expect(res.ok).toBe(true);
	});

	test("rejects when no v1 signature in the header matches", async () => {
		const s = await signed(1500);
		const [tPart] = s.signatureHeader.split(",");
		const allWrong = `${tPart},v1=${"0".repeat(64)},v1=${"f".repeat(64)}`;
		const res = await gateway.verifyConfirmation({
			kind: "webhook",
			body: s.body,
			headers: { "Stripe-Signature": allWrong },
		});
		expect(res).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
	});
});

/** Sign an ARBITRARY event body the way Stripe does — `v1 = HMAC-SHA256(secret,
 *  "<t>.<raw body>")` — for shapes `signStripeWebhook` will not mint (it always
 *  stamps `metadata.order_id`). */
function signedRaw(event: unknown): { body: Uint8Array; headers: Record<string, string> } {
	const text = JSON.stringify(event);
	const t = Math.floor(Date.now() / 1000);
	const v1 = createHmac("sha256", SECRET).update(`${t}.${text}`).digest("hex");
	return {
		body: new TextEncoder().encode(text),
		headers: { "Stripe-Signature": `t=${t},v1=${v1}` },
	};
}

function intentEvent(metadata: unknown): unknown {
	return {
		id: "evt_foreign",
		type: "payment_intent.succeeded",
		data: { object: { id: "pi_foreign", amount: 1500, currency: "usd", metadata } },
	};
}

describe("a VERIFIED payment_intent event that is not Otta's is UNKNOWN_EVENT, not MALFORMED (#595)", () => {
	// A Stripe account shared with anything else (Payment Links, invoices, another
	// plugin) sends correctly signed `payment_intent.*` events Otta never created.
	// Refusing them as MALFORMED makes Stripe retry for days and, eventually,
	// disable the endpoint — Otta's own settlements included.
	const gateway = new StripePaymentGateway({ webhookSecret: SECRET });

	test.each([
		["metadata is empty", {}],
		["metadata.order_id is the empty string", { order_id: "" }],
		["metadata is absent", undefined],
	])("%s ⇒ UNKNOWN_EVENT (and never throws)", async (_label, metadata) => {
		const res = await gateway.verifyConfirmation({
			kind: "webhook",
			...signedRaw(intentEvent(metadata)),
		});
		expect(res).toEqual({ ok: false, reason: "UNKNOWN_EVENT" });
	});

	test("a signed body that is not an event shape stays MALFORMED", async () => {
		for (const event of [
			{ type: "payment_intent.succeeded", data: { object: {} } }, // no id
			{ id: "evt_x", type: "payment_intent.succeeded" }, // no data.object
			{
				...(intentEvent({ order_id: "ord-1" }) as object),
				data: { object: { id: "pi_1", metadata: { order_id: "ord-1" } } },
			}, // no amount/currency
			intentEvent({ order_id: 42 }), // Stripe metadata values are always strings
		]) {
			const res = await gateway.verifyConfirmation({ kind: "webhook", ...signedRaw(event) });
			expect(res).toEqual({ ok: false, reason: "MALFORMED" });
		}
	});
});
