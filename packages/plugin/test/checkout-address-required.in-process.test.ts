/**
 * Issue #382 at the commerce client: when the payment account needs every
 * buyer's name and address (an India-based Stripe account), `createOrder`
 * refuses an address-less checkout of ANY cart — digital included — with the
 * same typed MISSING_SHIPPING_ADDRESS a physical cart in a zoned store gets, and
 * a complete address reaches the payment intent. Nothing changes for an account
 * that does not need it.
 *
 * Real document store (in-process harness); the gateway is the domain's
 * recording fake, so the case can read exactly what the intent was asked for.
 */
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let required: boolean | Error = false;
let resolverCalls = 0;
let gateway: FakePaymentGateway;
let harness: InProcessCommerceHarness;

beforeEach(async () => {
	required = false;
	resolverCalls = 0;
	if (harness === undefined) {
		gateway = new FakePaymentGateway({ id: "stripe" });
		harness = await makeInProcessCommerce({
			gateways: { stripe: gateway },
			resolveAddressRequired: async () => {
				resolverCalls += 1;
				if (required instanceof Error) throw required;
				return required;
			},
		});
	} else await harness.reset();
	gateway.intentCalls.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.close();
});

let seq = 0;
async function cartOf(productKind: "digital" | "physical"): Promise<string> {
	seq += 1;
	const productId = `prod-382-${String(seq)}`;
	const sku = `SKU-382-${String(seq)}`;
	await harness.client.upsertProductCommerce(
		productId,
		{
			sku,
			title: productKind === "digital" ? "Ebook" : "Mug",
			price: { amount: 1200, currency: "USD" },
			productKind,
			...(productKind === "physical" ? { initialOnHand: 5 } : {}),
		},
		`seed-${productId}`,
	);
	await harness.client.activateProductCommerce(
		productId,
		`publish-${productId}`,
		"2026-01-01T00:00:00.000Z",
	);
	const { cartId } = await harness.client.createCart("USD");
	const added = await harness.client.addCartLine(cartId, sku, productId, 1, `add-${productId}`);
	if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
	return cartId;
}

const ADDRESS = {
	name: "Asha Rao",
	line1: "12 Park Street",
	city: "Kolkata",
	region: "WB",
	postalCode: "700016",
	country: "IN",
};

describe("the payment account requires the buyer's address (India)", () => {
	beforeEach(() => {
		required = true;
	});

	test("a digital cart with no address is refused MISSING_SHIPPING_ADDRESS, and no intent is asked for", async () => {
		const cartId = await cartOf("digital");
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "asha@example.test" },
			`checkout:${cartId}`,
		);
		expect(placed).toEqual({ ok: false, reason: "MISSING_SHIPPING_ADDRESS" });
		expect(gateway.intentCalls).toHaveLength(0);
		// The cart is untouched — the buyer adds the address and places again.
		const cart = await harness.client.getCart(cartId);
		expect(cart.ok && cart.cart.orderId).toBeNull();
	});

	test("a physical cart in a store with NO zones, no address: refused the same way", async () => {
		const cartId = await cartOf("physical");
		expect(
			await harness.client.createOrder(
				{ cartId, paymentMethod: "stripe", buyerRef: "asha@example.test" },
				`checkout:${cartId}`,
			),
		).toEqual({ ok: false, reason: "MISSING_SHIPPING_ADDRESS" });
	});

	test("with a complete address it is placed, and the payment intent carries the name and address", async () => {
		const cartId = await cartOf("digital");
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "asha@example.test", shippingAddress: ADDRESS },
			`checkout:${cartId}`,
		);
		expect(placed.ok).toBe(true);
		expect(gateway.intentCalls).toHaveLength(1);
		expect(gateway.intentCalls[0]?.shipTo).toEqual({
			name: "Asha Rao",
			line1: "12 Park Street",
			line2: null,
			city: "Kolkata",
			region: "WB",
			postalCode: "700016",
			country: "IN",
		});
	});

	test("the order's own replay — the pay page's resume — needs no address again", async () => {
		const cartId = await cartOf("digital");
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "asha@example.test", shippingAddress: ADDRESS },
			`checkout:${cartId}`,
		);
		if (!placed.ok) throw new Error(placed.reason);
		const replay = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "asha@example.test" },
			`checkout:${cartId}`,
		);
		expect(replay.ok && replay.order.id).toBe(placed.order.id);
		const resumed = await harness.client.resumeOrderPayment(placed.order.id, { cartId });
		expect(resumed.ok).toBe(true);
	});
});

describe("an account that does not require it (US) — unchanged", () => {
	test("a digital cart with no address is placed, with no ship-to on the intent", async () => {
		const cartId = await cartOf("digital");
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "sam@example.test" },
			`checkout:${cartId}`,
		);
		expect(placed.ok).toBe(true);
		expect(gateway.intentCalls[0]?.shipTo).toBeUndefined();
		expect(resolverCalls).toBe(1);
	});

	test("a resolver that throws is 'not required' — logged, never a refused checkout", async () => {
		required = new Error("kv down");
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const cartId = await cartOf("digital");
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "sam@example.test" },
			`checkout:${cartId}`,
		);
		expect(placed.ok).toBe(true);
		expect(errors).toHaveBeenCalled();
	});
});
