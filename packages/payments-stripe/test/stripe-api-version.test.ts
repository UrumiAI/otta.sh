import { describe, expect, test } from "vitest";
import { createStripeHttpTransport, STRIPE_API_VERSION } from "../src/index.js";

const SK = "sk_test_123";

/** Records every outbound request's headers and answers each Stripe path with a
 *  well-formed body — NO network. */
function recordingFetch(seen: Array<{ url: string; headers: Headers }>): typeof fetch {
	return (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(target);
		seen.push({ url, headers: new Headers(init?.headers) });
		const body = url.includes("/v1/refunds")
			? { id: "re_1", amount: 500, currency: "usd" }
			: url.includes("/v1/charges/")
				? { amount_refunded: 0, amount_captured: 1000, currency: "usd" }
				: init?.method === "GET"
					? { latest_charge: { amount_refunded: 0, amount_captured: 1000, currency: "usd" } }
					: { id: "pi_1", client_secret: "pi_1_secret_x" };
		return new Response(JSON.stringify(body), { status: 200 });
	}) as unknown as typeof fetch;
}

describe("createStripeHttpTransport pins the Stripe API version (#114)", () => {
	test("STRIPE_API_VERSION is a specific dated version, not a floating default", () => {
		expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
	});

	test("every outbound call carries Stripe-Version: STRIPE_API_VERSION", async () => {
		const seen: Array<{ url: string; headers: Headers }> = [];
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: recordingFetch(seen),
		});

		expect(
			await transport.createPaymentIntent({
				orderId: "ord-1",
				amountCents: 2500,
				currency: "USD",
				idempotencyKey: "key-1",
				secretKey: SK,
				description: "Order ord-1",
			}),
		).toMatchObject({ ok: true });
		expect(
			await transport.readRefundedAmount({ providerRef: "pi_1", secretKey: SK }),
		).toMatchObject({ ok: true });
		expect(
			await transport.readRefundedAmount({ providerRef: "ch_1", secretKey: SK }),
		).toMatchObject({ ok: true });
		expect(
			await transport.createRefund({
				providerRef: "pi_1",
				amountCents: 500,
				idempotencyKey: "rf-1",
				secretKey: SK,
			}),
		).toMatchObject({ ok: true });

		expect(seen.map((r) => new URL(r.url).pathname)).toEqual([
			"/v1/payment_intents",
			"/v1/payment_intents/pi_1",
			"/v1/charges/ch_1",
			"/v1/refunds",
		]);
		for (const { url, headers } of seen) {
			expect(headers.get("stripe-version"), url).toBe(STRIPE_API_VERSION);
			// Pinning must not displace the auth header it sits beside.
			expect(headers.get("authorization"), url).toBe(`Bearer ${SK}`);
		}
	});
});
