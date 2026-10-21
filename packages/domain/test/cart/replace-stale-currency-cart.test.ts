/**
 * `replaceStaleCurrencyCart` — the way out for a shopper whose ACTIVE cart is in
 * a currency the store no longer sells in (#440). A cart is never rewritten, so
 * the old cart keeps its currency; what changes is that the shopper is handed a
 * new, empty cart in the store currency, and every hold the old cart had is
 * released so the stock is free for them (or anyone) to add again. No money is
 * converted and no line moves: the new cart prices at the live price.
 *
 * The keys are derived HERE, from the old cart and the target currency — no
 * caller supplies one — so a retry, a double submit or a racer all converge on
 * the same replacement and release each hold once.
 */
import {
	addLine,
	createCart,
	currency,
	idempotencyKey,
	isStaleCurrencyCart,
	replaceStaleCurrencyCart,
	sku,
} from "@urumi.ai/otta-domain";
import { orderId } from "@urumi.ai/otta-domain";
import { beforeEach, describe, expect, test } from "vitest";
import { makeFakeCartHarness, type FakeCartHarness } from "./fake-harness.js";

const USD = currency("USD");
const EUR = currency("EUR");

let h: FakeCartHarness;

beforeEach(() => {
	h = makeFakeCartHarness();
});

/** A USD cart holding `qty` of SKU-1 (stock: `stock`) and one digital line. */
async function usdCart(qty = 2, stock = 2): Promise<string> {
	await h.seedStock("SKU-1", stock);
	const cartId = await createCart(h.deps, USD);
	const physical = await addLine(h.deps, cartId, sku("SKU-1"), "p-1", qty, idempotencyKey("a-1"));
	const digital = await addLine(
		h.deps,
		cartId,
		sku("SKU-D"),
		"p-d",
		1,
		idempotencyKey("a-d"),
		"digital",
	);
	if (!physical.ok || !digital.ok) throw new Error("seed add refused");
	return cartId;
}

describe("isStaleCurrencyCart", () => {
	test("an active cart in another currency than the store's is stale; anything else is not", () => {
		expect(isStaleCurrencyCart({ state: "active", currency: USD }, EUR)).toBe(true);
		expect(isStaleCurrencyCart({ state: "active", currency: EUR }, EUR)).toBe(false);
		// A checked-out cart is an order's record, not a cart to start over from.
		expect(isStaleCurrencyCart({ state: "checked_out", currency: USD }, EUR)).toBe(false);
	});
});

describe("replaceStaleCurrencyCart", () => {
	test("a stale cart: one empty replacement in the store currency, and every hold released", async () => {
		const cartId = await usdCart(2, 2);
		expect(await h.onHand("SKU-1")).toBe(0);

		const replaced = await replaceStaleCurrencyCart(h.deps, cartId, EUR);
		if (!replaced.ok) throw new Error(replaced.reason);
		expect(replaced.cartId).not.toBe(cartId);
		expect(await h.cartStore.get(replaced.cartId)).toMatchObject({
			state: "active",
			currency: "EUR",
			lines: [],
		});
		expect(await h.onHand("SKU-1")).toBe(2);
		// The old cart keeps its currency (never rewritten) and holds nothing.
		expect(await h.cartStore.get(cartId)).toMatchObject({ currency: "USD", lines: [] });
	});

	test("asked again — or concurrently — it converges on ONE replacement and releases each hold once", async () => {
		const cartId = await usdCart(1, 3);
		expect(await h.onHand("SKU-1")).toBe(2);
		const racing = await Promise.all([
			replaceStaleCurrencyCart(h.deps, cartId, EUR),
			replaceStaleCurrencyCart(h.deps, cartId, EUR),
		]);
		const ids = racing.map((r) => (r.ok ? r.cartId : r.reason));
		expect(new Set(ids).size).toBe(1);
		const later = await replaceStaleCurrencyCart(h.deps, cartId, EUR);
		expect(later.ok && later.cartId).toBe(ids[0]);
		expect(await h.onHand("SKU-1")).toBe(3);
	});

	test("a second switch (to another currency) gets its own replacement", async () => {
		const cartId = await usdCart();
		const toEur = await replaceStaleCurrencyCart(h.deps, cartId, EUR);
		const toGbp = await replaceStaleCurrencyCart(h.deps, cartId, currency("GBP"));
		if (!toEur.ok || !toGbp.ok) throw new Error("refused");
		expect(toGbp.cartId).not.toBe(toEur.cartId);
		expect((await h.cartStore.get(toGbp.cartId))?.currency).toBe("GBP");
	});

	test("a cart already in the store currency is CART_CURRENCY_CURRENT and is left untouched", async () => {
		const cartId = await usdCart();
		expect(await replaceStaleCurrencyCart(h.deps, cartId, USD)).toEqual({
			ok: false,
			reason: "CART_CURRENCY_CURRENT",
		});
		expect((await h.cartStore.get(cartId))?.lines).toHaveLength(2);
		expect(await h.onHand("SKU-1")).toBe(0);
	});

	test("an unknown cart is CART_NOT_FOUND; a checked-out one CART_CHECKED_OUT (its order owns the holds)", async () => {
		expect(await replaceStaleCurrencyCart(h.deps, "cart-never-minted", EUR)).toEqual({
			ok: false,
			reason: "CART_NOT_FOUND",
		});
		const cartId = await usdCart();
		await h.cartStore.checkout(cartId, orderId("ord-1"));
		expect(await replaceStaleCurrencyCart(h.deps, cartId, EUR)).toEqual({
			ok: false,
			reason: "CART_CHECKED_OUT",
		});
	});
});
