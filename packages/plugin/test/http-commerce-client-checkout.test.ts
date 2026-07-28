/**
 * A1 (storefront-checkout plan §3) — the three checkout methods on
 * `HttpCommerceClient`, as a straight 1:1 mirror of `@urumi/service`'s
 * `POST /checkout/quote`, `POST /checkout/orders` and `GET /orders/:orderId`.
 *
 * The load-bearing properties, none of which are visible from the happy path:
 *  - the two POSTs are non-GET, so they MUST carry `X-Service-Token` when one
 *    is configured or every checkout 401s once the write gate is closed;
 *  - `Idempotency-Key` is forwarded VERBATIM and never invented (a fresh key
 *    per attempt would mint a second order the `CART_CHECKED_OUT` fence then
 *    rejects with no way forward);
 *  - every typed failure — including the 502 `PAYMENT_INTENT_FAILED` — comes
 *    back as a `{ ok: false, reason }` value, never a thrown error, so callers
 *    branch on the token and never on an HTTP status (adapter rule #2);
 *  - `getPublicOrder` never sends `X-Internal-Token`: that header would unlock
 *    the full admin projection (`serializeOrder`, incl. `buyerRef` and the
 *    ship-to snapshot) on a page a guest reads.
 */
import { describe, expect, test } from "vitest";
import { CommerceClientError } from "../src/product-commerce/commerce-client.js";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";

const BASE = "https://commerce.test";
const TOKEN = "SVC-TOKEN-abc123";

interface Recorded {
	url: string;
	init: RequestInit | undefined;
}

function stub(
	responses: { status: number; body: unknown }[],
	serviceToken?: string,
): { client: HttpCommerceClient; requests: Recorded[] } {
	const requests: Recorded[] = [];
	let i = 0;
	const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
		requests.push({ url, init });
		const next = responses[Math.min(i++, responses.length - 1)] ?? { status: 200, body: {} };
		return new Response(JSON.stringify(next.body), {
			status: next.status,
			headers: { "content-type": "application/json" },
		});
	};
	const client = new HttpCommerceClient({
		fetch,
		baseUrl: BASE,
		...(serviceToken !== undefined ? { serviceToken } : {}),
	});
	return { client, requests };
}

function header(init: RequestInit | undefined, name: string): string | undefined {
	const headers = (init?.headers ?? {}) as Record<string, string>;
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === name.toLowerCase()) return v;
	}
	return undefined;
}

