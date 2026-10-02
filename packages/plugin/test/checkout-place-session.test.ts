/**
 * `storefront/checkout/place` forwards the signed-in shopper's session to
 * `createOrder` — and nothing else about identity. The client is stubbed HERE
 * only to observe the call the route makes; what the client does with the
 * session (owner from the session, never from an argument; a mismatched email or
 * an unusable session places a guest order) is the commerce-client contract's,
 * run over a real store.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const createOrder = vi.fn();
vi.mock("../src/commerce/make-commerce-client.js", () => ({
	makeCommerceClient: async () => ({ createOrder }),
}));

const { createCheckoutPlaceRouteHandler } = await import("../src/storefront/checkout-routes.js");

async function place(input: Record<string, unknown>): Promise<void> {
	await createCheckoutPlaceRouteHandler()(
		{ input: input as never, request: { method: "POST", url: "/route", headers: {} } },
		{} as never,
	);
}

const BASE = { cartId: "cart-1", buyerRef: "b@example.com", idempotencyKey: "checkout:cart-1" };

beforeEach(() => {
	createOrder.mockReset();
	createOrder.mockResolvedValue({ ok: false, reason: "CART_EMPTY" });
});

describe("storefront/checkout/place — the session", () => {
	test("a session token is handed to createOrder as the bearer it is", async () => {
		await place({ ...BASE, sessionToken: "sess-1" });
		expect(createOrder).toHaveBeenCalledTimes(1);
		expect(createOrder.mock.calls[0]?.[1]).toBe("checkout:cart-1");
		expect(createOrder.mock.calls[0]?.[2]).toEqual({ sessionToken: "sess-1" });
		// Never as a field of the order request itself.
		expect(createOrder.mock.calls[0]?.[0]).not.toHaveProperty("sessionToken");
	});

	test("no session — or an unusable one — is a guest checkout, still placed", async () => {
		await place(BASE);
		await place({ ...BASE, sessionToken: "" });
		expect(createOrder).toHaveBeenCalledTimes(2);
		for (const call of createOrder.mock.calls) expect(call[2]).toEqual({});
	});
});
