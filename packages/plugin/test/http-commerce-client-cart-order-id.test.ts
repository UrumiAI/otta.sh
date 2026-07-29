import { describe, expect, test } from "vitest";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";

// Issue #132 — the ONE place the `cart.orderId` guarantee is pinned.
//
// Nothing on this path validates the cart body at runtime: `#cartResult`
// blind-casts as soon as `isCartEnvelope` has seen an object with an `ok` key.
// A field the service stops emitting therefore arrives as `undefined`, fully
// type-checked, and `undefined !== null` is TRUE — so an un-normalized consumer
// renders `/orders/undefined`, a dead link offered as a primary action. `""` is
// the same failure with a different URL (`/orders/`).
//
// `getCart` coerces all three shapes to `null`. Stub fetch (no service, no PG)
// so the guarantee is provable without a live server.

const BASE = "https://commerce.test";

/** A stub service whose `GET /carts/:id` returns exactly `body`. */
function clientReturningBody(body: Record<string, unknown>): HttpCommerceClient {
	const fetch = async (): Promise<Response> =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	return new HttpCommerceClient({ fetch, baseUrl: BASE });
}

/** A stub service whose `GET /carts/:id` returns exactly `cart`. */
function clientReturning(cart: Record<string, unknown>): HttpCommerceClient {
	return clientReturningBody({ ok: true, cart });
}

const BODY = { cartId: "c1", state: "active", currency: "USD", lines: [] };

describe("HttpCommerceClient.getCart normalizes cart.orderId (#132)", () => {
	test("an OMITTED orderId (an older deployed service) reads as null, never undefined", async () => {
		const result = await clientReturning(BODY).getCart("c1");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.cart.orderId).toBeNull();
		// Not merely falsy: the strict identity is the whole point, because
		// `undefined !== null` would sail through a consumer's `!== null` fence.
		expect(Object.is(result.cart.orderId, null)).toBe(true);
	});

	test("an EMPTY-STRING orderId reads as null (it would render `/orders/`)", async () => {
		const result = await clientReturning({ ...BODY, orderId: "" }).getCart("c1");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.cart.orderId).toBeNull();
	});

	test("a NON-STRING orderId reads as null", async () => {
		const result = await clientReturning({ ...BODY, orderId: 42 }).getCart("c1");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.cart.orderId).toBeNull();
	});

	// The coercion is TOTAL, `cart` included. `isCartEnvelope` never checked for
	// a `cart` key, so a success envelope without a usable one must keep behaving
	// exactly as it did before this PR — passed through — rather than becoming a
	// new TypeError thrown from inside the client.
	test.each([
		["no cart key at all", { ok: true }],
		["a null cart", { ok: true, cart: null }],
		["a non-object cart", { ok: true, cart: "nope" }],
	])("a success envelope with %s is passed through, never a thrown TypeError", async (_l, body) => {
		const result = await clientReturningBody(body as Record<string, unknown>).getCart("c1");
		expect(result.ok).toBe(true);
	});

	test("a real order id is passed through untouched", async () => {
		const result = await clientReturning({
			...BODY,
			state: "checked_out",
			orderId: "order-abc",
		}).getCart("c1");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.cart.orderId).toBe("order-abc");
		expect(result.cart.state).toBe("checked_out");
	});
});
