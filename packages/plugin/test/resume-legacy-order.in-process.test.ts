/**
 * A PENDING order whose stored method has no wired gateway — one Otta removed (an
 * x402 order placed before its removal), or an unknown value — cannot be
 * resumed: nothing can take its payment. The resume answers the typed
 * `ORDER_NOT_PAYABLE` its pay page already knows, never a thrown "no payment
 * gateway configured" that the route would turn into a 500.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	type PaymentMethod,
} from "@otta-sh/domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

describe("resumeOrderPayment on an order whose method has no gateway", () => {
	let harness: InProcessCommerceHarness;
	beforeAll(async () => {
		harness = await makeInProcessCommerce();
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test.each(["x402", "bogus", "toString", "Stripe"])(
		"a pending %s order resumed by its cart is ORDER_NOT_PAYABLE, not a throw",
		async (method) => {
			const id = `no-gateway-${method}`;
			const usd = toCurrency("USD");
			await harness.stores.orderStore.createFromCart({
				orderId: toOrderId(id),
				cartId: `cart-${id}`,
				currency: usd,
				idempotencyKey: toIdempotencyKey(`${id}-key`),
				holdExpiresAt: "2099-01-01T00:00:00.000Z",
				buyerRef: "buyer@example.test",
				paymentMethod: method as unknown as PaymentMethod,
				lines: [
					{
						productId: toProductId(`prod-${id}`),
						sku: toSku(`SKU-${id.toUpperCase()}`),
						title: "Legacy",
						unitPrice: cents(1500),
						currency: usd,
						quantity: 1,
						fulfillmentKind: "digital",
						reservationId: null,
					},
				],
				totals: { subtotal: cents(1500), total: cents(1500), currency: usd },
			});
			expect(await harness.client.resumeOrderPayment(id, { cartId: `cart-${id}` })).toEqual({
				ok: false,
				reason: "ORDER_NOT_PAYABLE",
			});
		},
	);
});
