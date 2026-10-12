/**
 * Shop-page price display (#423) — WooCommerce's `woocommerce_tax_display_shop`.
 *
 * A product's price on the shop listing and product pages, shown with or without
 * tax. It is priced by the SAME rate-table arithmetic as checkout
 * (`applyRateTable`, one line), never a parallel formula, so the page and the
 * cart agree to the cent: integer minor units, half up on prices without tax,
 * half down on the tax inside a price with tax.
 *
 * WHERE: the shop base address, WooCommerce's default location for a shopper
 * whose address it does not know (`woocommerce_default_customer_address` =
 * base). Its zone's rates apply, per class; a base address no zone matches has
 * no rate (0%, never an error — the checkout rule).
 *
 * WHEN THE STORED PRICE IS SHOWN unchanged ({@link SHOP_PRICE_AS_ENTERED}):
 *  - `displayShop` is absent — what every store showed before the option, and
 *    what both default blocks keep, so no store changes until its merchant opts in;
 *  - tax is switched off, or no base address is set (nowhere to price it);
 *  - an outside tax calculator is registered (ADR-0030): it is asked once per
 *    quote, at checkout, with a real cart — never once per product on every
 *    listing render, which would put a paid, rate-limited, possibly slow outside
 *    call on every page view. Such a store's pages show prices as entered.
 */
import { type Cents, cents, type Currency } from "../money/cents.js";
import type { ProductTaxStatus } from "../ports/product-commerce-store.js";
import type { SettingsStore } from "../ports/settings-store.js";
import type { ShippingRulesStore } from "../ports/shipping-rules-store.js";
import type { TaxRulesStore } from "../ports/tax-rules-store.js";
import { applyRateTable, type RateTable, rateTableOf } from "./rate-table-calculator.js";
import type { ShopTaxDisplay, TaxSettings } from "./tax-settings.js";
import type { TaxClassId } from "./types.js";
import { resolveShippingZone } from "./zone-match.js";

/** What a shop page applies to every price it shows. Plain data (JSON-safe). */
export type ShopPriceDisplay =
	| { mode: "entered" }
	| {
			mode: ShopTaxDisplay;
			/** Prices are entered with tax (the store's option). */
			pricesIncludeTax: boolean;
			/** The store's rounding option, so a single line rounds as checkout does. */
			roundAtSubtotal: boolean;
			/** The base address's zone's rate per class, in basis points. */
			ratesByClass: Readonly<Record<TaxClassId, number>>;
			/** The same rates exactly, in millionths (#425, ADR-0036): 8.875% is
			 *  88750, where `ratesByClass` holds the rounded 888 bps. A class missing
			 *  here falls back to its bps × 100, as the rate table does. */
			ratesPpmByClass: Readonly<Record<TaxClassId, number>>;
	  };

/** Show the stored price, unchanged. */
export const SHOP_PRICE_AS_ENTERED: ShopPriceDisplay = Object.freeze({ mode: "entered" });

export interface ShopDisplayItem {
	currency: Currency;
	unitPriceCents: Cents;
	/** Default 1 — a product page shows one unit. */
	quantity?: number;
	/** The product's class; `standard` when it names none (as checkout reads it). */
	taxClassId: TaxClassId;
	/** Only a `taxable` product carries tax (#417). */
	taxStatus: ProductTaxStatus;
}

/**
 * The price to show for `quantity` units (the line amount). With prices entered
 * without tax, "incl" adds the line's tax; with prices entered with tax, "excl"
 * takes out the tax inside it. The same mode as entered — or a product that is
 * not taxable, or a class with no rate — shows the stored amount.
 */
