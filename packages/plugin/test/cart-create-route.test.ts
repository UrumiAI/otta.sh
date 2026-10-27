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
} from "@urumi.ai/otta-domain";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	createCartCreateRouteHandler,
	createCartLineAddRouteHandler,
	type CartCreateRouteResult,
} from "../src/storefront/cart-routes.js";
import {
	isRenderedAddToCartKey,
	renderedAddToCartKey,
} from "../src/storefront/rendered-add-key.js";
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

	// A plain create's idempotencyKey (#39) is the caller's own, in its own
	// namespace: it can never name the key the plugin derives for a replacement.
	test("a caller's key can never reach a replacement: `rotate:<spent>` is not the spent cart's replacement", async () => {
		const spent = await spentCart("namespace");
		const replaced = await create({ replacesCartId: spent });
		const named = await create({ idempotencyKey: `rotate:${spent}` });
		if (!replaced.ok || !named.ok) throw new Error("create refused");
		expect(named.cartId).not.toBe(replaced.cartId);
	});

	test("nor a stale-currency replacement: `recurrency:<id>:<cur>` is not that cart's replacement", async () => {
		await harness.stores.settingsStore.update(
			{ currency: "EUR" },
			toIdempotencyKey("ns-recurrency-eur"),
		);
		const { cartId: stale } = await harness.client.createCart("USD");
		const replaced = await create({ replacesStaleCurrencyCartId: stale });
		const named = await create({ idempotencyKey: `recurrency:${stale}:EUR` });
		if (!replaced.ok || !named.ok) throw new Error("create refused");
		expect(named.cartId).not.toBe(replaced.cartId);
	});

	test.each([[{ idempotencyKey: "press-with-replace" }], [{ idempotencyKey: 42 }]])(
		"a replacesCartId with an idempotencyKey (%p) is refused INVALID_INPUT: a replacement's key is the plugin's",
		async (extra) => {
			const spent = await spentCart(`with-key-${typeof extra.idempotencyKey}`);
			expect(await create({ replacesCartId: spent, ...extra })).toEqual({
				ok: false,
				error: "INVALID_INPUT",
			});
		},
	);

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

	test("a currency-shaped code outside the currency table (XYZ) is refused INVALID_CURRENCY, on create and on replace", async () => {
		expect(await create({ currency: "XYZ" })).toEqual({ ok: false, error: "INVALID_CURRENCY" });
		const spent = await spentCart("unsupported-currency");
		expect(await create({ replacesCartId: spent, currency: "XYZ" })).toEqual({
			ok: false,
			error: "INVALID_CURRENCY",
		});
	});
});

// Issue #39: the storefront's first add of a visit mints the cart, and a
// double-submit of that add sends two creates at once. Under the add's own
// per-submission key both land in ONE cart and both answers set the same cookie.
describe("storefront/cart/create — under the caller's idempotency key", () => {
	test("the same key answers the same cart, with the same cookie; another key mints another", async () => {
		const first = await create({ idempotencyKey: "press-route-1" });
		const again = await create({ idempotencyKey: "press-route-1" });
		const other = await create({ idempotencyKey: "press-route-2" });
		if (!first.ok || !again.ok || !other.ok) throw new Error("create refused");
		expect(again.cartId).toBe(first.cartId);
		expect(again.cookie).toEqual(first.cookie);
		expect(other.cartId).not.toBe(first.cartId);
	});

	test("racing creates under one key converge on one cart", async () => {
		const racing = await Promise.all([
			create({ idempotencyKey: "press-route-race" }),
			create({ idempotencyKey: "press-route-race" }),
			create({ idempotencyKey: "press-route-race" }),
		]);
		expect(new Set(racing.map((r) => (r.ok ? r.cartId : JSON.stringify(r)))).size).toBe(1);
	});

	// Refused, never dropped: dropped, a double-submit would mint two carts again
	// with nothing to say why.
	test.each([[""], [42], [{}], ["k".repeat(513)], ["k\u0000nul"]])(
		"an idempotencyKey of %p is refused INVALID_INPUT, minting nothing",
		async (idempotencyKey) => {
			expect(await create({ idempotencyKey })).toEqual({ ok: false, error: "INVALID_INPUT" });
		},
	);

	// A cached product page can hand every visitor the SAME rendered key; keyed on
	// it, a second visitor would be handed the first visitor's cart. So a rendered
	// key (the `pdp:` marker) is honoured as no key at all: the create still works,
	// unkeyed, exactly as it did before keys existed — never refused, so a theme
	// that forwards the slot's key keeps working.
	test("a rendered PDP key never keys a create: two creates under it mint two carts", async () => {
		const rendered = renderedAddToCartKey();
		expect(isRenderedAddToCartKey(rendered)).toBe(true);
		const visitorA = await create({ idempotencyKey: rendered });
		const visitorB = await create({ idempotencyKey: rendered });
		if (!visitorA.ok || !visitorB.ok) throw new Error("create refused");
		expect(visitorB.cartId).not.toBe(visitorA.cartId);
		expect(visitorB.cookie.value).not.toBe(visitorA.cookie.value);
	});

	test("the add-line route's key guard still accepts a rendered (marked) key", async () => {
		const { cartId } = await harness.client.createCart("USD");
		const added = await createCartLineAddRouteHandler()(
			{
				input: {
					cartId,
					sku: "SKU-NO-SUCH-PRODUCT",
					qty: 1,
					idempotencyKey: renderedAddToCartKey(),
				} as never,
				request: { method: "POST", url: "/route", headers: {} },
			},
			harness.ctx,
		);
		// Past the input guard (which would answer INVALID_INPUT) to the sku check.
		expect(added).toEqual({ ok: false, reason: "SKU_MISMATCH" });
	});

	test("a key with a currency keys a cart in that currency; the replay keeps it", async () => {
		const first = await create({ idempotencyKey: "press-route-eur", currency: "EUR" });
		const again = await create({ idempotencyKey: "press-route-eur", currency: "GBP" });
		if (!first.ok || !again.ok) throw new Error("create refused");
		expect(again.cartId).toBe(first.cartId);
		const read = await harness.client.getCart(first.cartId);
		expect(read.ok && read.cart.currency).toBe("EUR");
	});
});
