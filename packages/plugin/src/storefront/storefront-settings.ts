/**
 * The settings facts a storefront page renders from: ONE read for the
 * storefront-settings facts (saved currency, hold window, timer flag). A page's
 * price display reads the settings separately (`getShopPriceDisplay`).
 * {@link readStorefrontSettings} is display-only: a busy or failed read answers
 * the defaults below instead of failing the page, so the page renders with the
 * timer hidden rather than failing. Only the product page (`pdp-route.ts`)
 * degrades this way now; /cart and /checkout read the settings with the cart
 * (`getCartWithSettings`), and an unreadable document fails those renders.
 */
import { DEFAULT_OPERATIONAL_SETTINGS } from "@urumi.ai/otta-domain";
import type { CommerceClient, StorefrontSettings } from "../product-commerce/commerce-client.js";

/** What a page falls back to when the settings read fails. */
export const DEFAULT_STOREFRONT_SETTINGS: StorefrontSettings = Object.freeze({
	savedStoreCurrency: null,
	holdTtlMinutes: DEFAULT_OPERATIONAL_SETTINGS.holdTtlMinutes,
	showHoldTimer: false,
});

export async function readStorefrontSettings(
	route: string,
	client: Pick<CommerceClient, "getStorefrontSettings">,
): Promise<StorefrontSettings> {
	try {
		return await client.getStorefrontSettings();
	} catch (err) {
		console.error(`[otta] ${route} settings read failed; using defaults:`, err);
		return DEFAULT_STOREFRONT_SETTINGS;
	}
}
