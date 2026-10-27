/**
 * Issue #547: a storefront page reads the settings document ONCE for everything
 * it shows from it, and a busy read degrades to defaults instead of failing the
 * page.
 *
 * Before: the product page read it twice (`getCartHoldTtlMinutes`, then
 * `getShowHoldTimer`) and /cart twice more than the cart's own lazy-expiry read
 * (`getShowHoldTimer`, `getSavedStoreCurrency`). The hold-window read had no
 * `catch`, so a busy settings read 500ed the product page.
 *
 * Every case goes through the real route handler over a real document store; the
 * reads are counted at the storage seam, on the settings collection only.
 */
import { DEFAULT_OPERATIONAL_SETTINGS, idempotencyKey } from "@urumi.ai/otta-domain";
import {
	SETTINGS_COLLECTION,
	StorageContentionError,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
	createCartReadRouteHandler,
	type CartReadRouteResult,
} from "../src/storefront/cart-routes.js";
import {
	createCheckoutSummaryRouteHandler,
	type CheckoutSummaryRouteResult,
} from "../src/storefront/checkout-routes.js";
import { InProcessCommerceClient } from "../src/commerce/in-process-commerce-client.js";
import { createPdpRouteHandler, type PdpRouteResult } from "../src/storefront/pdp-route.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const request = { method: "POST", url: "/route", headers: {} };
const CONTENT = {
	id: "prod-547",
	title: "Held thing",
	slug: "held-thing",
	description: "d",
	images: [],
	url: "https://shop.example.com/products/held-thing",
};

/** The real store, running `before` ahead of every settings-collection call. */
function withSettingsHook(base: StorageAccess, before: () => void): StorageAccess {
	const collection = base[SETTINGS_COLLECTION];
	if (collection === undefined) throw new Error("no settings collection");
	return {
		...base,
		[SETTINGS_COLLECTION]: new Proxy(collection, {
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

describe("storefront pages read the settings once per render (#547)", () => {
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
		await h.client.upsertProductCommerce(
			CONTENT.id,
			{ sku: "SKU-547", price: { amount: 1200, currency: "USD" }, title: "t", initialOnHand: 3 },
			"seed-547",
		);
		await h.client.activateProductCommerce(CONTENT.id, "seed-547-pub", "2026-01-01T00:00:00.000Z");
	});

	async function save(patch: { showHoldTimer?: boolean; holdTtlMinutes?: number }): Promise<void> {
		seq += 1;
		await h.stores.settingsStore.update(patch, idempotencyKey(`s547-${String(seq)}`));
	}

	const pdp = (storage: StorageAccess): Promise<PdpRouteResult> =>
		createPdpRouteHandler()(
			{ input: { content: CONTENT } as never, request },
			{ ...h.ctx, storage },
		) as Promise<PdpRouteResult>;

	const cartRead = (cartId: string, storage: StorageAccess): Promise<CartReadRouteResult> =>
		createCartReadRouteHandler()(
			{ input: { cartId } as never, request },
			{ ...h.ctx, storage },
		) as Promise<CartReadRouteResult>;

	test("the product page reads its settings in one read (was two)", async () => {
		await save({ showHoldTimer: true, holdTtlMinutes: 20 });
		let reads = 0;
		const result = await pdp(withSettingsHook(h.ctx.storage as StorageAccess, () => void reads++));
		expect(result).toMatchObject({ ok: true, cartHoldMinutes: 20, showHoldTimer: true });
		// One for the page's settings, one for the tax display (`getShopPriceDisplay`,
		// a read of its own); it was three before.
		expect(reads).toBe(2);
	});

	test("the cart page reads the settings document once beyond its own lazy-expiry read", async () => {
		const { cartId } = await h.client.createCart("USD");
		let reads = 0;
		const result = await cartRead(
			cartId,
			withSettingsHook(h.ctx.storage as StorageAccess, () => void reads++),
		);
		expect(result).toMatchObject({ ok: true, showHoldTimer: false });
		// One for `getCart`'s hold-window (the domain's lazy expiry), one for the page
		// (was two for the page: the timer flag and the saved currency).
		expect(reads).toBe(2);
	});

	test("a busy settings read does not fail the product page: no hold note, default window", async () => {
		await save({ showHoldTimer: true, holdTtlMinutes: 20 });
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const busy = withSettingsHook(h.ctx.storage as StorageAccess, () => {
				throw new StorageContentionError("settings.get", 1);
			});
			expect(await pdp(busy)).toMatchObject({
				ok: true,
				cartHoldMinutes: DEFAULT_OPERATIONAL_SETTINGS.holdTtlMinutes,
				showHoldTimer: false,
			});
			expect(warn.mock.calls.flat().map(String).join(" ")).toContain("settings read failed");
		} finally {
			warn.mockRestore();
		}
	});

	test("getCartWithSettings rides the settings read getCart already makes: one read, same cart", async () => {
		await save({ showHoldTimer: true, holdTtlMinutes: 20 });
		const { cartId } = await h.client.createCart("USD");
		let reads = 0;
		const counted = new InProcessCommerceClient({
			...h.ctx,
			storage: withSettingsHook(h.ctx.storage as StorageAccess, () => void reads++),
		});
		const both = await counted.getCartWithSettings(cartId);
		expect(reads).toBe(1);
		expect(both.settings).toMatchObject({ holdTtlMinutes: 20, showHoldTimer: true });
		expect(both.cart).toEqual(await h.client.getCart(cartId));
		reads = 0;
		await counted.getCart(cartId);
		expect(reads).toBe(1);
	});

	test("the checkout summary reports showHoldTimer from that same read", async () => {
		const added = async (): Promise<string> => {
			const { cartId } = await h.client.createCart("USD");
			const line = await h.client.addCartLine(cartId, "SKU-547", CONTENT.id, 1, `add-${cartId}`);
			if (!line.ok) throw new Error(line.reason);
			return cartId;
		};
		const summary = async (cartId: string): Promise<CheckoutSummaryRouteResult> =>
			(await createCheckoutSummaryRouteHandler()(
				{ input: { cartId, locale: "en-US" } as never, request },
				h.ctx,
			)) as CheckoutSummaryRouteResult;
		const cartId = await added();
		expect(await summary(cartId)).toMatchObject({ ok: true, showHoldTimer: false });
		await save({ showHoldTimer: true });
		expect(await summary(cartId)).toMatchObject({ ok: true, showHoldTimer: true });
	});
});
