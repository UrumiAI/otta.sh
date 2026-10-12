/**
 * #423: the shop listing and product pages show prices with or without tax —
 * WooCommerce's `woocommerce_tax_display_shop` — by the same rate-table maths as
 * checkout, at the shop base address. Until the merchant picks a value, every
 * page shows the stored price exactly as before.
 *
 * In-process over a real document store (no mocks); the routes are the real
 * handlers, called with the harness's context.
 */
import {
	cents,
	currency,
	idempotencyKey,
	NEW_STORE_TAX_SETTINGS,
	productId as toProductId,
	sku as toSku,
	type TaxCalculator,
	type TaxSettings,
} from "@otta-sh/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CatalogProductCommerce } from "../src/catalog/commerce-view.js";
import { joinProduct, type CmsProductContent } from "../src/catalog/join-product.js";
import { withShopDisplayPrice } from "../src/catalog/shop-display.js";
import { InProcessCommerceClient } from "../src/commerce/in-process-commerce-client.js";
import { cents as plainCents, currency as plainCurrency } from "../src/presentation/money.js";
import { createCartReadRouteHandler } from "../src/storefront/cart-routes.js";
import { createCheckoutSummaryRouteHandler } from "../src/storefront/checkout-routes.js";
import { createPdpRouteHandler } from "../src/storefront/pdp-route.js";
import { createPlpRouteHandler } from "../src/storefront/plp-route.js";
import type { SandboxedRouteContext } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let h: InProcessCommerceHarness;
let seq = 0;

const ON: TaxSettings = {
	...NEW_STORE_TAX_SETTINGS,
	enabled: true,
	baseAddress: { country: "GB", region: null },
	displayShop: "incl",
};

beforeEach(async () => {
	h = await makeInProcessCommerce();
	await h.stores.shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
	await h.stores.taxRules.createClass({ id: "standard", name: "VAT" });
	await h.stores.taxRules.createClass({ id: "reduced", name: "Reduced" });
	await h.stores.taxRules.createRate({
		id: "t-gb-std",
		taxClassId: "standard",
		zoneId: "z-gb",
		rateBps: 2000,
		appliesToShipping: true,
	});
	await h.stores.taxRules.createRate({
		id: "t-gb-red",
		taxClassId: "reduced",
		zoneId: "z-gb",
		rateBps: 500,
		appliesToShipping: false,
	});
});
afterEach(async () => {
	await h.close();
});

async function saveTax(tax: TaxSettings): Promise<void> {
	await h.stores.settingsStore.update({ tax }, idempotencyKey(`tax-${++seq}`));
}

async function seedProduct(
	id: string,
	amount: number,
	opts: { taxClass?: string; taxStatus?: "taxable" | "shipping_only" | "none"; was?: number } = {},
): Promise<void> {
	const store = h.stores.productCommerce;
	const row = await store.upsert(
		{
			productId: toProductId(id),
			sku: toSku(`SKU-${id}`),
			price: { amount: cents(amount), currency: currency("GBP") },
			title: `Product ${id}`,
			...(opts.taxClass !== undefined ? { taxClass: opts.taxClass } : {}),
		},
		idempotencyKey(`seed-${id}`),
	);
	if (opts.taxStatus !== undefined || opts.was !== undefined) {
		const res = await store.updateCommerceFields(
			{
				productId: toProductId(id),
				...(opts.taxStatus !== undefined ? { taxStatus: opts.taxStatus } : {}),
				...(opts.was !== undefined
					? { compareAtPrice: { amount: cents(opts.was), currency: currency("GBP") } }
					: {}),
			},
			idempotencyKey(`edit-${id}`),
			row.updatedAt.toISOString(),
		);
		expect(res.ok).toBe(true);
	}
	await store.activate(toProductId(id), idempotencyKey(`pub-${id}`), "2026-01-01T00:00:00.000Z");
	await h.stores.inventory.seedOnHand(toSku(`SKU-${id}`), 50);
}

const content = (id: string): CmsProductContent => ({ id, title: `Product ${id}`, slug: id });

function routeCtx<T>(input: T): SandboxedRouteContext<T> {
	return { input } as SandboxedRouteContext<T>;
}

async function listPrices(ids: string[]): Promise<Record<string, unknown>> {
	const result = (await createPlpRouteHandler()(
		routeCtx({ items: ids.map(content), locale: "en-GB" }),
		h.ctx,
	)) as { ok: boolean; items: Array<{ id: string; price: unknown; compareAtPrice: unknown }> };
	expect(result.ok).toBe(true);
	return Object.fromEntries(result.items.map((i) => [i.id, i.price]));
}

