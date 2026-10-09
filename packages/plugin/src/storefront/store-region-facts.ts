/**
 * What the checkout review needs to know about where the STORE is and how its
 * zones use regions — read once per review render, codes only:
 *
 *  - `storeCountry`: the country the review preselects on a fresh visit, so its
 *    state/province list renders on first load with no JS — always one the
 *    store ships to: the tax options' base country when a zone with methods
 *    serves it, else the first such zone's country (store order), else none.
 *  - `baseCountry`: for an address-only (billing) page, the base country only.
 *  - `regionZoneCountries`: countries some zone WITH SHIPPING METHODS lists at
 *    REGION level (`US-CA` ⇒ `US`). A destination refused
 *    SHIPPING_ZONE_NOT_MATCHED in such a country, with a region given, is
 *    refused for its STATE: other states of that country are shipped to. A
 *    region-level zone with no methods (one that only carries a tax rate)
 *    ships nowhere, so it never makes a refusal about the state.
 */
import { parseZoneRegions } from "@otta-sh/domain";
import { createInProcessCommerceStores } from "../commerce/in-process-commerce-stores.js";
import type { PluginContext } from "../types.js";

export interface StoreRegionFacts {
	/** For the DELIVERY block: a country the store ships to (see below). */
	storeCountry: string | null;
	/** For an address-only page (billing): the tax options' base country, or none. */
	baseCountry: string | null;
	regionZoneCountries: ReadonlySet<string>;
}

export async function readStoreRegionFacts(ctx: PluginContext): Promise<StoreRegionFacts> {
	const stores = createInProcessCommerceStores(ctx);
	const [settings, zones] = await Promise.all([
		stores.settingsStore.get(),
		stores.shippingRules.listZones(),
	]);
	// Each zone's codes, and whether it SHIPS (has a method) — one read a zone.
	const read = await Promise.all(
		zones.map(async (zone) => ({
			codes: parseZoneRegions(zone.regions).codes,
			ships: (await stores.shippingRules.listMethods(zone.id)).length > 0,
		})),
	);
	const regionZoneCountries = new Set<string>();
	const shippedCountries: string[] = [];
	for (const zone of read) {
		if (!zone.ships) continue;
		for (const code of zone.codes) {
			const country = code.slice(0, 2);
			if (!shippedCountries.includes(country)) shippedCountries.push(country);
			if (code.includes("-")) regionZoneCountries.add(country);
		}
	}
	const base = settings.tax?.baseAddress?.country ?? null;
	return {
		// A country the store SHIPS to: its own base country when a shipping zone
		// serves it, else the first shipping zone's; else none — never a country
		// the delivery block would refuse.
		storeCountry:
			base !== null && shippedCountries.includes(base) ? base : (shippedCountries[0] ?? null),
		baseCountry: base,
		regionZoneCountries,
	};
}
