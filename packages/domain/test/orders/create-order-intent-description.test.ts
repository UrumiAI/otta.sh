import { createOrderFromCart, idempotencyKey } from "@urumi/domain";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

/**
 * The India-export regression (2026-07-27). An INDIA-based Stripe account refuses
 * every export PaymentIntent that carries no `description` ("As per Indian
 * regulations, export transactions require a description"), so no card payment
 * could complete at all. The fix widens `CreateIntentInput` with the STRUCTURED
 * line data the domain already owns — `title` + `quantity` per line, plus the
 * order's frozen ship-to — and leaves the rendering to the adapter.
 *
 * These are the DOMAIN-side halves of that contract:
 *  - both `createIntent` call sites (the fresh checkout AND the I1 replay) carry it;
 *  - the titles come from the order's SNAPSHOT (CLAUDE.md's purchase-time
 *    snapshot invariant), so a later product rename cannot change what a replay
 *    sends — which is exactly what keeps Stripe's same-key replay byte-identical;
 *  - nothing pre-rendered crosses the port (no provider formatting in the domain).
 */
function cmd(cartId: string, over: Record<string, unknown> = {}) {
	return {
		cartId,
		idempotencyKey: idempotencyKey("k-desc"),
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe" as const,
		...over,
	};
}

const ADDRESS = {
	name: "Jenny Rosen",
	line1: "510 Townsend St",
	line2: "Apt 4",
	city: "San Francisco",
	region: "CA",
	postalCode: "94103",
	country: "US",
	email: "jenny@example.com",
	phone: "+1-415-555-0100",
};

describe("createOrderFromCart — the intent carries the order's SNAPSHOTTED line data", () => {
	let h: OrderHarness;

	beforeEach(async () => {
		h = makeOrderHarness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Blue Mug",
			onHand: 10,
		});
		await h.seedPhysical({
			productId: "p2",
			sku: "SKU-2",
			priceCents: 250,
			title: "Red Hat",
			onHand: 10,
		});
	});

	test("the fresh checkout passes every line's snapshotted title + quantity, in the order's own line order", async () => {
		const cartId = await h.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" },
			{ sku: "SKU-2", productId: "p2", qty: 1, kind: "physical" },
		]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(h.stripeGw.intentCalls).toHaveLength(1);
		expect(h.stripeGw.intentCalls[0]?.lines).toEqual(
			res.order.lines.map((line) => ({ title: line.title, quantity: line.quantity })),
		);
		expect(h.stripeGw.intentCalls[0]?.lines).toEqual([
			{ title: "Blue Mug", quantity: 2 },
			{ title: "Red Hat", quantity: 1 },
		]);
	});

	test("the port carries STRUCTURE, never a pre-rendered provider string", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		await createOrderFromCart(h.createDeps, cmd(cartId));
		const input = h.stripeGw.intentCalls[0];
		expect(Array.isArray(input?.lines)).toBe(true);
		// No `description` (or any other rendered sentence) may leak into the port:
		// how Stripe wants the goods expressed is ADAPTER knowledge.
		expect(input).not.toHaveProperty("description");
		for (const line of input?.lines ?? []) {
			expect(typeof line.title).toBe("string");
			expect(typeof line.quantity).toBe("number");
		}
	});

	test("the I1 REPLAY call site carries the same line data — a replay is never a description-less intent", async () => {
		const cartId = await h.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" },
			{ sku: "SKU-2", productId: "p2", qty: 1, kind: "physical" },
		]);
		const first = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(first.ok).toBe(true);
		const replay = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(replay.ok).toBe(true);
		expect(h.stripeGw.intentCalls).toHaveLength(2);
		expect(h.stripeGw.intentCalls[1]?.lines).toEqual(h.stripeGw.intentCalls[0]?.lines);
	});

	test("a product RENAMED between the two calls does NOT change the replay's line data (the snapshot invariant is what makes Stripe's same-key replay byte-identical)", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const first = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(first.ok).toBe(true);

		// The merchant renames the product AFTER checkout.
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Cerulean Mug (2026 edition)",
			onHand: 10,
		});

		const replay = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(replay.ok).toBe(true);
		expect(h.stripeGw.intentCalls[1]?.lines).toEqual([{ title: "Blue Mug", quantity: 2 }]);
		expect(JSON.stringify(h.stripeGw.intentCalls[1]?.lines)).toBe(
			JSON.stringify(h.stripeGw.intentCalls[0]?.lines),
		);
	});

	test("shipTo mirrors the order's FROZEN ship-to snapshot (India export of physical goods also needs a recipient)", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId, { shippingAddress: ADDRESS }));
		expect(res.ok).toBe(true);
		expect(h.stripeGw.intentCalls[0]?.shipTo).toEqual({
			name: "Jenny Rosen",
			line1: "510 Townsend St",
			line2: "Apt 4",
			city: "San Francisco",
			region: "CA",
			postalCode: "94103",
			country: "US",
		});
	});

	test("shipTo carries the POSTAL fields only — the buyer's email/phone never cross the gateway boundary", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		await createOrderFromCart(h.createDeps, cmd(cartId, { shippingAddress: ADDRESS }));
		const serialized = JSON.stringify(h.stripeGw.intentCalls[0]);
		expect(serialized).not.toContain("jenny@example.com");
		expect(serialized).not.toContain("555-0100");
	});

	test("an order with NO captured address carries no shipTo (honest absence, never a fabricated one)", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		expect(h.stripeGw.intentCalls[0]?.shipTo).toBeUndefined();
		// …and the lines are still there: a digital / no-ship order still needs a
		// description for the India-export rule.
		expect(h.stripeGw.intentCalls[0]?.lines).toEqual([{ title: "Blue Mug", quantity: 1 }]);
	});

	test("the shipTo snapshot survives the replay too (same frozen address, both call sites)", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		await createOrderFromCart(h.createDeps, cmd(cartId, { shippingAddress: ADDRESS }));
		await createOrderFromCart(h.createDeps, cmd(cartId, { shippingAddress: ADDRESS }));
		expect(h.stripeGw.intentCalls).toHaveLength(2);
		expect(h.stripeGw.intentCalls[1]?.shipTo).toEqual(h.stripeGw.intentCalls[0]?.shipTo);
	});

	test("a DIGITAL order carries its snapshotted title too (service exports need a description as well)", async () => {
		await h.seedDigital({ productId: "p3", sku: "SKU-3", priceCents: 500, title: "Ebook" });
		const cartId = await h.cartWith([{ sku: "SKU-3", productId: "p3", qty: 1, kind: "digital" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		expect(h.stripeGw.intentCalls[0]?.lines).toEqual([{ title: "Ebook", quantity: 1 }]);
	});
});
