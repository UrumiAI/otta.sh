import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import { idempotencyKey } from "../../src/money/ids.js";
import {
	loadCartPriceDisplay,
	loadShopPriceDisplay,
	SHOP_PRICE_AS_ENTERED,
	type ShopPriceDisplay,
	shopDisplayPrice,
	shopDisplayPrices,
} from "../../src/pricing/shop-display-price.js";
import { applyRateTable, rateTableOf } from "../../src/pricing/rate-table-calculator.js";
import {
	LEGACY_TAX_SETTINGS,
	NEW_STORE_TAX_SETTINGS,
	parseTaxSettings,
	readTaxSettings,
	sameTaxSettings,
	type TaxSettings,
} from "../../src/pricing/tax-settings.js";
import { InMemorySettingsStore } from "../../src/testing/in-memory-settings-store.js";
import { InMemoryShippingRulesStore } from "../../src/testing/in-memory-shipping-rules-store.js";
import { InMemoryTaxRulesStore } from "../../src/testing/in-memory-tax-rules-store.js";

/**
 * #423: shop and product pages show prices with or without tax — WooCommerce's
 * `woocommerce_tax_display_shop` — priced by the SAME rate-table maths as
 * checkout, at the shop base address (WooCommerce's default for a shopper whose
 * address is not known). Absent, the option keeps today's display: the price as
 * entered.
 */
const USD = currency("USD");

const display = (
	mode: "excl" | "incl",
	pricesIncludeTax: boolean,
	ratesByClass: Record<string, number>,
	roundAtSubtotal = false,
): ShopPriceDisplay => ({
	mode,
	pricesIncludeTax,
	roundAtSubtotal,
	ratesByClass,
	ratesPpmByClass: {},
});

const item = (amount: number, over: Partial<Parameters<typeof shopDisplayPrice>[1]> = {}) => ({
	currency: USD,
	unitPriceCents: cents(amount),
	taxClassId: "standard",
	taxStatus: "taxable" as const,
	...over,
});

describe("the displayShop option (tax settings)", () => {
	test("absent from both default blocks — no store changes until the merchant opts in", () => {
		expect(NEW_STORE_TAX_SETTINGS.displayShop).toBeUndefined();
		expect(LEGACY_TAX_SETTINGS.displayShop).toBeUndefined();
	});

	test("a block saved before the option existed reads back unchanged, not as damaged", () => {
		const before: TaxSettings = { ...NEW_STORE_TAX_SETTINGS, enabled: true };
		const read = readTaxSettings(JSON.parse(JSON.stringify(before)));
		expect(read).toEqual(before);
		expect(read && "displayShop" in read).toBe(false);
	});

	test.each(["excl", "incl"] as const)("%s is accepted and kept", (value) => {
		const parsed = parseTaxSettings({ ...NEW_STORE_TAX_SETTINGS, displayShop: value });
		expect(parsed).toEqual({ ...NEW_STORE_TAX_SETTINGS, displayShop: value });
	});

	test.each<[string, unknown]>([
		["an unknown word", "both"],
		["null", null],
		["a boolean", true],
	])("%s is refused on tax.displayShop", (_name, value) => {
		expect(parseTaxSettings({ ...NEW_STORE_TAX_SETTINGS, displayShop: value })).toMatchObject({
			field: "tax.displayShop",
		});
	});

	test("two blocks differing only in displayShop are not the same", () => {
		const a: TaxSettings = { ...NEW_STORE_TAX_SETTINGS };
		expect(sameTaxSettings(a, { ...a, displayShop: "incl" })).toBe(false);
		expect(sameTaxSettings({ ...a, displayShop: "excl" }, { ...a, displayShop: "incl" })).toBe(
			false,
		);
		expect(sameTaxSettings({ ...a, displayShop: "incl" }, { ...a, displayShop: "incl" })).toBe(
			true,
		);
	});
});