export function shopDisplayPrice(display: ShopPriceDisplay, item: ShopDisplayItem): Cents {
	const quantity = item.quantity ?? 1;
	const amount = cents(item.unitPriceCents * quantity);
	if (display.mode === "entered") return amount;
	// The rate table checkout reads, built straight from the base zone's rates.
	const table: RateTable = {
		ratesByClass: new Map(Object.entries(display.ratesByClass)),
		ratesPpmByClass: new Map(Object.entries(display.ratesPpmByClass)),
		shippingTaxable: false,
		shippingTaxClassId: "standard",
	};
	const result = applyRateTable(
		{
			purpose: "quote",
			currency: item.currency,
			pricesIncludeTax: display.pricesIncludeTax,
			lines: [
				{
					lineId: "shop",
					quantity,
					unitPriceCents: item.unitPriceCents,
					amountCents: amount,
					taxClassId: item.taxClassId,
					taxStatus: item.taxStatus,
					requiresShipping: false,
				},
			],
			shipping: null,
			origin: null,
			destination: null,
			zoneId: "shop-base",
		},
		table,
		new Map(),
		{ roundAtSubtotal: display.roundAtSubtotal },
	);
	const tax = result.lines[0]?.taxCents ?? 0;
	if (display.pricesIncludeTax) return display.mode === "excl" ? cents(amount - tax) : amount;
	return display.mode === "incl" ? cents(amount + tax) : amount;
}

export interface ShopPriceDisplayDeps {
	/** Absent ⇒ nothing saved ⇒ as entered. */
	settings?: Pick<SettingsStore, "get">;
	taxRules: Pick<TaxRulesStore, "listRatesForZone">;
	shippingRules: Pick<ShippingRulesStore, "listZones">;
	/** An outside calculator is registered (ADR-0030) ⇒ as entered. */
	hasOutsideTaxCalculator: boolean;
}

/**
 * The store's shop-page display, read once per page render: the saved options,
 * and — only when they ask for an adjustment — the zones and the base zone's
 * rates. A store that never saved options shows prices as entered: both
 * upgrade-rule blocks (`effectiveTaxSettings`) leave `displayShop` absent.
 */
export function loadShopPriceDisplay(deps: ShopPriceDisplayDeps): Promise<ShopPriceDisplay> {
	return loadPriceDisplay(deps, (saved) => saved.displayShop);
}

/**
 * The cart page's line prices (WooCommerce's `tax_display_cart`, the store's
 * `displayCart`), for a shopper whose address is not known yet — at the shop base
 * address, by the same rules as {@link loadShopPriceDisplay}. Shown the same way
 * as entered (the default for every store) is "as entered": nothing to adjust.
 */
export function loadCartPriceDisplay(deps: ShopPriceDisplayDeps): Promise<ShopPriceDisplay> {
	return loadPriceDisplay(deps, (saved) =>
		saved.displayCart === (saved.pricesIncludeTax ? "incl" : "excl")
			? undefined
			: saved.displayCart,
	);
}

async function loadPriceDisplay(
	deps: ShopPriceDisplayDeps,
	modeOf: (saved: TaxSettings) => ShopTaxDisplay | undefined,
): Promise<ShopPriceDisplay> {
	const saved = deps.settings === undefined ? undefined : (await deps.settings.get()).tax;
	const mode = saved === undefined ? undefined : modeOf(saved);
	if (saved === undefined || mode === undefined) return SHOP_PRICE_AS_ENTERED;
	if (!saved.enabled || deps.hasOutsideTaxCalculator) return SHOP_PRICE_AS_ENTERED;
	const base = saved.baseAddress;
	if (base === null) return SHOP_PRICE_AS_ENTERED;
	const zone = resolveShippingZone(await deps.shippingRules.listZones(), {
		requiresShipping: true,
		destination: { country: base.country, region: base.region },
	});
	const ratesByClass: Record<TaxClassId, number> = {};
	const ratesPpmByClass: Record<TaxClassId, number> = {};
	if (zone.status === "matched") {
		// The zone's rates exactly as checkout reads them (duplicates reduced the same way).
		const table = rateTableOf(await deps.taxRules.listRatesForZone(zone.zoneId));
		for (const [classId, bps] of table.ratesByClass) {
			Object.defineProperty(ratesByClass, classId, {
				value: bps,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		for (const [classId, ppm] of table.ratesPpmByClass ?? []) {
			Object.defineProperty(ratesPpmByClass, classId, {
				value: ppm,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return {
		mode,
		pricesIncludeTax: saved.pricesIncludeTax,
		roundAtSubtotal: saved.roundAtSubtotal,
		ratesByClass,
		ratesPpmByClass,
	};
}
