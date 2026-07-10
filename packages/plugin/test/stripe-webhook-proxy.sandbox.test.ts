import { signStripeWebhook } from "@urumi/payments-stripe";
import { afterEach, describe, expect, test } from "vitest";
import {
	LIVE_STRIPE_WEBHOOK_SECRET,
	type LiveService,
	startLiveService,
} from "./helpers/start-live-service.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// Step 4.9: the Stripe webhook PROXY under the workerd-on-Node sandbox. The plugin
// forwards the base64-exact raw body + Stripe-Signature to the REAL service, whose
// HMAC verification over the raw bytes still passes — proving byte-exact fidelity
// through the sandbox bridge (§9 Risk 1). Postgres-required (the live service).

const PG = process.env.PG_CONNECTION_STRING;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

async function setup(): Promise<{ live: LiveService; sandbox: SandboxHandle }> {
	const live = await startLiveService();
	cleanups.push(() => live.stop());
	const sandbox = await loadPluginInSandbox({
		allowedHosts: [live.host],
		commerceServiceBaseUrl: live.baseUrl,
	});
	cleanups.push(() => sandbox.close());
	return { live, sandbox };
}

async function createPaidableOrder(
	live: LiveService,
): Promise<{ orderId: string; totalCents: number }> {
	await fetch(`${live.baseUrl}/products/p1/commerce`, {
		method: "PUT",
		headers: { "content-type": "application/json", "Idempotency-Key": "seed-p1" },
		body: JSON.stringify({
			sku: "SKU-1",
			price: { amount: 1500, currency: "USD" },
			title: "Widget",
			productKind: "physical",
			initialOnHand: 5,
		}),
	});
	const cart = (await (
		await fetch(`${live.baseUrl}/carts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ currency: "USD" }),
		})
	).json()) as { cartId: string };
	await fetch(`${live.baseUrl}/carts/${cart.cartId}/lines`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": "add-1" },
		body: JSON.stringify({ sku: "SKU-1", qty: 1, productId: "p1" }),
	});
	const co = (await (
		await fetch(`${live.baseUrl}/checkout/orders`, {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": "co-1" },
			body: JSON.stringify({ cartId: cart.cartId, paymentMethod: "stripe", buyerRef: "b@e.com" }),
		})
	).json()) as { order: { id: string; totals: { totalCents: number } } };
	return { orderId: co.order.id, totalCents: co.order.totals.totalCents };
}

async function orderState(live: LiveService, orderId: string): Promise<string> {
	const body = (await (await fetch(`${live.baseUrl}/orders/${orderId}`)).json()) as {
		order: { state: string };
	};
	return body.order.state;
}

describe.skipIf(PG === undefined)("stripe webhook proxy (workerd sandbox)", () => {
	test("proxied webhook body still verifies service-side (byte-exact) and settles the order", async () => {
		const { live, sandbox } = await setup();
		const { orderId, totalCents } = await createPaidableOrder(live);
		const signed = signStripeWebhook(
			{
				eventId: `evt_${orderId}`,
				type: "payment_intent.succeeded",
				paymentIntentId: `pi_${orderId}`,
				orderId,
				amountCents: totalCents,
				currency: "usd",
			},
			LIVE_STRIPE_WEBHOOK_SECRET,
		);
		const bodyBase64 = Buffer.from(signed.body).toString("base64");

		const outcome = await sandbox.invokeRoute(
			"webhooks/stripe",
			{ bodyBase64 },
			{ headers: { "stripe-signature": signed.signatureHeader } },
		);
		expect(outcome).toHaveProperty("result");
		const result = (outcome as { result: { status: number } }).result;
		expect(result.status).toBe(200); // byte-exact ⇒ HMAC verified service-side
		expect(await orderState(live, orderId)).toBe("paid");
	});

	test("a body corrupted after signing fails service-side verification (400) and does not settle", async () => {
		const { live, sandbox } = await setup();
		const { orderId, totalCents } = await createPaidableOrder(live);
		const signed = signStripeWebhook(
			{
				eventId: `evt_${orderId}`,
				type: "payment_intent.succeeded",
				paymentIntentId: `pi_${orderId}`,
				orderId,
				amountCents: totalCents,
				currency: "usd",
			},
			LIVE_STRIPE_WEBHOOK_SECRET,
		);
		// Corrupt one byte of the signed body before base64-encoding.
		const corrupted = new Uint8Array(signed.body);
		const idx = corrupted.length - 2;
		corrupted[idx] = (corrupted[idx] ?? 0) ^ 0xff;
		const bodyBase64 = Buffer.from(corrupted).toString("base64");

		const outcome = await sandbox.invokeRoute(
			"webhooks/stripe",
			{ bodyBase64 },
			{ headers: { "stripe-signature": signed.signatureHeader } },
		);
		const result = (outcome as { result: { status: number } }).result;
		expect(result.status).toBe(400); // HMAC over the corrupted bytes fails
		expect(await orderState(live, orderId)).toBe("pending");
	});
});
