/**
 * `storefront/checkout/region-rules` — which countries' addresses need a
 * state/province: those some zone lists a subdivision code for (`US-CA` ⇒
 * `US`). Zones carry both the shipping methods and the tax rates, so a store
 * that ships or taxes a country by region uses regions for it, and the review
 * must not place an address there without one. Anywhere else the region is
 * optional.
 *
 * One zone-registry read and nothing else: no cart, no kv, no gateway. It
 * answers country codes only — never a zone id, name or rate.
 */
import { countriesUsingRegions } from "@otta-sh/domain";
import { createInProcessCommerceStores } from "../commerce/in-process-commerce-stores.js";
import type { RouteHandler } from "../types.js";
import { renderGuard, type RenderGuardFailure } from "./pdp-route.js";

export const STOREFRONT_REGION_RULES_ROUTE = "storefront/checkout/region-rules";

export type RegionRulesResult =
	| { ok: true; regionRequiredCountries: string[] }
	| RenderGuardFailure;

export function createRegionRulesHandler(): RouteHandler<unknown> {
	return (_routeCtx, ctx): Promise<RegionRulesResult> =>
		renderGuard(STOREFRONT_REGION_RULES_ROUTE, async () => {
			const zones = await createInProcessCommerceStores(ctx).shippingRules.listZones();
			return { ok: true as const, regionRequiredCountries: countriesUsingRegions(zones) };
		});
}