function body(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

const BREAKDOWN = {
	currency: "USD",
	subtotalCents: 3998,
	discountCents: 0,
	shippingCents: 0,
	taxCents: 0,
	totalCents: 3998,
	appliedCouponCode: null,
};

const ORDER = {
	id: "order-1",
	state: "pending",
	currency: "USD",
	paymentMethod: "stripe",
	holdExpiresAt: "2099-01-01T00:00:00.000Z",
	createdAt: "2026-07-27T00:00:00.000Z",
	totals: { ...BREAKDOWN, shippingZoneId: null },
	lines: [],
	fulfillment: null,
	cancellation: null,
};

const INTENT = {
	gateway: "stripe",
	intentId: "pi_123",
	clientAction: { kind: "stripe_client_secret", clientSecret: "pi_123_secret_xyz" },
};

describe("HttpCommerceClient.quoteCheckout", () => {
	test("POSTs /checkout/quote with the cart id and returns the breakdown", async () => {
		const { client, requests } = stub([{ status: 200, body: { ok: true, breakdown: BREAKDOWN } }]);
		const result = await client.quoteCheckout({ cartId: "cart-1" });

		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe(`${BASE}/checkout/quote`);
		expect(requests[0]!.init?.method).toBe("POST");
		expect(body(requests[0]!.init)).toEqual({ cartId: "cart-1" });
		expect(result).toEqual({ ok: true, breakdown: BREAKDOWN });
	});

	test("forwards X-Service-Token when configured (the quote is a non-GET the write gate blocks)", async () => {
		const { client, requests } = stub(
			[{ status: 200, body: { ok: true, breakdown: BREAKDOWN } }],
			TOKEN,
		);
		await client.quoteCheckout({ cartId: "cart-1" });
		expect(header(requests[0]!.init, "X-Service-Token")).toBe(TOKEN);
	});

	test("attaches NO X-Service-Token when none is configured (byte-identical to the pre-gate wire)", async () => {
		const { client, requests } = stub([{ status: 200, body: { ok: true, breakdown: BREAKDOWN } }]);
		await client.quoteCheckout({ cartId: "cart-1" });
		expect(header(requests[0]!.init, "X-Service-Token")).toBeUndefined();
	});

	test("omits optional selection fields entirely rather than sending undefined/null", async () => {
		const { client, requests } = stub([{ status: 200, body: { ok: true, breakdown: BREAKDOWN } }]);
		await client.quoteCheckout({ cartId: "cart-1", couponCode: "SAVE10" });
		expect(body(requests[0]!.init)).toEqual({ cartId: "cart-1", couponCode: "SAVE10" });
	});

	test.each([
		[404, "CART_NOT_FOUND"],
		[409, "CART_EMPTY"],
		[409, "PRODUCT_NOT_PRICED"],
		[409, "CURRENCY_MISMATCH"],
		[404, "COUPON_NOT_FOUND"],
	])(
		"a %i quote failure surfaces as the typed reason %s, never a throw",
		async (status, reason) => {
			const { client } = stub([{ status, body: { ok: false, reason } }]);
			await expect(client.quoteCheckout({ cartId: "cart-1" })).resolves.toEqual({
				ok: false,
				reason,
			});
		},
	);
});

describe("HttpCommerceClient.createOrder", () => {
	test("POSTs /checkout/orders with the checkout body and returns order + intent", async () => {
		const { client, requests } = stub([
			{ status: 201, body: { ok: true, order: ORDER, intent: INTENT } },
		]);
		const result = await client.createOrder(
			{ cartId: "cart-1", paymentMethod: "stripe", buyerRef: "Buyer@Example.com" },
			"checkout:cart-1",
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe(`${BASE}/checkout/orders`);
		expect(requests[0]!.init?.method).toBe("POST");
		expect(body(requests[0]!.init)).toEqual({
			cartId: "cart-1",
			paymentMethod: "stripe",
			buyerRef: "Buyer@Example.com",
		});
		expect(result).toEqual({ ok: true, order: ORDER, intent: INTENT });
	});

	test("forwards the caller's Idempotency-Key VERBATIM — never invents or rewrites one", async () => {
		const { client, requests } = stub([
			{ status: 201, body: { ok: true, order: ORDER, intent: INTENT } },
		]);
		await client.createOrder(
			{ cartId: "cart-1", paymentMethod: "stripe", buyerRef: "a@b.co" },
			"checkout:cart-1",
		);
		expect(header(requests[0]!.init, "Idempotency-Key")).toBe("checkout:cart-1");
	});

	test("forwards X-Service-Token when configured", async () => {
		const { client, requests } = stub(
			[{ status: 201, body: { ok: true, order: ORDER, intent: INTENT } }],
			TOKEN,
		);
		await client.createOrder(
			{ cartId: "cart-1", paymentMethod: "stripe", buyerRef: "a@b.co" },
			"k",
		);
		expect(header(requests[0]!.init, "X-Service-Token")).toBe(TOKEN);
	});

	test("forwards the optional shipping address verbatim when present", async () => {
		const { client, requests } = stub([
			{ status: 201, body: { ok: true, order: ORDER, intent: INTENT } },
		]);
		const shippingAddress = {
			name: "A Buyer",
			line1: "1 Test St",
			city: "Testville",
			postalCode: "12345",
			country: "Testland",
		};
		await client.createOrder(
			{ cartId: "cart-1", paymentMethod: "stripe", buyerRef: "a@b.co", shippingAddress },
			"k",
		);
		expect(body(requests[0]!.init)["shippingAddress"]).toEqual(shippingAddress);
	});

	test.each([
		[400, "INVALID_SHIPPING_ADDRESS"],
		[404, "CART_NOT_FOUND"],
		[404, "COUPON_NOT_FOUND"],
		[409, "CART_EMPTY"],
		[409, "CART_CHECKED_OUT"],
		[409, "RESERVATION_LOST"],
		[409, "PRODUCT_NOT_PRICED"],
		[409, "CURRENCY_MISMATCH"],
		[502, "PAYMENT_INTENT_FAILED"],
	])(
		"a %i checkout failure surfaces as the typed reason %s, never a throw",
		async (status, reason) => {
			const { client } = stub([{ status, body: { ok: false, reason } }]);
			await expect(
				client.createOrder({ cartId: "c", paymentMethod: "stripe", buyerRef: "a@b.co" }, "k"),
			).resolves.toEqual({ ok: false, reason });
		},
	);

	test("a body with NO typed envelope (a zod parse reject, a 500) still throws CommerceClientError", async () => {
		const { client } = stub([{ status: 400, body: { error: "invalid request body", issues: [] } }]);
		await expect(
			client.createOrder({ cartId: "c", paymentMethod: "stripe", buyerRef: "a@b.co" }, "k"),
		).rejects.toBeInstanceOf(CommerceClientError);
	});
});

describe("HttpCommerceClient.getPublicOrder", () => {
	test("GETs /orders/:orderId and returns the public projection", async () => {
		const { client, requests } = stub([{ status: 200, body: { ok: true, order: ORDER } }]);
		const result = await client.getPublicOrder("order-1");

		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe(`${BASE}/orders/order-1`);
		expect(requests[0]!.init?.method).toBe("GET");
		expect(result).toEqual({ ok: true, order: ORDER });
	});

	test("NEVER sends X-Internal-Token — that header would unlock the full admin projection", async () => {
		const { client, requests } = stub([{ status: 200, body: { ok: true, order: ORDER } }], TOKEN);
		await client.getPublicOrder("order-1");
		expect(header(requests[0]!.init, "X-Internal-Token")).toBeUndefined();
	});

	test("percent-encodes the order id into the path", async () => {
		const { client, requests } = stub([{ status: 200, body: { ok: true, order: ORDER } }]);
		await client.getPublicOrder("a/b");
		expect(requests[0]!.url).toBe(`${BASE}/orders/a%2Fb`);
	});

	test("a 404 surfaces as the typed ORDER_NOT_FOUND, never a throw", async () => {
		const { client } = stub([{ status: 404, body: { ok: false, reason: "ORDER_NOT_FOUND" } }]);
		await expect(client.getPublicOrder("nope")).resolves.toEqual({
			ok: false,
			reason: "ORDER_NOT_FOUND",
		});
	});
});
