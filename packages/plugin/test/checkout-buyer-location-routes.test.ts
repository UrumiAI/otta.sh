/**
 * Issue #426 at the public checkout routes. The client is stubbed HERE only to
 * observe what the routes send and pass on; what the client does with it is
 * pinned over a real store in `buyer-location-tax.test.ts`.
 *  - place: a `billingLocation` (country + optional region, code-shaped) is
 *    forwarded to `createOrder`; malformed is INVALID_INPUT; absent stays absent.
 *  - summary: `taxByBuyerLocation` says whether the page should ask where the
 *    buyer is — from the quote's reply, false on anything else.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const createOrder = vi.fn();
const getCart = vi.fn();
const quoteCheckout = vi.fn();
vi.mock("../src/commerce/make-commerce-client.js", () => ({
	makeCommerceClient: async () => ({
		createOrder,
		getCart,
		quoteCheckout,
		listShippingOptions: async () => [],
	}),
}));
vi.mock("../src/payments/stripe-account-country.js", () => ({
	checkoutRequiresBuyerAddress: async () => false,
}));
vi.mock("../src/storefront/pdp-route.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createCommerceLoader: async () => ({ loadMany: async () => new Map() }),
}));

const { createCheckoutPlaceRouteHandler, createCheckoutSummaryRouteHandler } =
	await import("../src/storefront/checkout-routes.js");

const REQUEST = { method: "POST", url: "/route", headers: {} };

async function place(input: Record<string, unknown>): Promise<unknown> {
	return createCheckoutPlaceRouteHandler()(
		{ input: input as never, request: REQUEST },
		{} as never,
	);
}

async function summary(input: Record<string, unknown>): Promise<Record<string, unknown>> {
	return (await createCheckoutSummaryRouteHandler()(
		{ input: input as never, request: REQUEST },
		{} as never,
	)) as Record<string, unknown>;
}

const BASE = { cartId: "cart-1", buyerRef: "b@example.com", idempotencyKey: "checkout:cart-1" };

const QUOTE = {
	ok: true,
	requiresShipping: false,
	destination: { status: "not_required", zoneId: null, matchedRegion: null },
	discountedSubtotalCents: 5000,
	breakdown: {
		currency: "USD",
		subtotalCents: 5000,
		discountCents: 0,
		shippingCents: 0,
		taxCents: 950,
		totalCents: 5950,
		appliedCouponCode: null,
	},
};

beforeEach(() => {
	createOrder.mockReset();
	createOrder.mockResolvedValue({ ok: false, reason: "CART_EMPTY" });
	getCart.mockReset();
	getCart.mockResolvedValue({
		ok: true,
		cart: {
			cartId: "cart-1",
			currency: "USD",
			orderId: null,
			lines: [{ sku: "EBOOK", productId: "ebook", qty: 1 }],
		},
	});
	quoteCheckout.mockReset();
});

describe("storefront/checkout/place — the buyer's location", () => {
	test("forwarded to createOrder, codes uppercased", async () => {
		await place({ ...BASE, billingLocation: { country: "de", region: " by " } });
		expect(createOrder.mock.calls[0]?.[0]).toMatchObject({
			billingLocation: { country: "DE", region: "BY" },
		});
		await place({ ...BASE, billingLocation: { country: "DE" } });
		expect(createOrder.mock.calls[1]?.[0].billingLocation).toEqual({ country: "DE" });
	});

	test("absent ⇒ not sent at all", async () => {
		await place(BASE);
		expect(createOrder.mock.calls[0]?.[0]).not.toHaveProperty("billingLocation");
	});

	test.each<[string, unknown]>([
		["a country name", { country: "Germany" }],
		["no country", { region: "BY" }],
		["a region that is not a code", { country: "DE", region: "Bavaria!" }],
		["a string", "DE"],
	])("malformed (%s) ⇒ INVALID_INPUT, nothing placed", async (_name, billingLocation) => {
		expect(await place({ ...BASE, billingLocation })).toEqual({
			ok: false,
			error: "INVALID_INPUT",
		});
		expect(createOrder).not.toHaveBeenCalled();
	});
});

describe("storefront/checkout/summary — taxByBuyerLocation", () => {
	test("the quote asks for the buyer's location ⇒ true, priced for the location sent", async () => {
		quoteCheckout.mockResolvedValue({ ...QUOTE, taxByBuyerLocation: true });
		const view = await summary({ cartId: "cart-1", destination: { country: "DE" } });
		expect(view).toMatchObject({
			ok: true,
			taxByBuyerLocation: true,
			selection: { destination: { country: "DE", region: null } },
		});
		expect(quoteCheckout.mock.calls[0]?.[0]).toMatchObject({ destination: { country: "DE" } });
	});

	test("the quote does not ⇒ false", async () => {
		quoteCheckout.mockResolvedValue(QUOTE);
		expect(await summary({ cartId: "cart-1" })).toMatchObject({
			ok: true,
			taxByBuyerLocation: false,
		});
	});

	test("a refused location is dropped and reported, the cart re-quoted without it", async () => {
		quoteCheckout
			.mockResolvedValueOnce({ ok: false, reason: "SHIPPING_REGION_CODE_REQUIRED" })
			.mockResolvedValueOnce({ ...QUOTE, taxByBuyerLocation: true });
		const view = await summary({ cartId: "cart-1", destination: { country: "US", region: "XX" } });
		expect(view).toMatchObject({
			ok: true,
			taxByBuyerLocation: true,
			selection: { destination: null },
			selectionErrors: { destination: { reason: "SHIPPING_REGION_CODE_REQUIRED" } },
		});
	});
});
