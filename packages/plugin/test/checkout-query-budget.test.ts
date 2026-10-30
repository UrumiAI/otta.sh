/**
 * Query budget of an order's two customer-facing invocations. Cloudflare Workers
 * Free allows 50 queries per invocation, and #572 added one storage call to every
 * reporting rollup event (day read, claim create, month touch, counters delta,
 * claim stamp). This counts every `ctx.storage` and `ctx.kv` call of (1) checkout
 * (`createOrder`) and (2) the Stripe settle webhook, and pins each under 50 and at
 * its exact measured number, so any change to the cost shows up here.
 */
import {
	cents,
	currency,
	idempotencyKey,
	money,
	orderId as brandOrderId,
	productId as brandProductId,
	sku as brandSku,
} from "@urumi.ai/otta-domain";
import { FakePaymentGateway } from "@urumi.ai/otta-domain/testing";
import { signStripeWebhook } from "@urumi.ai/otta-payments-stripe";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InProcessCommerceClient } from "../src/commerce/in-process-commerce-client.js";
import {
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_HEADER,
	WEBHOOK_EDGE_TOKEN_KEY,
} from "../src/payment-secrets.js";
import type { PluginContext } from "../src/types.js";
import { createStripeWebhookSettleHandler } from "../src/webhooks/stripe-settle-route.js";
import { countingStorage, type CallCounter } from "./cron-sweep-fixtures.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = currency("USD");
const LIMIT = 50;
const WEBHOOK_SECRET = "whsec_test_budget";
const EDGE_TOKEN = "otta_edge_budget";

let h: InProcessCommerceHarness;
let seq = 0;

beforeEach(async () => {
	h = await makeInProcessCommerce({
		gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
	});
});

afterEach(async () => {
	await h.close();
});

async function seedPhysical(sku: string): Promise<void> {
	await h.stores.productCommerce.upsert(
		{
			productId: brandProductId(`prod-${sku}`),
			sku: brandSku(sku),
			price: money(cents(5000), USD),
			title: sku,
			productKind: "physical",
		},
		idempotencyKey(`seed-${seq++}`),
	);
	await h.stores.productCommerce.activate(
		brandProductId(`prod-${sku}`),
		idempotencyKey(`publish-${seq++}`),
		"2026-01-01T00:00:00.000Z",
	);
	await h.stores.inventory.seedOnHand(brandSku(sku), 10);
}

async function cartOf(skus: string[]): Promise<string> {
	for (const sku of skus) await seedPhysical(sku);
	const { cartId } = await h.client.createCart(USD);
	for (const sku of skus) {
		const added = await h.client.addCartLine(cartId, sku, `prod-${sku}`, 1, `add-${seq++}`);
		if (!added.ok) throw new Error(added.reason);
	}
	return cartId;
}

/** `h.ctx` with storage and kv calls counted into `counter`. */
function countingCtx(counter: CallCounter): PluginContext {
	const kv = h.ctx.kv as unknown as Record<string, unknown>;
	const wrappedKv: Record<string, unknown> = {};
	for (const name of Object.keys(kv)) {
		const value = kv[name];
		wrappedKv[name] =
			typeof value === "function"
				? (...args: unknown[]) => {
						counter.calls++;
						return (value as (...a: unknown[]) => unknown).apply(h.ctx.kv, args);
					}
				: value;
	}
	return {
		...h.ctx,
		storage: countingStorage(h.ctx.storage!, counter),
		kv: wrappedKv,
	} as unknown as PluginContext;
}

function countingClient(counter: CallCounter): InProcessCommerceClient {
	return new InProcessCommerceClient(countingCtx(counter), {
		gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
	});
}

async function checkout(skus: string[], counter: CallCounter): Promise<string> {
	const cartId = await cartOf(skus);
	const client = countingClient(counter);
	counter.calls = 0;
	const placed = await client.createOrder(
		{ cartId, paymentMethod: "stripe", buyerRef: "ada@example.com" },
		`checkout:${cartId}`,
	);
	const measured = counter.calls;
	if (!placed.ok) throw new Error(placed.reason);
	counter.calls = measured;
	return placed.order.id;
}

describe("checkout invocation: createOrder", () => {
	test("one physical line", async () => {
		const counter: CallCounter = { calls: 0 };
		await checkout(["ONE-A"], counter);
		expect(counter.calls).toBeLessThanOrEqual(LIMIT);
		expect(counter.calls).toBe(29); // measured: storage+kv calls in createOrder, one physical line
	});

	test("three physical lines on three skus", async () => {
		const counter: CallCounter = { calls: 0 };
		await checkout(["TRI-A", "TRI-B", "TRI-C"], counter);
		expect(counter.calls).toBeLessThanOrEqual(LIMIT);
		expect(counter.calls).toBe(39); // measured: storage+kv calls in createOrder, three physical lines on three skus
	});
});

describe("settle invocation: the Stripe webhook marks the order paid", () => {
	test("one physical line", async () => {
		const orderId = await checkout(["SET-A"], { calls: 0 });
		const order = await h.stores.orderStore.getById(brandOrderId(orderId));
		if (order === null || order === undefined) throw new Error("order missing");
		await h.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await h.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		const signed = await signStripeWebhook(
			{
				eventId: `evt_${orderId}`,
				type: "payment_intent.succeeded",
				paymentIntentId: `pi_${orderId}`,
				orderId,
				amountCents: Number(order.totals.total),
				currency: "usd",
			},
			WEBHOOK_SECRET,
		);
		const counter: CallCounter = { calls: 0 };
		const handler = createStripeWebhookSettleHandler();
		const res = await handler(
			{
				input: {
					rawBodyBase64: Buffer.from(signed.body).toString("base64"),
					stripeSignature: signed.signatureHeader,
					idempotencyKey: `wh-${orderId}`,
				} as never,
				request: {
					method: "POST",
					url: "/route",
					headers: { [WEBHOOK_EDGE_TOKEN_HEADER]: EDGE_TOKEN },
				},
			},
			countingCtx(counter),
		);
		expect(res).toEqual({ ok: true, status: 200 });
		expect((await h.stores.orderStore.getById(brandOrderId(orderId)))?.state).toBe("paid");
		expect(counter.calls).toBeLessThanOrEqual(LIMIT);
		expect(counter.calls).toBe(26); // measured: storage+kv calls in Stripe settle webhook, one physical line
	});
});
