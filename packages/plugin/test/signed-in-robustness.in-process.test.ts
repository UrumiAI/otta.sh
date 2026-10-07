/**
 * The signed-in order paths never cost the shopper the thing they asked for.
 *
 * A session only decides who OWNS an order, and the listing's claim is a
 * convenience riding on a read. So a store that cannot answer either right now
 * (contention past its retry budget, say) must degrade to what happened before
 * the feature existed: a GUEST order, and the list of orders already owned —
 * never a refused checkout or a failed "Your orders". Both failures are logged
 * by message only.
 *
 * Real document store (in-process harness); the one failing call is forced on
 * the real adapter's prototype, so every other read and write is the real one.
 */
import { email as toEmail } from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { EmdashOrderStore, EmdashSessionStore } from "@otta-sh/store-emdash";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) {
		harness = await makeInProcessCommerce({
			gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
		});
	} else await harness.reset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.close();
});

async function session(address: string): Promise<string> {
	const issued = await harness.stores.credentialVerifier.issueChallenge(toEmail(address));
	if (!issued.ok) throw new Error("challenge not issued");
	const verified = await harness.client.verifyLogin(issued.challengeId, issued.token);
	if (!verified.ok) throw new Error("login failed");
	return verified.sessionToken;
}

async function cartWithOneItem(tag: string): Promise<string> {
	const productId = `prod-robust-${tag}`;
	await harness.client.upsertProductCommerce(
		productId,
		{
			sku: `SKU-ROBUST-${tag}`,
			title: "Robust",
			price: { amount: 900, currency: "USD" },
			initialOnHand: 3,
		},
		`robust-seed-${tag}`,
	);
	await harness.client.activateProductCommerce(
		productId,
		`robust-publish-${tag}`,
		"2026-01-01T00:00:00.000Z",
	);
	const { cartId } = await harness.client.createCart("USD");
	const added = await harness.client.addCartLine(
		cartId,
		`SKU-ROBUST-${tag}`,
		productId,
		1,
		`robust-add-${tag}`,
	);
	if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
	return cartId;
}

describe("signed-in order paths degrade, never fail", () => {
	test("a session read that throws at checkout places a GUEST order and logs the message", async () => {
		const bearer = await session("robust-co@example.test");
		const cartId = await cartWithOneItem("co");
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(EmdashSessionStore.prototype, "validate").mockRejectedValueOnce(
			new Error("compare-and-set budget exhausted"),
		);

		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "robust-co@example.test" },
			"robust-co-key",
			{ sessionToken: bearer },
		);
		expect(placed.ok).toBe(true);
		if (!placed.ok) return;
		expect((await harness.stores.orderStore.getById(placed.order.id as never))?.customerId).toBe(
			null,
		);
		expect(errors).toHaveBeenCalledWith(
			expect.stringContaining("checkout owner"),
			"compare-and-set budget exhausted",
		);
	});

	test("a claim that throws while listing still lists the orders already owned, and logs the message", async () => {
		const bearer = await session("robust-list@example.test");
		const cartId = await cartWithOneItem("list");
		const owned = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "robust-list@example.test" },
			"robust-list-key",
			{ sessionToken: bearer },
		);
		if (!owned.ok) throw new Error(`checkout failed: ${owned.reason}`);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(EmdashOrderStore.prototype, "linkGuestOrders").mockRejectedValueOnce(
			new Error("storage busy"),
		);

		const listed = await harness.client.listMyOrders(bearer);
		expect(listed.ok && listed.orders.map((order) => order.id)).toEqual([owned.order.id]);
		expect(errors).toHaveBeenCalledWith(expect.stringContaining("claim"), "storage busy");
	});
});
