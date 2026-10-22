/**
 * `replaceStaleCurrencyCart` — the way out for a shopper whose ACTIVE cart is in
 * a currency the store no longer sells in (#440). A cart is never rewritten, so
 * the old cart keeps its currency; what changes is that the shopper is handed a
 * new, empty cart in the store currency, and every hold the old cart had is
 * released so the stock is free for them (or anyone) to add again. No money is
 * converted and no line moves: the new cart prices at the live price.
 *
 * The key is derived HERE, from the old cart and the target currency — no
 * caller supplies one — so a retry, a double submit or a racer all converge on
 * the same replacement. One call releases at most `STALE_CART_RELEASE_LIMIT`
 * holds (its cost must not grow with the cart); the hold sweep reaps the rest.
 */
import {
	addLine,
	createCart,
	currency,
	DEFAULT_HOLD_TTL_MS,
	expireHolds,
	idempotencyKey,
	isStaleCurrencyCart,
	replaceStaleCurrencyCart,
	sku,
	STALE_CART_RELEASE_LIMIT,
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
		// The old cart keeps its currency (never rewritten); its hold is released.
		const old = await h.cartStore.get(cartId);
		expect(old?.currency).toBe("USD");
		expect(old?.lines.find((line) => line.sku === "SKU-1")?.reservationState).toBe("released");
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

	/** A USD cart with one held unit of each of `n` skus. */
	async function wideCart(n: number): Promise<{ cartId: string; skus: string[] }> {
		const cartId = await createCart(h.deps, USD);
		const skus: string[] = [];
		for (let i = 0; i < n; i++) {
			const code = `SKU-W${String(i)}`;
			skus.push(code);
			await h.seedStock(code, 1);
			const added = await addLine(
				h.deps,
				cartId,
				sku(code),
				`p-w${String(i)}`,
				1,
				idempotencyKey(`w-${String(i)}`),
			);
			if (!added.ok) throw new Error(added.reason);
		}
		return { cartId, skus };
	}

	async function freed(skus: string[]): Promise<number> {
		let total = 0;
		for (const code of skus) total += await h.onHand(code);
		return total;
	}

	test("one call releases at most STALE_CART_RELEASE_LIMIT holds; the hold sweep reaps the rest after the TTL", async () => {
		const n = STALE_CART_RELEASE_LIMIT + 4;
		const { cartId, skus } = await wideCart(n);
		const replaced = await replaceStaleCurrencyCart(h.deps, cartId, EUR);
		expect(replaced.ok).toBe(true);
		expect(await freed(skus)).toBe(STALE_CART_RELEASE_LIMIT);

		// Nothing is leaked: past the hold TTL the sweep returns every other unit.
		h.advance(DEFAULT_HOLD_TTL_MS + 1);
		expect(await expireHolds(h.deps)).toBe(n - STALE_CART_RELEASE_LIMIT);
		expect(await freed(skus)).toBe(n);
	});

	test("a hold already ADOPTED by a checkout refuses LINE_CHECKED_OUT and releases nothing", async () => {
		const { cartId, skus } = await wideCart(3);
		const cart = await h.cartStore.get(cartId);
		const adoptedId = cart?.lines[1]?.reservationId;
		if (adoptedId === undefined || adoptedId === null) throw new Error("no hold");
		const adopted = await h.inventory.adopt({
			reservationId: adoptedId,
			orderId: "ord-mid-checkout",
			holdExpiresAt: "2026-07-10T01:00:00.000Z",
			now: h.clock.now().toISOString(),
		});
		expect(adopted).toMatchObject({ ok: true });
		expect(await replaceStaleCurrencyCart(h.deps, cartId, EUR)).toEqual({
			ok: false,
			reason: "LINE_CHECKED_OUT",
		});
		expect(await freed(skus)).toBe(0);
	});

	test("a crash partway: the retry gets the SAME cart and releases the rest, each exactly once", async () => {
		const { cartId, skus } = await wideCart(3);
		const release = h.inventory.release.bind(h.inventory);
		let calls = 0;
		h.inventory.release = async (id) => {
			calls += 1;
			if (calls === 2) throw new Error("worker killed mid-release");
			return release(id);
		};
		await expect(replaceStaleCurrencyCart(h.deps, cartId, EUR)).rejects.toThrow(
			"worker killed mid-release",
		);
		expect(await freed(skus)).toBe(1);

		h.inventory.release = release;
		const replayed = await replaceStaleCurrencyCart(h.deps, cartId, EUR);
		const again = await replaceStaleCurrencyCart(h.deps, cartId, EUR);
		if (!replayed.ok || !again.ok) throw new Error("refused");
		expect(again.cartId).toBe(replayed.cartId);
		expect(await freed(skus)).toBe(3);
		// The replacement was minted BEFORE the crash: the retry is handed that one.
		expect((await h.cartStore.get(replayed.cartId))?.currency).toBe("EUR");
	});
});
