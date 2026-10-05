/**
 * The guest order read's `latePayment` status, over the REAL in-process client and
 * document store. It is what the confirmation page reads to decide whether it may
 * still say "Nothing was charged" on an expired order — which the late-payment bug
 * made false: the buyer paid after the hold lapsed, the money was captured, and
 * the page kept promising otherwise.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const AMOUNT = 1500;
const usd = toCurrency("USD");
let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

/** A pending stripe order whose hold has already lapsed, then expired. */
async function expiredOrder(id: string): Promise<void> {
	const store = harness.stores.orderStore;
	await store.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: usd,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2000-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku: toSku(`SKU-${id}`),
				title: "Digital Widget",
				unitPrice: cents(AMOUNT),
				currency: usd,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(AMOUNT), total: cents(AMOUNT), currency: usd },
	});
	expect(await store.expire(toOrderId(id), "2001-01-01T00:00:00.000Z")).toBe(true);
}

async function capture(id: string): Promise<void> {
	await harness.stores.orderStore.recordPayment({
		orderId: toOrderId(id),
		gateway: "stripe",
		providerRef: `pi_${id}`,
		amount: cents(AMOUNT),
		currency: usd,
		status: "succeeded",
	});
}

async function latePaymentOf(id: string): Promise<string | undefined> {
	const read = await harness.client.getPublicOrder(id);
	return read.ok ? read.order.latePayment : undefined;
}

describe("getPublicOrder · latePayment", () => {
	test("an expired order nobody paid: none — 'Nothing was charged' stays true", async () => {
		await expiredOrder("lp-none");
		expect(await latePaymentOf("lp-none")).toBe("none");
	});

	test("captured after expiry and not yet refunded: refund_pending — never 'nothing was charged'", async () => {
		await expiredOrder("lp-pending");
		await capture("lp-pending");
		expect(await latePaymentOf("lp-pending")).toBe("refund_pending");
	});

	test("captured after expiry and refunded in full: refunded", async () => {
		await expiredOrder("lp-refunded");
		await capture("lp-refunded");
		await harness.stores.orderStore.recordRefund({
			orderId: toOrderId("lp-refunded"),
			amount: cents(AMOUNT),
			currency: usd,
			kind: "gateway",
			gateway: "stripe",
			refundRef: "re_lp",
			reason: null,
			refundedBy: "otta:auto-refund",
			idempotencyKey: toIdempotencyKey("late-payment-refund:pi_lp-refunded"),
		});
		expect(await latePaymentOf("lp-refunded")).toBe("refunded");
	});
});