describe("the commerce client's shop-price display", () => {
	test("nothing saved, rates in place: prices as entered (today's display)", async () => {
		expect(await h.client.getShopPriceDisplay()).toEqual({ mode: "entered" });
	});

	test("including tax, at the base address's zone's rates", async () => {
		await saveTax(ON);
		expect(await h.client.getShopPriceDisplay()).toEqual({
			mode: "incl",
			pricesIncludeTax: false,
			roundAtSubtotal: false,
			ratesByClass: { standard: 2000, reduced: 500 },
			ratesPpmByClass: { standard: 200_000, reduced: 50_000 },
		});
	});

	test("an outside tax calculator is registered: prices as entered — it is never asked per listing", async () => {
		await saveTax(ON);
		let calls = 0;
		const outside: TaxCalculator = {
			id: "acme.tax",
			calculate() {
				calls += 1;
				return Promise.resolve({ ok: false, reason: "unavailable" });
			},
		};
		const client = new InProcessCommerceClient(h.ctx, { taxCalculator: outside });
		expect(await client.getShopPriceDisplay()).toEqual({ mode: "entered" });
		expect(calls).toBe(0);
	});

	test("the catalog batch carries the tax class and status checkout prices with", async () => {
		await seedProduct("p-red", 1000, { taxClass: "reduced", taxStatus: "shipping_only" });
		const [item] = await h.client.getCommerceBatch(["p-red"]);
		expect(item).toMatchObject({ taxClass: "reduced", taxStatus: "shipping_only" });
	});
});

describe("the shop listing (storefront/list)", () => {
	beforeEach(async () => {
		await seedProduct("p-std", 999);
		await seedProduct("p-red", 1000, { taxClass: "reduced" });
		await seedProduct("p-none", 999, { taxStatus: "none" });
	});

	test("nothing saved: every price exactly as stored", async () => {
		expect(await listPrices(["p-std", "p-red", "p-none"])).toEqual({
			"p-std": { amount: 999, currency: "GBP", formatted: "£9.99" },
			"p-red": { amount: 1000, currency: "GBP", formatted: "£10.00" },
			"p-none": { amount: 999, currency: "GBP", formatted: "£9.99" },
		});
	});

	test("saved without the option (a block from before #423): still as stored", async () => {
		const { displayShop: _omit, ...before } = ON;
		await saveTax(before);
		expect(await listPrices(["p-std"])).toEqual({
			"p-std": { amount: 999, currency: "GBP", formatted: "£9.99" },
		});
	});

	test("including tax: each product at its own class's rate; a non-taxable product as stored", async () => {
		await saveTax(ON);
		expect(await listPrices(["p-std", "p-red", "p-none"])).toEqual({
			"p-std": { amount: 1199, currency: "GBP", formatted: "£11.99", taxNote: "incl" },
			"p-red": { amount: 1050, currency: "GBP", formatted: "£10.50", taxNote: "incl" },
			"p-none": { amount: 999, currency: "GBP", formatted: "£9.99", taxNote: "incl" },
		});
	});

	test("prices entered with tax, shown excluding: the tax inside is taken out (half down)", async () => {
		await saveTax({ ...ON, pricesIncludeTax: true, displayShop: "excl" });
		expect(await listPrices(["p-std"])).toEqual({
			"p-std": { amount: 833, currency: "GBP", formatted: "£8.33", taxNote: "excl" },
		});
	});

	test("tax switched off: as stored, whatever the option says", async () => {
		await saveTax({ ...ON, enabled: false });
		expect(await listPrices(["p-std"])).toEqual({
			"p-std": { amount: 999, currency: "GBP", formatted: "£9.99" },
		});
	});
});

describe("the product page (storefront/product)", () => {
	test("the price, the was-price and the JSON-LD offer all show including tax", async () => {
		await seedProduct("p-sale", 1000, { was: 1500 });
		await saveTax(ON);
		const result = (await createPdpRouteHandler()(
			routeCtx({ content: content("p-sale"), locale: "en-GB" }),
			h.ctx,
		)) as {
			ok: boolean;
			product: { price: unknown; compareAtPrice: unknown };
			jsonLd: { offers?: { price?: unknown } };
		};
		expect(result.ok).toBe(true);
		expect(result.product.price).toEqual({
			amount: 1200,
			currency: "GBP",
			formatted: "£12.00",
			taxNote: "incl",
		});
		expect(result.product.compareAtPrice).toEqual({
			amount: 1800,
			currency: "GBP",
			formatted: "£18.00",
		});
		expect(result.jsonLd.offers?.price).toBe("12.00");
	});
});

