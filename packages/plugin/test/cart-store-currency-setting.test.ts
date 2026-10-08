/**
 * The store currency setting decides the currency of a NEW cart created without
 * one — the storefront's own `ensureCartId` names none, so this is the currency
 * every shopper's cart is in.
 *
 * Pinned here: a store that never saved the setting creates USD carts, exactly
 * as before it existed; a saved one is used from the next cart on; an explicit
 * currency still wins (and is still shape-checked); and an existing cart keeps
 * the currency it was created in, whatever the setting says later.
 *
 * Every case goes through the CLIENT over a real document store, with the
 * setting written through the real settings store the admin form saves to.
 */
import { idempotencyKey } from "@otta-sh/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

describe("a new cart's currency follows the store currency setting", () => {
	let h: InProcessCommerceHarness;
	let seq = 0;

	beforeAll(async () => {
		h = await makeInProcessCommerce();
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(async () => {
		await h.reset();
	});

	async function setStoreCurrency(code: string): Promise<void> {
		seq += 1;
		await h.stores.settingsStore.update(
			{ currency: code },
			idempotencyKey(`currency-${String(seq)}`),
		);
	}

	async function cartCurrency(cartId: string): Promise<string> {
		const read = await h.client.getCart(cartId);
		if (!read.ok) throw new Error(read.reason);
		return read.cart.currency;
	}

	test("with nothing saved, a cart created without a currency is USD (today's behaviour)", async () => {
		const { cartId } = await h.client.createCart();
		expect(await cartCurrency(cartId)).toBe("USD");
		expect((await h.stores.settingsStore.get()).currency).toBeUndefined();
	});

	test("an unrelated settings save does not change the default", async () => {
		await h.stores.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("ttl"));
		const { cartId } = await h.client.createCart();
		expect(await cartCurrency(cartId)).toBe("USD");
	});

	test("with a saved store currency, a cart created without one is in it", async () => {
		await setStoreCurrency("EUR");
		const { cartId } = await h.client.createCart();
		expect(await cartCurrency(cartId)).toBe("EUR");
	});

	test("an explicit currency still wins over the store currency", async () => {
		await setStoreCurrency("EUR");
		const { cartId } = await h.client.createCart("GBP");
		expect(await cartCurrency(cartId)).toBe("GBP");
	});

	test("an explicit malformed currency is still refused", async () => {
		await setStoreCurrency("EUR");
		await expect(h.client.createCart("eur")).rejects.toThrow();
	});

	test("an existing cart keeps its currency after the store currency changes", async () => {
		const before = await h.client.createCart();
		await setStoreCurrency("JPY");
		const after = await h.client.createCart();
		expect(await cartCurrency(before.cartId)).toBe("USD");
		expect(await cartCurrency(after.cartId)).toBe("JPY");
	});

	test("a product priced in the store currency can be added to a default cart", async () => {
		await setStoreCurrency("EUR");
		await h.client.upsertProductCommerce(
			"prod-eur",
			{ sku: "SKU-EUR", price: { amount: 1500, currency: "EUR" }, title: "Euro", initialOnHand: 3 },
			"seed-eur",
		);
		await h.client.activateProductCommerce(
			"prod-eur",
			"seed-eur-publish",
			"2026-01-01T00:00:00.000Z",
		);
		const { cartId } = await h.client.createCart();
		const added = await h.client.addCartLine(cartId, "SKU-EUR", "prod-eur", 1, "add-eur");
		expect(added.ok).toBe(true);
	});
});
