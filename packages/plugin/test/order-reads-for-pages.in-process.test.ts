/**
 * What the storefront's order pages read off an order, over the REAL in-process
 * client and document store (QA round 2: X1, X2, X3).
 *
 *  - X2 — a second checkout tab. The place reply says WHICH email the order was
 *    placed with (masked, `buyerRefHint`) and whether it is the one this request
 *    typed (`buyerRefMatches`): a same-key replay keeps the order's own email and
 *    silently ignored the typed one, so the site could not tell the shopper.
 *  - X3 — the public order read carries what the refunds LEDGER shows returned
 *    (`refundedCents`, recorded refunds only), so the confirmation page can say
 *    "Refunded $X" for a cancelled-with-refund or partly refunded order. A refund
 *    made outside Otta has no ledger row and stays 0: the page invents no amount.
 *  - X1 — the account's order read carries the delivery address and the
 *    tracking, which the signed-in shopper's own page shows (it is private; the
 *    public read still omits the address).
 */
import {
	cents,
	currency as toCurrency,
	email as toEmail,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;
const usd = toCurrency("USD");

beforeEach(async () => {
	if (harness === undefined) {
		harness = await makeInProcessCommerce({
			gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
		});
	} else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

async function cartWithOneItem(tag: string): Promise<string> {
	const productId = `prod-reads-${tag}`;
	await harness.client.upsertProductCommerce(
		productId,
		{
			sku: `SKU-READS-${tag}`,
			title: "Reads",
			price: { amount: 1000, currency: "USD" },
			initialOnHand: 5,
		},
		`reads-seed-${tag}`,
	);
	await harness.client.activateProductCommerce(
		productId,
		`reads-publish-${tag}`,
		"2026-01-01T00:00:00.000Z",
	);
	const { cartId } = await harness.client.createCart("USD");
	const added = await harness.client.addCartLine(
		cartId,
		`SKU-READS-${tag}`,
		productId,
		1,
		`reads-add-${tag}`,
	);
	if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
	return cartId;
}

async function session(address: string): Promise<string> {
	const issued = await harness.stores.credentialVerifier.issueChallenge(toEmail(address));
	if (!issued.ok) throw new Error("challenge not issued");
	const verified = await harness.client.verifyLogin(issued.challengeId, issued.token);
	if (!verified.ok) throw new Error("login failed");
	return verified.sessionToken;
}

async function refund(orderId: string, amount: number, key: string, status?: "reserved") {
	const input = {
		orderId: toOrderId(orderId),
		amount: cents(amount),
		currency: usd,
		kind: "gateway" as const,
		gateway: "stripe" as const,
		refundRef: `re_${key}`,
		reason: null,
		refundedBy: "admin@example.test",
		idempotencyKey: toIdempotencyKey(key),
	};
	if (status === "reserved") await harness.stores.orderStore.reserveRefund(input);
	else await harness.stores.orderStore.recordRefund(input);
}

async function paid(orderId: string): Promise<void> {
	await harness.stores.orderStore.recordPayment({
		orderId: toOrderId(orderId),
		gateway: "stripe",
		providerRef: `pi_${orderId}`,
		amount: cents(1000),
		currency: usd,
		status: "succeeded",
	});
	expect(await harness.stores.orderStore.markPaid(toOrderId(orderId))).toBe(true);
}

describe("createOrder · which email the order was placed with (X2)", () => {
	test("the first place: the masked email, and it matches what was typed", async () => {
		const cartId = await cartWithOneItem("x2a");
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "jane.doe@example.com" },
			`checkout:${cartId}`,
		);
		if (!placed.ok) throw new Error(placed.reason);
		expect(placed.buyerRefHint).toBe("j•••@e•••.com");
		expect(placed.buyerRefMatches).toBe(true);
	});

	test("a replay from another tab with a DIFFERENT email: the order keeps its own, and says it does not match", async () => {
		const cartId = await cartWithOneItem("x2b");
		const first = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "jane.doe@example.com" },
			`checkout:${cartId}`,
		);
		if (!first.ok) throw new Error(first.reason);
		const second = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "other@mailbox.test" },
			`checkout:${cartId}`,
		);
		if (!second.ok) throw new Error(second.reason);
		expect(second.order.id).toBe(first.order.id);
		expect(second.buyerRefHint).toBe("j•••@e•••.com");
		expect(second.buyerRefMatches).toBe(false);
		// Never the address itself.
		expect(JSON.stringify(second)).not.toContain("jane.doe");
	});

	test("the same email typed with different case or spaces still matches", async () => {
		const cartId = await cartWithOneItem("x2c");
		await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "jane.doe@example.com" },
			`checkout:${cartId}`,
		);
		const again = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "Jane.Doe@Example.COM" },
			`checkout:${cartId}`,
		);
		if (!again.ok) throw new Error(again.reason);
		expect(again.buyerRefMatches).toBe(true);
	});
});

