import { signStripeWebhook } from "@otta-sh/payments-stripe";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	STRIPE_WEBHOOK_SECRET,
	startTestServer,
	type TestServer,
} from "./helpers/start-test-server.js";

// The client-side HTTP contract (§8 step 4.8): the new endpoints exercised
// against a LIVE server backed by Postgres, using the offline fake-Stripe driver
// to POST a signed webhook. Proves the wire format does not drift from the ports.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("orders + webhook + entitlements HTTP contract", () => {
	let server: TestServer;
	beforeEach(async () => {
		server = await startTestServer();
	});
	afterEach(async () => {
		await server.stop();
	});

	async function createOrder(input: {
		sku: string;
		productId: string;
		kind: "physical" | "digital";
		priceCents: number;
		paymentMethod: "stripe" | "x402";
	}): Promise<{ orderId: string; totalCents: number }> {
		await server.seedProduct({
			productId: input.productId,
			sku: input.sku,
			priceCents: input.priceCents,
			title: "Item",
			kind: input.kind,
			onHand: input.kind === "physical" ? 5 : undefined,
		});
		const cart = await json(
			await fetch(`${server.baseUrl}/carts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ currency: "USD" }),
			}),
		);
		const cartId = cart["cartId"] as string;
		const addRes = await fetch(`${server.baseUrl}/carts/${cartId}/lines`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": `add-${cartId}` },
			body: JSON.stringify({ sku: input.sku, qty: 1, productId: input.productId }),
		});
		expect(addRes.status).toBe(200);
		const coRes = await fetch(`${server.baseUrl}/checkout/orders`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": `co-${cartId}` },
			body: JSON.stringify({
				cartId,
				paymentMethod: input.paymentMethod,
				buyerRef: "buyer@example.com",
			}),
		});
		expect(coRes.status).toBe(201);
		const order = (await json(coRes))["order"] as Record<string, unknown>;
		const totals = order["totals"] as Record<string, number>;
		return { orderId: order["id"] as string, totalCents: totals["totalCents"]! };
	}

	function stripeWebhook(
		orderId: string,
		amountCents: number,
		opts: { eventId?: string; badSecret?: boolean } = {},
	) {
		const signed = signStripeWebhook(
			{
				eventId: opts.eventId ?? `evt_${orderId}`,
				type: "payment_intent.succeeded",
				paymentIntentId: `pi_${orderId}`,
				orderId,
				amountCents,
				currency: "usd",
			},
			opts.badSecret ? "whsec_wrong" : STRIPE_WEBHOOK_SECRET,
		);
		return fetch(`${server.baseUrl}/webhooks/stripe`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Stripe-Signature": signed.signatureHeader },
			body: signed.body,
		});
	}

	async function orderState(orderId: string): Promise<string> {
		const res = await fetch(`${server.baseUrl}/orders/${orderId}`);
		const body = await json(res);
		return (body["order"] as Record<string, unknown>)["state"] as string;
	}

	test("POST /webhooks/stripe with a signed payment_intent.succeeded flips the order to paid", async () => {
		const { orderId, totalCents } = await createOrder({
			sku: "SKU-1",
			productId: "p1",
			kind: "physical",
			priceCents: 1500,
			paymentMethod: "stripe",
		});
		const res = await stripeWebhook(orderId, totalCents);
		expect(res.status).toBe(200);
		expect(await orderState(orderId)).toBe("paid");
	});

	test("redelivering the same event returns 200 and settles once", async () => {
		const { orderId, totalCents } = await createOrder({
			sku: "SKU-2",
			productId: "p2",
			kind: "physical",
			priceCents: 1500,
			paymentMethod: "stripe",
		});
		const first = await stripeWebhook(orderId, totalCents);
		const second = await stripeWebhook(orderId, totalCents);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await orderState(orderId)).toBe("paid");
	});

	test("bad signature returns 400 and does not settle", async () => {
		const { orderId, totalCents } = await createOrder({
			sku: "SKU-3",
			productId: "p3",
			kind: "physical",
			priceCents: 1500,
			paymentMethod: "stripe",
		});
		const res = await stripeWebhook(orderId, totalCents, { badSecret: true });
		expect(res.status).toBe(400);
		expect(await orderState(orderId)).toBe("pending");
	});

	test("GET /orders/:id reflects paid after the webhook (redirect poll)", async () => {
		const { orderId, totalCents } = await createOrder({
			sku: "SKU-4",
			productId: "p4",
			kind: "physical",
			priceCents: 2000,
			paymentMethod: "stripe",
		});
		expect(await orderState(orderId)).toBe("pending"); // poll before payment
		await stripeWebhook(orderId, totalCents);
		expect(await orderState(orderId)).toBe("paid"); // poll after webhook
	});

	// ADR-0009: checkout address capture, end-to-end over the wire.
	async function checkoutWithBody(
		body: Record<string, unknown>,
	): Promise<{ status: number; json: Record<string, unknown> }> {
		await server.seedProduct({
			productId: "pa",
			sku: "SKU-A",
			priceCents: 1200,
			title: "Widget A",
			kind: "physical",
			onHand: 5,
		});
		const cart = await json(
			await fetch(`${server.baseUrl}/carts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ currency: "USD" }),
			}),
		);
		const cartId = cart["cartId"] as string;
		await fetch(`${server.baseUrl}/carts/${cartId}/lines`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": `add-${cartId}` },
			body: JSON.stringify({ sku: "SKU-A", qty: 1, productId: "pa" }),
		});
		const res = await fetch(`${server.baseUrl}/checkout/orders`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": `co-${cartId}` },
			body: JSON.stringify({
				cartId,
				paymentMethod: "stripe",
				buyerRef: "buyer@example.com",
				...body,
			}),
		});
		return { status: res.status, json: await json(res) };
	}

	test("POST /checkout/orders captures a shipping address; an AUTHENTICATED GET /orders/:id serializes the frozen snapshot", async () => {
		const shippingAddress = {
			name: "Ada Lovelace",
			line1: "12 Analytical Way",
			city: "London",
			postalCode: "EC1A 1BB",
			country: "GB",
			email: "ada@example.com",
		};
		const { status, json: created } = await checkoutWithBody({ shippingAddress });
		expect(status).toBe(201);
		const orderId = (created["order"] as Record<string, unknown>)["id"] as string;
		// ADR-0010 §2 / PR D: the bare, unauthenticated GET is redacted — the
		// ADR-0009 capture assertion moves to the internal-token-gated read.
		const read = await json(
			await fetch(`${server.baseUrl}/orders/${orderId}`, {
				headers: { "X-Internal-Token": server.internalToken! },
			}),
		);
		const order = read["order"] as Record<string, unknown>;
		expect(order["shippingAddress"]).toEqual({
			name: "Ada Lovelace",
			line1: "12 Analytical Way",
			line2: null,
			city: "London",
			region: null,
			postalCode: "EC1A 1BB",
			country: "GB",
			email: "ada@example.com",
			phone: null,
		});
	});

	test("the UNAUTHENTICATED GET /orders/:id omits shippingAddress (and buyerRef/customerId) entirely (PR D)", async () => {
		const shippingAddress = {
			name: "Ada Lovelace",
			line1: "12 Analytical Way",
			city: "London",
			postalCode: "EC1A 1BB",
			country: "GB",
			email: "ada@example.com",
		};
		const { status, json: created } = await checkoutWithBody({ shippingAddress });
		expect(status).toBe(201);
		const orderId = (created["order"] as Record<string, unknown>)["id"] as string;
		const publicRead = await json(await fetch(`${server.baseUrl}/orders/${orderId}`));
		const order = publicRead["order"] as Record<string, unknown>;
		expect(order).not.toHaveProperty("shippingAddress");
		expect(order).not.toHaveProperty("buyerRef");
		expect(order).not.toHaveProperty("customerId");
		// The guest-confirmation payload stays intact.
		expect(order["id"]).toBe(orderId);
		expect(order["state"]).toBe("pending");
	});

	test("POST /checkout/orders with no address yields a null ship-to (capture optional this slice)", async () => {
		const { status, json: created } = await checkoutWithBody({});
		expect(status).toBe(201);
		expect((created["order"] as Record<string, unknown>)["shippingAddress"]).toBeNull();
	});

	test("POST /checkout/orders rejects a malformed address (missing required field) with 400", async () => {
		const { status } = await checkoutWithBody({
			shippingAddress: { name: "Ada", line1: "12 Analytical Way", city: "London", country: "GB" },
		});
		// Missing postalCode ⇒ zod 400 (never a half-written order).
		expect(status).toBe(400);
	});

	test("GET /entitlements/check returns active after a digital order is paid", async () => {
		const { orderId, totalCents } = await createOrder({
			sku: "DIG-1",
			productId: "d1",
			kind: "digital",
			priceCents: 900,
			paymentMethod: "stripe",
		});
		const before = await json(
			await fetch(`${server.baseUrl}/entitlements/check?orderId=${orderId}&sku=DIG-1`),
		);
		expect(before["active"]).toBe(false);
		await stripeWebhook(orderId, totalCents);
		const after = await json(
			await fetch(`${server.baseUrl}/entitlements/check?orderId=${orderId}&sku=DIG-1`),
		);
		expect(after["active"]).toBe(true);
	});
});
