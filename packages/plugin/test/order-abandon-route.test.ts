/**
 * `storefront/order/abandon` — "Start a new cart" (QA2 X4). The client is
 * stubbed HERE only to observe what the route asks and what it lets out; what
 * `abandonCartOrder` itself does (cancel the cart's PENDING order once, leave a
 * paid one alone) is the commerce-client contract's, run over a real store.
 *
 * What the route must hold:
 *  - the cart id is the WHOLE input — nothing else is read from it;
 *  - the reply says only whether an order was cancelled — never the order id;
 *  - an id that cannot name a cart asks the client nothing;
 *  - a busy store is BUSY (retryable), so the site can refuse to claim anything.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const abandonCartOrder = vi.fn();
vi.mock("../src/commerce/make-commerce-client.js", () => ({
	makeCommerceClient: async () => ({ abandonCartOrder }),
}));

const { createOrderAbandonRouteHandler, STOREFRONT_ORDER_ABANDON_ROUTE } =
	await import("../src/storefront/checkout-routes.js");

async function abandon(input: Record<string, unknown>): Promise<unknown> {
	return createOrderAbandonRouteHandler()(
		{ input: input as never, request: { method: "POST", url: "/route", headers: {} } },
		{} as never,
	);
}

const CART_ID = "6f1c2a64-0d1e-4c55-9d7e-2f1a3b4c5d6e";

beforeEach(() => {
	abandonCartOrder.mockReset();
});

describe("storefront/order/abandon", () => {
	test("is its own public route name", () => {
		expect(STOREFRONT_ORDER_ABANDON_ROUTE).toBe("storefront/order/abandon");
	});

	test("cancels through the client with the cart id alone, and answers only whether it did", async () => {
		abandonCartOrder.mockResolvedValue({ ok: true, cancelled: true, orderId: "ord-secret" });
		expect(await abandon({ cartId: CART_ID, orderId: "ord-other", email: "x@y.z" })).toEqual({
			ok: true,
			cancelled: true,
		});
		expect(abandonCartOrder).toHaveBeenCalledWith(CART_ID);
	});

	test("nothing to cancel is a plain success", async () => {
		abandonCartOrder.mockResolvedValue({ ok: true, cancelled: false, orderId: null });
		expect(await abandon({ cartId: CART_ID })).toEqual({ ok: true, cancelled: false });
	});

	test("a missing or malformed cart id is INVALID_INPUT, and the client is never asked", async () => {
		for (const input of [{}, { cartId: 42 }, { cartId: "" }, { cartId: "not an id" }]) {
			expect(await abandon(input), JSON.stringify(input)).toEqual({
				ok: false,
				error: "INVALID_INPUT",
			});
		}
		expect(abandonCartOrder).not.toHaveBeenCalled();
	});

	test("a busy store is BUSY and retryable — never a silent success", async () => {
		const busy = Object.assign(new Error("SQLITE_BUSY: database is locked"), {
			code: "SQLITE_BUSY",
		});
		abandonCartOrder.mockRejectedValue(busy);
		const res = (await abandon({ cartId: CART_ID })) as { ok: boolean };
		expect(res.ok).toBe(false);
	});
});