describe("getPublicOrder · refundedCents (X3)", () => {
	test("nothing refunded: 0", async () => {
		const cartId = await cartWithOneItem("x3a");
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "x3a@example.test" },
			`checkout:${cartId}`,
		);
		if (!placed.ok) throw new Error(placed.reason);
		const read = await harness.client.getPublicOrder(placed.order.id);
		expect(read.ok && read.order.refundedCents).toBe(0);
	});

	test("a partial refund on a paid order: the recorded amount — a reserved row does not count", async () => {
		const cartId = await cartWithOneItem("x3b");
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "x3b@example.test" },
			`checkout:${cartId}`,
		);
		if (!placed.ok) throw new Error(placed.reason);
		await paid(placed.order.id);
		await refund(placed.order.id, 400, "x3b-r1");
		await refund(placed.order.id, 100, "x3b-r2", "reserved");
		const read = await harness.client.getPublicOrder(placed.order.id);
		if (!read.ok) throw new Error(read.reason);
		expect(read.order.refundedCents).toBe(400);
		expect(read.order.state).toBe("paid");
	});
});

describe("getMyOrder · the delivery address and the tracking (X1)", () => {
	test("the signed-in owner's read carries the ship-to (no contact fields) and the fulfilment", async () => {
		const bearer = await session("x1@example.test");
		const cartId = await cartWithOneItem("x1");
		const placed = await harness.client.createOrder(
			{
				cartId,
				paymentMethod: "stripe",
				buyerRef: "x1@example.test",
				shippingAddress: {
					name: "Ada Lovelace",
					line1: "1 Analytical Way",
					city: "London",
					postalCode: "N1 9GU",
					country: "GB",
					phone: "+44 20 0000 0000",
				},
			},
			`checkout:${cartId}`,
			{ sessionToken: bearer },
		);
		if (!placed.ok) throw new Error(placed.reason);
		await paid(placed.order.id);
		await harness.stores.orderStore.transition({
			orderId: toOrderId(placed.order.id),
			fromState: "paid",
			toState: "processing",
			idempotencyKey: toIdempotencyKey("x1-processing"),
			enqueueEmail: false,
		});
		await harness.stores.orderStore.recordFulfillment({
			orderId: toOrderId(placed.order.id),
			fromState: "processing",
			carrier: "Royal Mail",
			trackingNumber: "RM123",
			trackingUrl: "https://track.example/RM123",
			shippedAt: null,
			recordedBy: "admin@example.test",
			idempotencyKey: toIdempotencyKey("x1-ship"),
			enqueueEmail: false,
		});

		const read = await harness.client.getMyOrder(bearer, placed.order.id);
		if (!read.ok) throw new Error(read.reason);
		expect(read.order.shippingAddress).toEqual({
			name: "Ada Lovelace",
			line1: "1 Analytical Way",
			line2: null,
			city: "London",
			region: null,
			postalCode: "N1 9GU",
			country: "GB",
		});
		expect(read.order.fulfillment).toMatchObject({
			carrier: "Royal Mail",
			trackingNumber: "RM123",
			trackingUrl: "https://track.example/RM123",
		});
		expect(read.order.fulfillment).not.toHaveProperty("recordedBy");

		// The public read still carries no address.
		const publicRead = await harness.client.getPublicOrder(placed.order.id);
		expect(publicRead.ok && publicRead.order).not.toHaveProperty("shippingAddress");
	});

	test("an order with no ship-to and nothing shipped: both null", async () => {
		const bearer = await session("x1b@example.test");
		const cartId = await cartWithOneItem("x1b");
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "x1b@example.test" },
			`checkout:${cartId}`,
			{ sessionToken: bearer },
		);
		if (!placed.ok) throw new Error(placed.reason);
		const read = await harness.client.getMyOrder(bearer, placed.order.id);
		if (!read.ok) throw new Error(read.reason);
		expect(read.order.shippingAddress).toBeNull();
		expect(read.order.fulfillment).toBeNull();
	});
});
