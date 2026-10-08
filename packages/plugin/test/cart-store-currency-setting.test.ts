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
import {
	cents,
	currency as toCurrency,
	idempotencyKey,
	orderId as toOrderId,
} from "@otta-sh/domain";
import { SETTINGS_COLLECTION } from "@otta-sh/store-emdash";
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

	/** A cart in `currency`, checked out into a PAID order — a spent cart. */
	async function spentCart(tag: string, currency: string): Promise<string> {
		const { cartId } = await h.client.createCart(currency);
		const id = toOrderId(`ord-sc-${tag}`);
		await h.stores.orderStore.createFromCart({
			orderId: id,
			cartId,
			currency: toCurrency(currency),
			idempotencyKey: idempotencyKey(`sc-spent-${tag}`),
			holdExpiresAt: "2099-01-01T00:00:00.000Z",
			buyerRef: "spent@example.test",
			paymentMethod: "stripe",
			lines: [],
			totals: { subtotal: cents(0), total: cents(0), currency: toCurrency(currency) },
		});
		await h.stores.orderStore.markPaid(id);
		await h.stores.cartStore.checkout(cartId, id);
		return cartId;
	}

	test("never saved: a spent cart's replacement keeps the spent cart's currency (today's behaviour)", async () => {
		for (const currency of ["USD", "GBP"]) {
			const spent = await spentCart(`never-${currency}`, currency);
			const replaced = await h.client.replaceCart(spent);
			if (!replaced.ok) throw new Error(replaced.reason);
			expect(await cartCurrency(replaced.cartId)).toBe(currency);
		}
	});

	test("saved EUR: a spent USD cart's replacement is in EUR, and racers still converge", async () => {
		const spent = await spentCart("saved-eur", "USD");
		await setStoreCurrency("EUR");
		const first = await h.client.replaceCart(spent);
		const again = await h.client.replaceCart(spent);
		if (!first.ok || !again.ok) throw new Error("replace refused");
		expect(again.cartId).toBe(first.cartId);
		expect(await cartCurrency(first.cartId)).toBe("EUR");
	});

	test("replacement precedence: an explicit currency beats the saved store currency, which beats the spent cart's", async () => {
		const spentForExplicit = await spentCart("prec-explicit", "USD");
		const spentForSaved = await spentCart("prec-saved", "USD");
		await setStoreCurrency("EUR");
		const explicit = await h.client.replaceCart(spentForExplicit, "GBP");
		const saved = await h.client.replaceCart(spentForSaved);
		if (!explicit.ok || !saved.ok) throw new Error("replace refused");
		expect(await cartCurrency(explicit.cartId)).toBe("GBP");
		expect(await cartCurrency(saved.cartId)).toBe("EUR");
	});

	test("an explicit malformed replacement currency is refused", async () => {
		const spent = await spentCart("prec-bad", "USD");
		await expect(h.client.replaceCart(spent, "gbp")).rejects.toThrow();
	});

	test("with the settings unreadable, refusals stay typed and an explicit currency still replaces", async () => {
		const spent = await spentCart("outage", "USD");
		const { cartId: active } = await h.client.createCart("USD");
		// The stores bind the collection object at construction, so the fault goes ON
		// that object (its read methods), and is taken off again in `finally`.
		const collection = (h.ctx.storage as unknown as Record<string, Record<string, unknown>>)[
			SETTINGS_COLLECTION
		];
		if (collection === undefined) throw new Error("no settings collection to fault-inject");
		const realGet = collection["get"];
		const realGetVersioned = collection["getVersioned"];
		const fault = (): never => {
			throw new Error("injected storage fault: settings unreadable");
		};
		collection["get"] = fault;
		collection["getVersioned"] = fault;
		try {
			expect(await h.client.replaceCart("no-such-cart")).toEqual({
				ok: false,
				reason: "CART_NOT_FOUND",
			});
			expect(await h.client.replaceCart(active)).toEqual({
				ok: false,
				reason: "CART_NOT_CHECKED_OUT",
			});
			// A valid spent cart with no named currency needs the read, and fails loudly.
			await expect(h.client.replaceCart(spent)).rejects.toThrow(/settings unreadable/);
			// Naming one costs no read.
			const named = await h.client.replaceCart(spent, "GBP");
			if (!named.ok) throw new Error(named.reason);
			expect(named.ok).toBe(true);
		} finally {
			collection["get"] = realGet;
			collection["getVersioned"] = realGetVersioned;
		}
	});
});