describe("shopDisplayPrice — the checkout's rate-table maths, one product", () => {
	test("as entered: the stored price, whatever the rates", () => {
		expect(shopDisplayPrice(SHOP_PRICE_AS_ENTERED, item(999))).toBe(999);
	});

	test("prices without tax, shown including: net + the line's tax (half up)", () => {
		// EX-02's line: 999 at 20% → tax 200 (199.8 half up).
		expect(shopDisplayPrice(display("incl", false, { standard: 2000 }), item(999))).toBe(1199);
	});

	test("prices with tax, shown excluding: gross − the tax inside it (half down, IN-02)", () => {
		// IN-02: 999 gross at 20% → tax 166 (166.5 half down), net 833.
		expect(shopDisplayPrice(display("excl", true, { standard: 2000 }), item(999))).toBe(833);
	});

	test("the same mode as entered changes nothing", () => {
		expect(shopDisplayPrice(display("excl", false, { standard: 2000 }), item(999))).toBe(999);
		expect(shopDisplayPrice(display("incl", true, { standard: 2000 }), item(999))).toBe(999);
	});

	test("the product's tax class picks the rate; a class with no rate is 0%", () => {
		const d = display("incl", false, { standard: 2000, reduced: 500 });
		expect(shopDisplayPrice(d, item(1000, { taxClassId: "reduced" }))).toBe(1050);
		expect(shopDisplayPrice(d, item(1000, { taxClassId: "zero" }))).toBe(1000);
	});

	test.each(["none", "shipping_only"] as const)(
		"a product with tax status %s carries no tax: the stored price",
		(taxStatus) => {
			expect(
				shopDisplayPrice(display("incl", false, { standard: 2000 }), item(999, { taxStatus })),
			).toBe(999);
			expect(
				shopDisplayPrice(display("excl", true, { standard: 2000 }), item(999, { taxStatus })),
			).toBe(999);
		},
	);

	test("round at subtotal gives the same single-product answer", () => {
		expect(shopDisplayPrice(display("incl", false, { standard: 2000 }, true), item(999))).toBe(
			1199,
		);
		expect(shopDisplayPrice(display("excl", true, { standard: 2000 }, true), item(999))).toBe(833);
	});

	test("a class named like an Object prototype key is just a class with no rate", () => {
		const d = display("incl", false, { standard: 2000 });
		expect(shopDisplayPrice(d, item(1000, { taxClassId: "constructor" }))).toBe(1000);
	});
});

/**
 * #478: the cart page's lines, priced together. With "round at subtotal" the
 * checkout rounds the cart's tax once and allocates it to the lines, so the cart
 * page does the same — one multi-line rate-table call — and both show one total.
 */
describe("shopDisplayPrices — several lines, as checkout prices them together", () => {
	test("#477's numbers: 2 × 103¢ at 7.5%, shown including, round at subtotal ⇒ $2.21, as checkout", () => {
		const d = display("incl", false, { standard: 750 }, true);
		const amounts = shopDisplayPrices(d, [item(103), item(103)]);
		// 2 × 7.725 = 15.45 ⇒ 15, allocated 8 + 7 (not 8 + 8 per line).
		expect(amounts).toEqual([111, 110]);
		expect(amounts[0]! + amounts[1]!).toBe(221);
		// Each line alone still rounds its own tax.
		expect(shopDisplayPrice(d, item(103))).toBe(111);
	});

	test("rounding per line: each line exactly as shopDisplayPrice alone ($2.22)", () => {
		const d = display("incl", false, { standard: 750 });
		expect(shopDisplayPrices(d, [item(103), item(103)])).toEqual([111, 111]);
	});

	test.each([
		["prices without tax, shown including", "incl", false],
		["prices with tax, shown excluding", "excl", true],
	] as const)("%s: the same tax the checkout's rate table gives the cart", (_name, mode, incl) => {
		const d = display(mode, incl, { standard: 750, reduced: 500 }, true);
		const items = [
			item(103, { quantity: 3 }),
			item(103),
			item(999, { taxClassId: "reduced" }),
			item(250, { taxStatus: "none" }),
		];
		const checkout = applyRateTable(
			{
				purpose: "quote",
				currency: USD,
				pricesIncludeTax: incl,
				lines: items.map((it, i) => ({
					lineId: String(i),
					quantity: it.quantity ?? 1,
					unitPriceCents: it.unitPriceCents,
					amountCents: cents(it.unitPriceCents * (it.quantity ?? 1)),
					taxClassId: it.taxClassId,
					taxStatus: it.taxStatus,
					requiresShipping: false,
				})),
				shipping: null,
				origin: null,
				destination: null,
				zoneId: "z",
			},
			rateTableOf([
				{ id: "a", zoneId: "z", taxClassId: "standard", rateBps: 750, appliesToShipping: false },
				{ id: "b", zoneId: "z", taxClassId: "reduced", rateBps: 500, appliesToShipping: false },
			]),
			new Map(),
			{ roundAtSubtotal: true },
		);
		const sign = incl ? -1 : 1;
		expect(shopDisplayPrices(d, items)).toEqual(
			items.map(
				(it, i) =>
					it.unitPriceCents * (it.quantity ?? 1) + sign * (checkout.lines[i]?.taxCents ?? 0),
			),
		);
	});

	test("as entered, or no lines: the stored amounts", () => {
		expect(shopDisplayPrices(SHOP_PRICE_AS_ENTERED, [item(103, { quantity: 2 })])).toEqual([206]);
		expect(shopDisplayPrices(display("incl", false, { standard: 750 }, true), [])).toEqual([]);
	});
});

