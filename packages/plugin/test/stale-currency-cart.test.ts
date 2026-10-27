/**
 * Issue #440: a cart opened BEFORE the operator switched the store currency
 * keeps its old currency (a cart is never rewritten), so once the catalogue is
 * priced in the new one the shopper is stuck: what they add is quoted
 * CURRENCY_MISMATCH, removing every line leaves the same old-currency cart, and
 * the spent-cart replacement refuses an active cart.
 *
 * The way out pinned here: the storefront can ask for the stale cart's
 * REPLACEMENT in the store currency. The plugin checks the cart is active and
 * really is in another currency than the one the operator saved, releases every
 * hold the old cart has, and mints the new cart under a key it derives itself —
 * so the same stale cart always gets the same replacement and racers converge.
 * No money is converted and no line is carried over: the shopper adds again, at
 * the live price, in the new currency.
 *
 * Every case goes through the CLIENT over a real document store.
 */
import { idempotencyKey } from "@urumi.ai/otta-domain";
import { SETTINGS_COLLECTION, type StorageAccess } from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { InProcessCommerceClient } from "../src/commerce/in-process-commerce-client.js";
import {
	createCartCreateRouteHandler,
	createCartReadRouteHandler,
	type CartCreateRouteResult,
	type CartReadRouteResult,
} from "../src/storefront/cart-routes.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