const commerceRow = (over: Partial<CatalogProductCommerce> = {}): CatalogProductCommerce => ({
	productId: "p1",
	sku: "SKU-1",
	price: { amount: plainCents(999), currency: plainCurrency("GBP") },
	title: "P1",
	compareAtPrice: null,
	inStock: true,
	active: true,
	...over,
});
describe("withShopDisplayPrice — the join, re-priced for display", () => {
	const incl = {
		mode: "incl" as const,
		pricesIncludeTax: false,
		roundAtSubtotal: false,
		ratesByClass: { standard: 2000 },
		ratesPpmByClass: {},
	};

	test("as entered: the very same join", () => {
		const joined = joinProduct(content("p1"), commerceRow());
		expect(withShopDisplayPrice(joined, { mode: "entered" })).toBe(joined);
	});

	test("no commerce row: unchanged", () => {
		const joined = joinProduct(content("p1"), null);
		expect(withShopDisplayPrice(joined, incl)).toBe(joined);
	});

	test("a row with no class or status read: standard and taxable, as checkout reads it", () => {
		const shown = withShopDisplayPrice(joinProduct(content("p1"), commerceRow()), incl);
		expect(shown.commerce?.price.amount).toBe(1199);
	});

	test("the stored row is not modified", () => {
		const row = commerceRow();
		withShopDisplayPrice(joinProduct(content("p1"), row), incl);
		expect(row.price.amount).toBe(999);
	});
});

// ── Review round 1 (#423): the cart and checkout lines follow displayCart ──

interface Money {
	amount: number;
	formatted: string;
}
interface LineMoney {
	unitPrice: Money | null;
	lineTotal: Money | null;
}

async function cartWith(items: Array<[string, number]>): Promise<string> {
	const { cartId } = await h.client.createCart("GBP");
	for (const [id, qty] of items) {
		const added = await h.client.addCartLine(cartId, `SKU-${id}`, id, qty, `add-${id}-${++seq}`);
		expect(added.ok).toBe(true);
	}
	return cartId;
}

async function pdpPrice(id: string): Promise<{ amount: number; taxNote?: string }> {
	const result = (await createPdpRouteHandler()(
		routeCtx({ content: content(id), locale: "en-GB" }),
		h.ctx,
	)) as { ok: boolean; product: { price: { amount: number; taxNote?: string } } };
	expect(result.ok).toBe(true);
	return result.product.price;
}

async function cartLines(cartId: string): Promise<{ lines: LineMoney[]; total: Money | null }> {
	const result = (await createCartReadRouteHandler()(
		routeCtx({ cartId, locale: "en-GB" }),
		h.ctx,
	)) as {
		ok: boolean;
		pricing: { degraded: boolean; lines: LineMoney[]; total: Money | null };
	};
	expect(result.ok).toBe(true);
	expect(result.pricing.degraded).toBe(false);
	return result.pricing;
}

async function checkoutReview(
	cartId: string,
): Promise<{ lines: LineMoney[]; subtotal: number | undefined }> {
	const result = (await createCheckoutSummaryRouteHandler()(
		routeCtx({ cartId, locale: "en-GB", destination: { country: "GB" } }),
		h.ctx,
	)) as {
		ok: boolean;
		lines: LineMoney[];
		totals: { subtotal: { money: Money | null } };
	};
	expect(result.ok).toBe(true);
	return { lines: result.lines, subtotal: result.totals.subtotal.money?.amount };
}

describe("PDP, cart line and checkout line agree at qty 1 (displayShop = displayCart)", () => {
	test.each([
		// [prices entered with tax, display, shown]
		[false, "incl", 1199],
		[false, "excl", 999],
		[true, "incl", 999],
		[true, "excl", 833],
	] as const)(
		"prices entered with tax: %s, shown %s ⇒ %i everywhere",
		async (incl, mode, shown) => {
			await seedProduct("p-1", 999);
			await saveTax({ ...ON, pricesIncludeTax: incl, displayShop: mode, displayCart: mode });
			const cartId = await cartWith([["p-1", 1]]);

			expect((await pdpPrice("p-1")).amount).toBe(shown);
			const cart = await cartLines(cartId);
			expect(cart.lines[0]?.unitPrice?.amount).toBe(shown);
			expect(cart.lines[0]?.lineTotal?.amount).toBe(shown);
			const review = await checkoutReview(cartId);
			expect(review.lines[0]?.unitPrice?.amount).toBe(shown);
			expect(review.lines[0]?.lineTotal?.amount).toBe(shown);
			expect(review.subtotal).toBe(shown);
		},
	);
});

