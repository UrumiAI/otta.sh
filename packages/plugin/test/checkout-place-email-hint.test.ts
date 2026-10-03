/**
 * `storefront/checkout/place` tells the site WHICH email the order was placed
 * with — masked — and whether it is the one this request typed (QA2 X2). A second
 * checkout tab replays the order the first tab placed, which keeps the first
 * email; without this the site sent the shopper on to pay an order whose
 * confirmation goes to an address they did not just type, and said nothing.
 *
 * The client is stubbed to observe the projection only; that the replay keeps the
 * order's own email is the in-process read suite's
 * (`order-reads-for-pages.in-process.test.ts`).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const createOrder = vi.fn();
vi.mock("../src/commerce/make-commerce-client.js", () => ({
	makeCommerceClient: async () => ({ createOrder }),
}));

const { createCheckoutPlaceRouteHandler } = await import("../src/storefront/checkout-routes.js");

async function place(input: Record<string, unknown>): Promise<unknown> {
	return createCheckoutPlaceRouteHandler()(
		{ input: input as never, request: { method: "POST", url: "/route", headers: {} } },
		{} as never,
	);
}

const BASE = { cartId: "cart-1", buyerRef: "b@example.com", idempotencyKey: "checkout:cart-1" };

const ORDER = {
	id: "order-1",
	state: "pending",
	currency: "USD",
	paymentMethod: "stripe",
	holdExpiresAt: "2026-10-02T12:15:00.000Z",
	createdAt: "2026-10-02T12:00:00.000Z",
	totals: {
		currency: "USD",
		subtotalCents: 1000,
		discountCents: 0,
		shippingCents: 0,
		taxCents: 0,
		totalCents: 1000,
		appliedCouponCode: null,
		shippingZoneId: null,
		shippingMethodId: null,
	},
	lines: [],
	fulfillment: null,
	cancellation: null,
	latePayment: "none",
	refundedCents: 0,
};

function placed(buyerRefMatches: boolean) {
	return {
		ok: true,
		order: ORDER,
		intent: {
			gateway: "stripe",
			intentId: "pi_1",
			clientAction: { kind: "stripe_client_secret", clientSecret: "pi_1_secret_x" },
		},
		buyerRefHint: "j•••@e•••.com",
		buyerRefMatches,
	};
}

beforeEach(() => {
	createOrder.mockReset();
});

describe("storefront/checkout/place — the order's email", () => {
	test("hands back the masked email and that it matches", async () => {
		createOrder.mockResolvedValue(placed(true));
		expect(await place(BASE)).toMatchObject({
			ok: true,
			orderId: "order-1",
			buyerRefHint: "j•••@e•••.com",
			emailMatches: true,
		});
	});

	test("a replay placed with ANOTHER email says so", async () => {
		createOrder.mockResolvedValue(placed(false));
		expect(await place(BASE)).toMatchObject({
			ok: true,
			buyerRefHint: "j•••@e•••.com",
			emailMatches: false,
		});
	});
});
