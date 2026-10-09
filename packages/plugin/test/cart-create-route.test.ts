/**
 * `storefront/cart/create` with `replacesCartId`: the storefront asks for the
 * replacement of a SPENT cart and names only that cart. The plugin checks it
 * exists, is checked out and its order is finished, and derives the key itself —
 * a caller can never choose one. The same spent cart always gets the same
 * replacement (and cookie), so racing requests converge.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
} from "@otta-sh/domain";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	createCartCreateRouteHandler,
	type CartCreateRouteResult,
} from "../src/storefront/cart-routes.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

async function create(input: unknown): Promise<CartCreateRouteResult> {
	return (await createCartCreateRouteHandler()(
		{ input: input as never, request: { method: "POST", url: "/route", headers: {} } },
		harness.ctx,
	)) as CartCreateRouteResult;
}

/** A cart checked out into an order left in `state` — arranged through the
 *  stores' own writes (the order, its flip, the cart's checkout stamp). */
async function spentCart(tag: string, state: "paid" | "pending" = "paid"): Promise<string> {
	const { cartId } = await harness.client.createCart("USD");
	const id = toOrderId(`ord-spent-${tag}`);
	await harness.stores.orderStore.createFromCart({
		orderId: id,
		cartId,
		currency: toCurrency("USD"),
		idempotencyKey: toIdempotencyKey(`spent-${tag}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "spent@example.test",
		paymentMethod: "stripe",
		lines: [],
		totals: { subtotal: cents(0), total: cents(0), currency: toCurrency("USD") },
	});
	if (state === "paid") await harness.stores.orderStore.markPaid(id);
	await harness.stores.cartStore.checkout(cartId, id);
	return cartId;
}

describe("storefront/cart/create — replacing a spent cart", () => {
	test("the same spent cart gets the same replacement, with the same cookie", async () => {
		const spent = await spentCart("paid");
		const first = await create({ replacesCartId: spent });
		const again = await create({ replacesCartId: spent });
		expect(first.ok && again.ok).toBe(true);
		if (!first.ok || !again.ok) return;
		expect(first.cartId).not.toBe(spent);
		expect(again.cartId).toBe(first.cartId);
		expect(again.cookie.value).toBe(first.cookie.value);
		const unrelated = await create({});
		expect(unrelated.ok && unrelated.cartId).not.toBe(first.cartId);
	});

	test.each([[""], [42], [{}], ["x".repeat(201)]])(
		"a replacesCartId of %p is refused INVALID_INPUT, minting nothing",
		async (replacesCartId) => {
			expect(await create({ replacesCartId })).toEqual({ ok: false, error: "INVALID_INPUT" });
		},
	);

	test("an unknown cart is refused CART_NOT_FOUND", async () => {
		expect(await create({ replacesCartId: "cart-never-minted" })).toEqual({
			ok: false,
			reason: "CART_NOT_FOUND",
		});
	});

	test("an ACTIVE cart is refused CART_NOT_CHECKED_OUT — it needs no replacing", async () => {
		const { cartId } = await harness.client.createCart("USD");
		expect(await create({ replacesCartId: cartId })).toEqual({
			ok: false,
			reason: "CART_NOT_CHECKED_OUT",
		});
	});

	// The site's own rule, enforced where it cannot be skipped: a PENDING order's
	// payment may still happen, and its cart is how the shopper resumes it.
	test("a cart whose order is still PENDING is refused ORDER_NOT_FINISHED", async () => {
		const spent = await spentCart("pending", "pending");
		expect(await create({ replacesCartId: spent })).toEqual({
			ok: false,
			reason: "ORDER_NOT_FINISHED",
		});
	});

	test("a caller-chosen key is not an input: it is ignored, never honoured", async () => {
		const first = await create({ idempotencyKey: "rotate:anything" });
		const again = await create({ idempotencyKey: "rotate:anything" });
		expect(first.ok && again.ok && first.cartId !== again.cartId).toBe(true);
	});

	test("a currency named alongside replacesCartId is the replacement's currency (a theme's explicit currency wins)", async () => {
		const spent = await spentCart("named-currency");
		const result = await create({ replacesCartId: spent, currency: "GBP" });
		if (!result.ok || !("cartId" in result)) throw new Error("replace refused");
		const read = await harness.client.getCart(result.cartId);
		expect(read.ok && read.cart.currency).toBe("GBP");
	});

	test("a malformed currency alongside replacesCartId is refused before anything is replaced", async () => {
		const spent = await spentCart("bad-currency");
		expect(await create({ replacesCartId: spent, currency: "gbp" })).toEqual({
			ok: false,
			error: "INVALID_CURRENCY",
		});
	});
});