describe("cart and checkout lines — consistency and defaults", () => {
	test("nothing saved: cart and checkout lines are the stored prices, byte for byte", async () => {
		await seedProduct("p-1", 999);
		const cartId = await cartWith([["p-1", 2]]);
		const cart = await cartLines(cartId);
		expect(cart.lines[0]).toMatchObject({
			unitPrice: { amount: 999, currency: "GBP", formatted: "£9.99" },
			lineTotal: { amount: 1998, currency: "GBP", formatted: "£19.98" },
		});
		expect(cart.total).toEqual({ amount: 1998, currency: "GBP", formatted: "£19.98" });
		const review = await checkoutReview(cartId);
		expect(review.lines[0]).toMatchObject({
			unitPrice: { amount: 999, currency: "GBP", formatted: "£9.99" },
			lineTotal: { amount: 1998, currency: "GBP", formatted: "£19.98" },
		});
	});

	test("including tax over mixed classes and quantities: the lines sum to the shown subtotal and cart total", async () => {
		await seedProduct("p-std", 99);
		await seedProduct("p-red", 1001, { taxClass: "reduced" });
		await saveTax({ ...ON, displayCart: "incl" });
		const cartId = await cartWith([
			["p-std", 3],
			["p-red", 2],
		]);

		const cart = await cartLines(cartId);
		// 297 + 20% = 297 + 59 (59.4); 2002 + 5% = 2002 + 100 (100.1).
		// The cart does not promise a line order: compare as a set.
		expect(cart.lines.map((l) => l.lineTotal?.amount ?? 0).toSorted((a, b) => a - b)).toEqual([
			356, 2102,
		]);
		expect(cart.total?.amount).toBe(356 + 2102);

		const review = await checkoutReview(cartId);
		const sum = review.lines.reduce((n, l) => n + (l.lineTotal?.amount ?? 0), 0);
		const bySku = Object.fromEntries(
			(review.lines as Array<LineMoney & { sku: string }>).map((l) => [l.sku, l.lineTotal?.amount]),
		);
		expect(bySku).toEqual({ "SKU-p-std": 356, "SKU-p-red": 2102 });
		expect(sum).toBe(review.subtotal);
	});
});

/**
 * #478 (#477's numbers): with "round at subtotal", checkout rounds the cart's tax
 * once; the cart page priced each line alone and showed a cent more. It now
 * prices its lines together, so the cart total matches the checkout subtotal.
 */
describe("round at subtotal: the cart page's total matches checkout", () => {
	test.each([
		[true, 221],
		[false, 222],
	] as const)(
		"roundAtSubtotal %s: 2 × 103¢ at 7.5 percent, shown including ⇒ %i on both",
		async (roundAtSubtotal, total) => {
			await h.stores.taxRules.createClass({ id: "s75", name: "Seven and a half" });
			await h.stores.taxRules.createRate({
				id: "t-gb-s75",
				taxClassId: "s75",
				zoneId: "z-gb",
				rateBps: 750,
				appliesToShipping: false,
			});
			await seedProduct("p-a", 103, { taxClass: "s75" });
			await seedProduct("p-b", 103, { taxClass: "s75" });
			await saveTax({ ...ON, roundAtSubtotal, displayCart: "incl" });
			const cartId = await cartWith([
				["p-a", 1],
				["p-b", 1],
			]);

			const cart = await cartLines(cartId);
			expect(cart.total?.amount).toBe(total);
			expect(cart.lines.reduce((n, l) => n + (l.lineTotal?.amount ?? 0), 0)).toBe(total);
			const review = await checkoutReview(cartId);
			expect(review.subtotal).toBe(total);
		},
	);
});

describe("the price display read fails: pages fall back to prices as entered", () => {
	function breakZones(): void {
		const storage = h.ctx.storage as unknown as Record<string, unknown>;
		const zones = storage["shipping_zones"] as object;
		storage["shipping_zones"] = new Proxy(zones, {
			get(target, property) {
				if (property === "query" || property === "get") {
					return () => Promise.reject(new Error("zones unavailable"));
				}
				return Reflect.get(target, property) as unknown;
			},
		});
	}

	test("PDP, PLP and the cart page still render, at the stored price", async () => {
		await seedProduct("p-1", 999);
		await saveTax({ ...ON, displayCart: "incl" });
		const cartId = await cartWith([["p-1", 1]]);
		breakZones();

		expect(await pdpPrice("p-1")).toEqual({ amount: 999, currency: "GBP", formatted: "£9.99" });
		expect(await listPrices(["p-1"])).toEqual({
			"p-1": { amount: 999, currency: "GBP", formatted: "£9.99" },
		});
		expect((await cartLines(cartId)).lines[0]?.lineTotal?.amount).toBe(999);
	});
});

describe("the product view model names the tax display when the merchant opted in", () => {
	test("including tax ⇒ price.taxNote = incl; nothing saved ⇒ no taxNote key at all", async () => {
		await seedProduct("p-1", 999);
		expect(await pdpPrice("p-1")).not.toHaveProperty("taxNote");
		await saveTax(ON);
		expect(await pdpPrice("p-1")).toMatchObject({ amount: 1199, taxNote: "incl" });
		await saveTax({ ...ON, displayShop: "excl" });
		expect(await pdpPrice("p-1")).toMatchObject({ amount: 999, taxNote: "excl" });
	});
});
