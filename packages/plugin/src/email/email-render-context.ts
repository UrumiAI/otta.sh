/**
 * What the email renderer needs from the plugin beyond a template's data (QA U-3):
 * the storefront's money formatter, the store's name and the storefront's
 * public address. The domain renders (`renderEmail`); this module decides what
 * it renders WITH, so an email states money and links exactly as the
 * storefront does.
 */
import { cents, currency, formatMoney } from "@otta-sh/admin-presentation";
import { DEFAULT_LOCALE } from "../storefront/route-input.js";
import { isValidLoginLinkUrl } from "../storefront/login-link.js";

/**
 * Money in an email, formatted by the storefront's own formatter at the
 * storefront's locale (`DEFAULT_LOCALE`, which is what the site's `SITE_LOCALE`
 * resolves to): "$100.00", "₹1,234.50", "¥1,500". `null` when the amount or
 * the currency code cannot be formatted — the renderer then leaves the figure
 * out rather than print raw minor units.
 */
export function storefrontEmailMoney(minorUnits: number, currencyCode: string): string | null {
	try {
		return formatMoney(cents(minorUnits), currency(currencyCode), DEFAULT_LOCALE);
	} catch {
		return null;
	}
}

/**
 * The storefront's public origin, from the operator's configured sign-in page
 * (`settings:loginLinkUrl`, e.g. `https://shop.example/account/verify`).
 *
 * WHY THAT SETTING. It is the one place the operator already states the
 * storefront's public address, it is validated on save and on use
 * (`isValidLoginLinkUrl`: absolute http(s), no credentials), and the storefront
 * serves every page from its origin's root (`/account/verify`, `/orders/<id>`).
 * NEVER a request's `Host`: an order email can be sent from a webhook, an admin
 * action or the cron, none of which knows the shopper's storefront, and a
 * forged `Host` must not be able to point a buyer's email at another site.
 * `undefined` (no link in the email) when the setting is unset or invalid.
 */
export function storefrontOriginOf(signInPageUrl: string | undefined): string | undefined {
	if (signInPageUrl === undefined || !isValidLoginLinkUrl(signInPageUrl)) return undefined;
	return new URL(signInPageUrl).origin;
}

/**
 * The order's page on the storefront: `<origin>/orders/<id>` — the SAME URL the
 * shopper is sent to after checkout (`checkout/place.ts`, and the payment
 * return URL in `checkout/pay.astro`), id encoded the same way. It is a bearer
 * link: whoever holds it can read the order's public view (no address, no
 * email). It goes only to the order's own recipient, as the checkout redirect
 * already does.
 */
export function orderPageUrl(storefrontOrigin: string, orderId: string): string {
	return new URL(`/orders/${encodeURIComponent(orderId)}`, storefrontOrigin).toString();
}

/** The kv key for the store's name ("Store display name" in Settings). Lives
 *  here rather than in the Settings form, which re-exports it, so the email
 *  sender can read it without importing the admin UI. */
export const STORE_DISPLAY_NAME_KEY = "settings:storeDisplayName";

/** The longest store name the Settings save accepts (`DISPLAY_NAME_MAX`). */
const STORE_NAME_MAX = 200;

/** The stored "Store display name", or `undefined` when unset or not a usable
 *  name. The renderer escapes it and folds it onto one line. */
export function storeNameFrom(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim();
	return name.length > 0 && name.length <= STORE_NAME_MAX ? name : undefined;
}
