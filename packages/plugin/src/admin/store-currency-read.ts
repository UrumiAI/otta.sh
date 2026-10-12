import type { AdminRulesSurface } from "./admin-rules-surface.js";

/**
 * The store currency for an admin screen's DEFAULTS (the shipping filter, the
 * coupon form's hint) — a SECONDARY read: a failure is logged and answered
 * `undefined`, never thrown, so the screen still renders. The caller decides
 * what "unknown" means for it; it must never be silently "USD" where the value
 * would be SAVED (a new rate's currency), only where it is shown.
 */
export async function readStoreCurrencySoft(
	client: Pick<AdminRulesSurface, "getStoreCurrency">,
	screen: string,
): Promise<string | undefined> {
	try {
		return await client.getStoreCurrency();
	} catch (err) {
		console.error(`[otta] admin ${screen} store-currency read failed:`, err);
		return undefined;
	}
}
