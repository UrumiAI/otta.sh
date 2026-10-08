/**
 * A PENDING order paid with a method Otta removed (an x402 order placed before
 * its removal) cannot be resumed: no gateway can take its payment. The resume
 * answers the typed `ORDER_NOT_PAYABLE` its pay page already knows, never a
 * thrown "no payment gateway configured" that the route would turn into a 500.
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

describe("resumeOrderPayment on a legacy x402 order", () => {
	let harness: InProcessCommerceHarness;
	beforeAll(async () => {
		harness = await makeInProcessCommerce();
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test("a pending x402 order resumed by its cart is ORDER_NOT_PAYABLE, not a throw", async () => {
		const usd = toCurrency("USD");
		await harness.stores.orderStore.createFromCart({
			orderId: toOrderId("legacy-x402-pending"),
			cartId: "cart-legacy-x402",
			currency: usd,
			idempotencyKey: toIdempotencyKey("legacy-x402-pending-key"),
			holdExpiresAt: "2099-01-01T00:00:00.000Z",
			buyerRef: "buyer@example.test",
			paymentMethod: "x402" as unknown as PaymentMethod,
			lines: [
				{
					productId: toProductId("prod-legacy-x402"),
					sku: toSku("SKU-LEGACY-X402"),
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
		expect(
			await harness.client.resumeOrderPayment("legacy-x402-pending", {
				cartId: "cart-legacy-x402",
			}),
		).toEqual({ ok: false, reason: "ORDER_NOT_PAYABLE" });
	});
});
