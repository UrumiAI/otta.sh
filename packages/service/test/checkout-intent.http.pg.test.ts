import type {
	StripeCreatePaymentIntentInput,
	StripeCreatePaymentIntentResult,
	StripeCreateRefundResult,
	StripePreflightResult,
	StripeTransport,
} from "@otta-sh/payments-stripe";
import { afterEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// The live-intent path over HTTP (§8 step 4.8 style): a secretKey-configured
// server drives the transport seam, so `POST /checkout/orders` returns STRIPE's
// intent id + client secret — and a transport failure surfaces as a 502
// PAYMENT_INTENT_FAILED with the order left pending (healed by expireOrders).

const PG = process.env.PG_CONNECTION_STRING;

/** Records the create-intent input and plays a scripted result. */
class RecordingTransport implements StripeTransport {
	result: StripeCreatePaymentIntentResult = {
		ok: true,
		intentId: "pi_live_http",
		clientSecret: "pi_live_http_secret_abc",
	};
	readonly intents: StripeCreatePaymentIntentInput[] = [];

	async readRefundedAmount(): Promise<StripePreflightResult> {
		return { ok: true, view: { amountRefunded: 0, amountCaptured: 0, currency: "usd" } };
	}
	async createRefund(): Promise<StripeCreateRefundResult> {
		return { ok: true, refundId: "re_x", amountCents: 0, currency: "usd" };
	}
	async createPaymentIntent(
		input: StripeCreatePaymentIntentInput,
	): Promise<StripeCreatePaymentIntentResult> {
		this.intents.push(input);
		return this.result;
	}
}

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("checkout → live Stripe createIntent (HTTP)", () => {
	let server: TestServer;
	afterEach(async () => {
		await server.stop();
	});

	/** Seeds a product, builds a one-line cart and checks it out. Returns the
	 *  raw response AND the cart id, so a test can read the cart back afterwards. */
	async function checkout(
		s: TestServer,
		opts: {
			priceCents?: number;
			idempotencyKey?: string;
			shippingAddress?: Record<string, string>;
		} = {},
	): Promise<{ res: Response; cartId: string }> {
		const suffix = Math.random().toString(36).slice(2, 8);
		const sku = `SKU-${suffix}`;
		await s.seedProduct({
			productId: `p-${suffix}`,
			sku,
			priceCents: opts.priceCents ?? 2500,
			title: "Widget",
			kind: "physical",
			onHand: 5,
		});
		const cart = await json(
			await fetch(`${s.baseUrl}/carts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ currency: "USD" }),
			}),
		);
		const cartId = cart["cartId"] as string;
		const addRes = await fetch(`${s.baseUrl}/carts/${cartId}/lines`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": `add-${cartId}` },
			body: JSON.stringify({ sku, qty: 1, productId: `p-${suffix}` }),
		});
		expect(addRes.status).toBe(200);
		const res = await fetch(`${s.baseUrl}/checkout/orders`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": opts.idempotencyKey ?? `co-${cartId}`,
			},
			body: JSON.stringify({
				cartId,
				paymentMethod: "stripe",
				buyerRef: "buyer@example.com",
				...(opts.shippingAddress !== undefined ? { shippingAddress: opts.shippingAddress } : {}),
			}),
		});
		return { res, cartId };
	}

	test("a secretKey-configured server returns STRIPE's real intentId + clientSecret", async () => {
		const transport = new RecordingTransport();
		server = await startTestServer({ stripeSecretKey: "sk_test_http", stripeTransport: transport });
		const { res } = await checkout(server);
		expect(res.status).toBe(201);
		const body = await json(res);
		expect(body["intent"]).toEqual({
			gateway: "stripe",
			intentId: "pi_live_http",
			clientAction: { kind: "stripe_client_secret", clientSecret: "pi_live_http_secret_abc" },
		});
	});

	test("the transport receives metadata order_id = the created order id, the total in minor units, and the request's Idempotency-Key", async () => {
		const transport = new RecordingTransport();
		server = await startTestServer({ stripeSecretKey: "sk_test_http", stripeTransport: transport });
		const { res } = await checkout(server, { priceCents: 1234, idempotencyKey: "idem-live-1" });
		expect(res.status).toBe(201);
		const order = (await json(res))["order"] as Record<string, unknown>;
		expect(transport.intents).toHaveLength(1);
		expect(transport.intents[0]).toEqual({
			orderId: order["id"],
			amountCents: 1234,
			currency: "usd",
			idempotencyKey: "idem-live-1",
			secretKey: "sk_test_http",
			// The India-export description, rendered from the ORDER's snapshotted
			// title — a card payment against an India-based account is refused
			// without it. No ship-to was submitted ⇒ no `shipping` key at all.
			description: "1 × Widget",
		});
	});

	test("a submitted ship-to reaches Stripe as `shipping` (India requires it alongside the description for goods)", async () => {
		const transport = new RecordingTransport();
		server = await startTestServer({ stripeSecretKey: "sk_test_http", stripeTransport: transport });
		const { res } = await checkout(server, {
			idempotencyKey: "idem-live-ship",
			shippingAddress: {
				name: "Jenny Rosen",
				line1: "510 Townsend St",
				city: "San Francisco",
				region: "CA",
				postalCode: "94103",
				country: "US",
				email: "jenny@example.com",
				phone: "+1-415-555-0100",
			},
		});
		expect(res.status).toBe(201);
		expect(transport.intents[0]?.shipping).toEqual({
			name: "Jenny Rosen",
			line1: "510 Townsend St",
			city: "San Francisco",
			state: "CA",
			postalCode: "94103",
			country: "US",
		});
		// PII minimization: the buyer's contact channels never cross the boundary.
		const serialized = JSON.stringify(transport.intents[0]);
		expect(serialized).not.toContain("jenny@example.com");
		expect(serialized).not.toContain("555-0100");
	});

	test("a retryable intent failure ⇒ 502 PAYMENT_INTENT_FAILED, and the order is still pending", async () => {
		const transport = new RecordingTransport();
		transport.result = { ok: false, class: "retryable", status: 503 };
		server = await startTestServer({ stripeSecretKey: "sk_test_http", stripeTransport: transport });
		const { res } = await checkout(server, { idempotencyKey: "idem-live-fail" });
		expect(res.status).toBe(502);
		expect(await json(res)).toEqual({ ok: false, reason: "PAYMENT_INTENT_FAILED" });

		// The pending order row survives — a same-key retry re-honors it.
		transport.result = { ok: true, intentId: "pi_retry", clientSecret: "pi_retry_secret" };
		const retry = await fetch(`${server.baseUrl}/checkout/orders`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": "idem-live-fail" },
			body: JSON.stringify({
				cartId: "nonexistent-cart-id",
				paymentMethod: "stripe",
				buyerRef: "buyer@example.com",
			}),
		});
		expect(retry.status, "the I1 replay short-circuits on the key, not the cart").toBe(201);
		// The I1 REPLAY re-issues the intent through the OTHER call site. Its body
		// must be byte-identical to the first attempt's — Stripe rejects a same-key
		// retry whose payload drifted — which holds because both sites render the
		// order's purchase-time line SNAPSHOT.
		expect(transport.intents).toHaveLength(2);
		expect(transport.intents[1]?.description).toBe(transport.intents[0]?.description);
		expect(transport.intents[1]?.description).toBe("1 × Widget");
		const order = (await json(retry))["order"] as Record<string, unknown>;
		const fetched = await json(await fetch(`${server.baseUrl}/orders/${String(order["id"])}`));
		expect((fetched["order"] as Record<string, unknown>)["state"]).toBe("pending");
	});

	test("the checked-out cart names the order it became (#132)", async () => {
		server = await startTestServer();
		const { res, cartId } = await checkout(server);
		expect(res.status).toBe(201);
		const order = (await json(res))["order"] as Record<string, unknown>;

		const read = await fetch(`${server.baseUrl}/carts/${cartId}`);
		expect(read.status).toBe(200);
		const cart = (await json(read))["cart"] as Record<string, unknown>;
		// The pair, over the real wire: terminal AND stamped, from one statement.
		expect({ state: cart["state"], orderId: cart["orderId"] }).toEqual({
			state: "checked_out",
			orderId: order["id"],
		});
		// The stamp precedes the payment intent, so it is emphatically NOT a
		// payment signal: this order is still `pending`.
		expect(order["state"]).toBe("pending");
	});

	test("the DEFAULT (no secretKey) server still returns the deterministic pi_<orderId> handle", async () => {
		server = await startTestServer();
		const { res } = await checkout(server);
		expect(res.status).toBe(201);
		const body = await json(res);
		const order = body["order"] as Record<string, unknown>;
		expect(body["intent"]).toEqual({
			gateway: "stripe",
			intentId: `pi_${String(order["id"])}`,
			clientAction: {
				kind: "stripe_client_secret",
				clientSecret: expect.stringContaining(`pi_${String(order["id"])}_secret_`),
			},
		});
	});
});