describe("a cart left in the old currency after a store currency switch (#440)", () => {
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
			idempotencyKey(`stale-currency-${String(seq)}`),
		);
	}

	async function seedProduct(
		id: string,
		sku: string,
		currency: string,
		onHand: number,
	): Promise<void> {
		await h.client.upsertProductCommerce(
			id,
			{ sku, price: { amount: 1500, currency }, title: id, initialOnHand: onHand },
			`seed-${id}`,
		);
		await h.client.activateProductCommerce(id, `seed-${id}-publish`, "2026-01-01T00:00:00.000Z");
	}

	/** A USD cart holding one unit of a USD product, then the store moves to EUR
	 *  and that product is re-priced in EUR. */
	async function staleCart(): Promise<string> {
		await seedProduct("prod-a", "SKU-A", "USD", 1);
		const { cartId } = await h.client.createCart();
		const added = await h.client.addCartLine(cartId, "SKU-A", "prod-a", 1, "add-a");
		if (!added.ok) throw new Error(added.reason);
		await setStoreCurrency("EUR");
		await h.client.upsertProductCommerce(
			"prod-a",
			{ sku: "SKU-A", price: { amount: 1400, currency: "EUR" }, title: "prod-a" },
			"reprice-a",
		);
		return cartId;
	}

	test("the bug: the old cart cannot be checked out, and emptying it does not help", async () => {
		const cartId = await staleCart();
		expect(await h.client.quoteCheckout({ cartId })).toMatchObject({
			ok: false,
			reason: "CURRENCY_MISMATCH",
		});
		// The spent-cart way out is closed to an ACTIVE cart.
		expect(await h.client.replaceCart(cartId)).toEqual({
			ok: false,
			reason: "CART_NOT_CHECKED_OUT",
		});
	});

	test("the stale cart's replacement is in the store currency, empty, and releases the old holds", async () => {
		const cartId = await staleCart();
		// The one unit is held by the old cart: nobody else can have it.
		const { cartId: other } = await h.client.createCart();
		expect(await h.client.addCartLine(other, "SKU-A", "prod-a", 1, "add-a-other")).toEqual({
			ok: false,
			reason: "OUT_OF_STOCK",
		});

		const replaced = await h.client.replaceStaleCurrencyCart(cartId);
		if (!replaced.ok) throw new Error(replaced.reason);
		expect(replaced.cartId).not.toBe(cartId);

		const fresh = await h.client.getCart(replaced.cartId);
		expect(fresh).toMatchObject({
			ok: true,
			cart: { state: "active", currency: "EUR", lines: [] },
		});
		// The old cart keeps its currency (never rewritten); its hold is released.
		const old = await h.client.getCart(cartId);
		expect(old).toMatchObject({ ok: true, cart: { currency: "USD" } });

		// The old cart's hold is back on the shelf: the one unit can be added again,
		// and it is quoted at its live EUR price — nothing converted.
		const added = await h.client.addCartLine(replaced.cartId, "SKU-A", "prod-a", 1, "add-a-eur");
		expect(added.ok).toBe(true);
		const quoted = await h.client.quoteCheckout({ cartId: replaced.cartId });
		expect(quoted).toMatchObject({
			ok: true,
			breakdown: { currency: "EUR", subtotalCents: 1400 },
		});
	});

	test("the same stale cart always gets the same replacement, and racers converge", async () => {
		const cartId = await staleCart();
		const racing = await Promise.all([
			h.client.replaceStaleCurrencyCart(cartId),
			h.client.replaceStaleCurrencyCart(cartId),
		]);
		const ids = racing.map((r) => (r.ok ? r.cartId : r.reason));
		expect(new Set(ids).size).toBe(1);
		const later = await h.client.replaceStaleCurrencyCart(cartId);
		expect(later.ok && later.cartId).toBe(ids[0]);
		// The hold was released once, not twice: one unit, one add.
		const added = await h.client.addCartLine(ids[0] as string, "SKU-A", "prod-a", 1, "add-race");
		expect(added.ok).toBe(true);
		const { cartId: other } = await h.client.createCart();
		expect(await h.client.addCartLine(other, "SKU-A", "prod-a", 1, "add-race-other")).toEqual({
			ok: false,
			reason: "OUT_OF_STOCK",
		});
	});

	test("a cart already in the store currency is refused CART_CURRENCY_CURRENT and keeps its lines", async () => {
		await setStoreCurrency("EUR");
		await seedProduct("prod-e", "SKU-E", "EUR", 2);
		const { cartId } = await h.client.createCart();
		const added = await h.client.addCartLine(cartId, "SKU-E", "prod-e", 1, "add-e");
		if (!added.ok) throw new Error(added.reason);
		expect(await h.client.replaceStaleCurrencyCart(cartId)).toEqual({
			ok: false,
			reason: "CART_CURRENCY_CURRENT",
		});
		const read = await h.client.getCart(cartId);
		expect(read.ok && read.cart.lines).toHaveLength(1);
	});

	test("a store that never saved a currency has nothing to follow: CART_CURRENCY_CURRENT, even for a GBP cart", async () => {
		const { cartId } = await h.client.createCart("GBP");
		expect(await h.client.replaceStaleCurrencyCart(cartId)).toEqual({
			ok: false,
			reason: "CART_CURRENCY_CURRENT",
		});
	});

	test("an unknown cart is CART_NOT_FOUND; a malformed id throws like every cart read", async () => {
		await setStoreCurrency("EUR");
		expect(await h.client.replaceStaleCurrencyCart("cart-never-minted")).toEqual({
			ok: false,
			reason: "CART_NOT_FOUND",
		});
		await expect(h.client.replaceStaleCurrencyCart("")).rejects.toThrow();
	});

	test("the saved store currency is readable for the storefront's notice", async () => {
		expect((await h.client.getStorefrontSettings()).savedStoreCurrency).toBeNull();
		await setStoreCurrency("EUR");
		expect((await h.client.getStorefrontSettings()).savedStoreCurrency).toBe("EUR");
	});

	// ── the storefront routes the cart page and its "Start a new cart" use ──

	const request = { method: "POST", url: "/route", headers: {} };

	async function readRoute(cartId: string): Promise<CartReadRouteResult> {
		return (await createCartReadRouteHandler()(
			{ input: { cartId } as never, request },
			h.ctx,
		)) as CartReadRouteResult;
	}

	async function createRoute(input: unknown): Promise<CartCreateRouteResult> {
		return (await createCartCreateRouteHandler()(
			{ input: input as never, request },
			h.ctx,
		)) as CartCreateRouteResult;
	}

	test("cart/read names a stale cart's currency and the store's; a current cart carries null", async () => {
		const cartId = await staleCart();
		expect(await readRoute(cartId)).toMatchObject({
			ok: true,
			staleCurrency: { cartCurrency: "USD", storeCurrency: "EUR" },
		});
		const { cartId: current } = await h.client.createCart();
		expect(await readRoute(current)).toMatchObject({ ok: true, staleCurrency: null });
	});

	test("cart/read: a store that never saved a currency has no stale carts", async () => {
		const { cartId } = await h.client.createCart("GBP");
		expect(await readRoute(cartId)).toMatchObject({ ok: true, staleCurrency: null });
	});

	test("cart/create with replacesStaleCurrencyCartId answers the replacement and its cookie, the same each time", async () => {
		const cartId = await staleCart();
		const first = await createRoute({ replacesStaleCurrencyCartId: cartId });
		const again = await createRoute({ replacesStaleCurrencyCartId: cartId });
		if (!first.ok || !again.ok) throw new Error("replace refused");
		expect(first.cartId).not.toBe(cartId);
		expect(again.cartId).toBe(first.cartId);
		expect(first.cookie.value).toBe(first.cartId);
		expect(await readRoute(first.cartId)).toMatchObject({
			ok: true,
			cart: { currency: "EUR", lines: [] },
			staleCurrency: null,
		});
	});

	test("cart/create refuses a current cart CART_CURRENCY_CURRENT", async () => {
		await setStoreCurrency("EUR");
		const { cartId } = await h.client.createCart();
		expect(await createRoute({ replacesStaleCurrencyCartId: cartId })).toEqual({
			ok: false,
			reason: "CART_CURRENCY_CURRENT",
		});
	});

	test.each([
		[{ replacesStaleCurrencyCartId: "" }],
		[{ replacesStaleCurrencyCartId: 42 }],
		[{ replacesStaleCurrencyCartId: "x".repeat(201) }],
		[{ replacesStaleCurrencyCartId: "cart-1", currency: "EUR" }],
		[{ replacesStaleCurrencyCartId: "cart-1", replacesCartId: "cart-2" }],
		// #39: a replacement's key is the plugin's, never the caller's.
		[{ replacesStaleCurrencyCartId: "cart-1", idempotencyKey: "press-stale" }],
	])("cart/create refuses %p INVALID_INPUT, minting nothing", async (input) => {
		await setStoreCurrency("EUR");
		expect(await createRoute(input)).toEqual({ ok: false, error: "INVALID_INPUT" });
	});

	test("cart/read still answers when the store-currency read rejects: staleCurrency is null", async () => {
		await setStoreCurrency("EUR");
		const { cartId } = await h.client.createCart("USD");
		expect(await readRoute(cartId)).toMatchObject({
			ok: true,
			staleCurrency: { cartCurrency: "USD", storeCurrency: "EUR" },
		});
		// The cart read itself reads settings once (the hold TTL); every settings
		// read after that one rejects — so only the storefront-settings read fails.
		let settingsReads = 0;
		const failing = withCollection(h.ctx.storage as StorageAccess, SETTINGS_COLLECTION, () => {
			settingsReads += 1;
			if (settingsReads > 1) throw new Error("settings unreadable");
		});
		const read = (await createCartReadRouteHandler()(
			{ input: { cartId } as never, request },
			{ ...h.ctx, storage: failing },
		)) as CartReadRouteResult;
		expect(read).toMatchObject({ ok: true, cart: { cartId }, staleCurrency: null });
		expect(settingsReads).toBeGreaterThan(1);
	});

	test("cart/read still answers when the storefront-settings read rejects: the timer is hidden (#546, #547)", async () => {
		seq += 1;
		await h.stores.settingsStore.update(
			{ showHoldTimer: true },
			idempotencyKey(`hold-timer-on-${String(seq)}`),
		);
		const { cartId } = await h.client.createCart("USD");
		expect(await readRoute(cartId)).toMatchObject({ ok: true, showHoldTimer: true });
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const failing = vi
			.spyOn(InProcessCommerceClient.prototype, "getStorefrontSettings")
			.mockRejectedValueOnce(new Error("settings unreadable"));
		try {
			expect(await readRoute(cartId)).toMatchObject({
				ok: true,
				cart: { cartId },
				showHoldTimer: false,
			});
			expect(failing).toHaveBeenCalledTimes(1);
			expect(errors.mock.calls.flat().map(String).join(" ")).toContain("settings read failed");
		} finally {
			failing.mockRestore();
			errors.mockRestore();
		}
	});

	/** The queries one `replaceStaleCurrencyCart` costs for a stale cart of `n`
	 *  held lines, counted at the storage seam (one D1 query per call). */
	async function replaceCost(n: number, tag: string): Promise<number> {
		await setStoreCurrency("USD");
		const { cartId } = await h.client.createCart();
		for (let i = 0; i < n; i++) {
			const id = `prod-${tag}-${String(i)}`;
			await seedProduct(id, `SKU-${tag}-${String(i)}`, "USD", 1);
			const added = await h.client.addCartLine(
				cartId,
				`SKU-${tag}-${String(i)}`,
				id,
				1,
				`add-${tag}-${String(i)}`,
			);
			if (!added.ok) throw new Error(added.reason);
		}
		await setStoreCurrency("EUR");
		const counter = { calls: 0 };
		const counted = new InProcessCommerceClient({
			...h.ctx,
			storage: countingStorage(h.ctx.storage as StorageAccess, counter),
		});
		const replaced = await counted.replaceStaleCurrencyCart(cartId);
		expect(replaced.ok).toBe(true);
		return counter.calls;
	}

	test("the cost is bounded: a 20-line stale cart fits Workers Free's 50 queries, and releases are capped", async () => {
		// Measured: 4 fixed (settings, the cart document, the keyed create's two
		// writes) + ONE hold lookup per line (the cart read — the same read /cart
		// makes to render this cart) + about 7 per release, at most
		// STALE_CART_RELEASE_LIMIT releases. 2 lines = 20, 20 lines = 38.
		const small = await replaceCost(2, "q2");
		const large = await replaceCost(20, "q20");
		expect(large).toBeLessThanOrEqual(40);
		// Growth is the read alone: one query per extra line, never a re-read of
		// the cart or a release per line (the old `removeLine` loop cost ~15+R each).
		expect(large - small).toBeLessThanOrEqual(18);
	});
});

/** `base` with every call on `name` passed through `before` first. */
function withCollection(base: StorageAccess, name: string, before: () => void): StorageAccess {
	const collection = base[name];
	if (collection === undefined) throw new Error(`no collection ${name}`);
	return {
		...base,
		[name]: new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return async (...args: unknown[]) => {
					before();
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		}),
	};
}

/** The real store, counting every collection call — one D1 query each (the
 *  seam `cron-sweep-budget.test.ts` counts at). */
function countingStorage(base: StorageAccess, counter: { calls: number }): StorageAccess {
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(base)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					counter.calls++;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	return wrapped;
}