describe("loadShopPriceDisplay — what the store's options say to show", () => {
	let settings: InMemorySettingsStore;
	let taxRules: InMemoryTaxRulesStore;
	let shippingRules: InMemoryShippingRulesStore;
	let seq = 0;
	const save = (tax: TaxSettings) => settings.update({ tax }, idempotencyKey(`k${++seq}`));
	const load = (hasOutsideTaxCalculator = false) =>
		loadShopPriceDisplay({ settings, taxRules, shippingRules, hasOutsideTaxCalculator });
	const on: TaxSettings = {
		...NEW_STORE_TAX_SETTINGS,
		enabled: true,
		baseAddress: { country: "GB", region: null },
		displayShop: "incl",
	};

	beforeEach(async () => {
		settings = new InMemorySettingsStore();
		taxRules = new InMemoryTaxRulesStore();
		shippingRules = new InMemoryShippingRulesStore();
		await shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
		await shippingRules.createZone({ id: "z-us", name: "US", regions: ["US"] });
		await taxRules.createClass({ id: "standard", name: "VAT" });
		await taxRules.createClass({ id: "reduced", name: "Reduced" });
		for (const [id, zoneId, taxClassId, rateBps] of [
			["t-gb-std", "z-gb", "standard", 2000],
			["t-gb-red", "z-gb", "reduced", 500],
			["t-us-std", "z-us", "standard", 800],
		] as const) {
			await taxRules.createRate({ id, taxClassId, zoneId, rateBps, appliesToShipping: false });
		}
	});

	test("nothing saved (a store with rates): as entered — today's display", async () => {
		expect(await load()).toEqual(SHOP_PRICE_AS_ENTERED);
	});

	test("saved without displayShop: as entered", async () => {
		const { displayShop: _omit, ...withoutDisplay } = on;
		await save(withoutDisplay);
		expect(await load()).toEqual(SHOP_PRICE_AS_ENTERED);
	});

	test("tax switched off: as entered, whatever displayShop says", async () => {
		await save({ ...on, enabled: false });
		expect(await load()).toEqual(SHOP_PRICE_AS_ENTERED);
	});

	test("an outside calculator is registered: as entered (never called per listing)", async () => {
		await save(on);
		expect(await load(true)).toEqual(SHOP_PRICE_AS_ENTERED);
	});

	test("no base address: as entered — there is nowhere to price the tax", async () => {
		await save({ ...on, baseAddress: null });
		expect(await load()).toEqual(SHOP_PRICE_AS_ENTERED);
	});

	test("the base address's zone's rates, per class, with the store's price options", async () => {
		await save({ ...on, pricesIncludeTax: true, roundAtSubtotal: true, displayShop: "excl" });
		expect(await load()).toEqual({
			mode: "excl",
			pricesIncludeTax: true,
			roundAtSubtotal: true,
			ratesByClass: { standard: 2000, reduced: 500 },
			ratesPpmByClass: { standard: 200_000, reduced: 50_000 },
		});
	});

	test.each([
		["prices entered without tax, shown including", false, "incl", 100_000, 108_875],
		["prices entered with tax, shown excluding", true, "excl", 108_875, 100_000],
	] as const)(
		"#425 x #423: an 8.875 percent rate shows the exact rate, as checkout charges — %s",
		async (_name, pricesIncludeTax, displayShop, entered, shown) => {
			await shippingRules.createZone({ id: "z-ny", name: "NYC", regions: ["US-NY"] });
			await taxRules.createRate({
				id: "t-ny-std",
				taxClassId: "standard",
				zoneId: "z-ny",
				rateBps: 888,
				ratePpm: 88_750,
				appliesToShipping: false,
			});
			await save({
				...on,
				pricesIncludeTax,
				displayShop,
				baseAddress: { country: "US", region: "NY" },
			});
			const loaded = await load();
			expect(loaded).toMatchObject({
				ratesByClass: { standard: 888 },
				ratesPpmByClass: { standard: 88_750 },
			});
			const price = shopDisplayPrice(loaded, item(entered));
			// By hand: 1000.00 x 8.875% = 88.75 exactly; the rounded 888 bps would give 88.80.
			expect(price).toBe(shown);
			// The checkout's own rate table over the same zone charges the same tax.
			const table = rateTableOf(await taxRules.listRatesForZone("z-ny"));
			const quoted = applyRateTable(
				{
					purpose: "quote",
					currency: USD,
					pricesIncludeTax,
					lines: [
						{
							lineId: "l",
							quantity: 1,
							unitPriceCents: cents(entered),
							amountCents: cents(entered),
							taxClassId: "standard",
							taxStatus: "taxable",
							requiresShipping: false,
						},
					],
					shipping: null,
					origin: null,
					destination: null,
					zoneId: "z-ny",
				},
				table,
				new Map(),
				{ roundAtSubtotal: false },
			);
			expect(quoted.lines[0]?.taxCents).toBe(8875);
		},
	);

	test("based on the shipping address still prices a shopper at the base (WooCommerce's default)", async () => {
		await save({ ...on, basedOn: "shipping", baseAddress: { country: "US", region: null } });
		expect(await load()).toMatchObject({ mode: "incl", ratesByClass: { standard: 800 } });
	});

	test("a base address no zone matches: no rates — every price shows as 0% tax", async () => {
		await save({ ...on, baseAddress: { country: "FR", region: null } });
		expect(await load()).toMatchObject({ mode: "incl", ratesByClass: {} });
	});

	test("#478 x #488: a base address that contains a narrower zone is priced at its own zone, never asked", async () => {
		await shippingRules.createZone({ id: "z-es-cn", name: "Canary Islands", regions: ["ES-CN"] });
		await shippingRules.createZone({ id: "z-es-tf", name: "Tenerife", regions: ["ES-TF"] });
		await taxRules.createRate({
			id: "t-es-cn-std",
			taxClassId: "standard",
			zoneId: "z-es-cn",
			rateBps: 700,
			appliesToShipping: false,
		});
		await taxRules.createRate({
			id: "t-es-tf-std",
			taxClassId: "standard",
			zoneId: "z-es-tf",
			rateBps: 300,
			appliesToShipping: false,
		});
		await save({ ...on, baseAddress: { country: "ES", region: "CN" } });
		expect(await load()).toMatchObject({ mode: "incl", ratesByClass: { standard: 700 } });
	});

	test("end to end: a 9.99 product in a 20% base zone shows 11.99 including tax", async () => {
		await save(on);
		expect(shopDisplayPrice(await load(), item(999))).toBe(1199);
	});

	test("#478: a corrupt rate in the base zone still fails the read (the page shows prices as entered)", async () => {
		await save(on);
		const corrupt = {
			async listRatesForZone(zoneId: string) {
				const rates = await taxRules.listRatesForZone(zoneId);
				return rates.map((r) => (r.taxClassId === "reduced" ? { ...r, rateBps: 7.5 } : r));
			},
		};
		await expect(
			loadShopPriceDisplay({
				settings,
				taxRules: corrupt,
				shippingRules,
				hasOutsideTaxCalculator: false,
			}),
		).rejects.toThrow(RangeError);
	});
});

