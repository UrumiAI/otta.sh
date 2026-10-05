import { createOrderFromCart, idempotencyKey } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { makeOrderHarness } from "./fake-harness.js";

// The checkout's half of late-payment prevention: the intent the gateway mints is
// recorded on the order (it used to live only in the reply and the pay-page
// cookie, so nothing server-side could ever name it to cancel).

describe("createOrderFromCart records the intent it minted", () => {
	test("once, even when the same key is replayed — and due at the order's hold", async () => {
		const h = makeOrderHarness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "W",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const command = {
			cartId,
			idempotencyKey: idempotencyKey("k1"),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe" as const,
		};
		const first = await createOrderFromCart(h.createDeps, command);
		if (!first.ok) throw new Error(first.reason);
		const replay = await createOrderFromCart(h.createDeps, command);
		expect(replay.ok).toBe(true);

		const intents = await h.orderStore.listPaymentIntents(first.order.id);
		expect(intents.map((i) => [i.gateway, i.intentId, i.cancelDueAt])).toEqual([
			["stripe", `fake_${first.order.id}`, first.order.holdExpiresAt],
		]);
	});

	test("a failed bookkeeping write never fails the checkout — the buyer already holds a payable intent", async () => {
		const h = makeOrderHarness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "W",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		h.orderStore.recordPaymentIntent = () => Promise.reject(new Error("storage busy"));

		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey("k2"),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});

		expect(res.ok).toBe(true);
	});
});