describe("loadCartPriceDisplay — the cart page's lines follow displayCart (WooCommerce's tax_display_cart)", () => {
	let settings: InMemorySettingsStore;
	let taxRules: InMemoryTaxRulesStore;
	let shippingRules: InMemoryShippingRulesStore;
	let seq = 0;
	const save = (tax: TaxSettings) => settings.update({ tax }, idempotencyKey(`c${++seq}`));
	const load = (hasOutsideTaxCalculator = false) =>
		loadCartPriceDisplay({ settings, taxRules, shippingRules, hasOutsideTaxCalculator });
	const on: TaxSettings = {
		...NEW_STORE_TAX_SETTINGS,
		enabled: true,
		baseAddress: { country: "GB", region: null },
	};

	beforeEach(async () => {
		settings = new InMemorySettingsStore();
		taxRules = new InMemoryTaxRulesStore();
		shippingRules = new InMemoryShippingRulesStore();
		await shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
		await taxRules.createClass({ id: "standard", name: "VAT" });
		await taxRules.createRate({
			id: "t-gb",
			taxClassId: "standard",
			zoneId: "z-gb",
			rateBps: 2000,
			appliesToShipping: false,
		});
	});

	test("nothing saved: as entered", async () => {
		expect(await load()).toEqual(SHOP_PRICE_AS_ENTERED);
	});

	test.each([
		[false, "excl"],
		[true, "incl"],
	] as const)(
		"prices entered with tax %s, shown %s (the same way): as entered",
		async (incl, cart) => {
			await save({ ...on, pricesIncludeTax: incl, displayCart: cart });
			expect(await load()).toEqual(SHOP_PRICE_AS_ENTERED);
		},
	);

	test("prices without tax shown including: the base zone's rates, independent of displayShop", async () => {
		await save({ ...on, displayCart: "incl" });
		expect(await load()).toEqual({
			mode: "incl",
			pricesIncludeTax: false,
			roundAtSubtotal: false,
			ratesByClass: { standard: 2000 },
			ratesPpmByClass: { standard: 200_000 },
		});
	});

	test("tax off, no base address, or an outside calculator: as entered", async () => {
		await save({ ...on, displayCart: "incl", enabled: false });
		expect(await load()).toEqual(SHOP_PRICE_AS_ENTERED);
		await save({ ...on, displayCart: "incl", baseAddress: null });
		expect(await load()).toEqual(SHOP_PRICE_AS_ENTERED);
		await save({ ...on, displayCart: "incl" });
		expect(await load(true)).toEqual(SHOP_PRICE_AS_ENTERED);
	});
});
