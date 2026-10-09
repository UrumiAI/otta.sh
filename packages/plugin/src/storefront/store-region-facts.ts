/**
 * What the checkout review needs to know about where the STORE is and how its
 * zones use regions — read once per review render, codes only:
 *
 *  - `storeCountry`: the country the review preselects for a buyer who has not
 *    chosen one, so its state/province list renders on first load with no JS.
 *    The tax options' base address country if set; else the country of the
 *    first zone's first code (zones in store order); else none.
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
	storeCountry: string | null;
	regionZoneCountries: ReadonlySet<string>;
}

export async function readStoreRegionFacts(ctx: PluginContext): Promise<StoreRegionFacts> {
	const stores = createInProcessCommerceStores(ctx);
	const [settings, zones] = await Promise.all([
		stores.settingsStore.get(),
		stores.shippingRules.listZones(),
	]);
	const regionZoneCountries = new Set<string>();
	let firstZoneCountry: string | null = null;
	const regionZones: Array<{ id: string; countries: string[] }> = [];
	for (const zone of zones) {
		const countries: string[] = [];
		for (const code of parseZoneRegions(zone.regions).codes) {
			const country = code.slice(0, 2);
			firstZoneCountry ??= country;
			if (code.includes("-")) countries.push(country);
		}
		if (countries.length > 0) regionZones.push({ id: zone.id, countries });
	}
	// Only the region-level zones are asked for their methods: one read each.
	const shipping = await Promise.all(
		regionZones.map(async (zone) => ({
			...zone,
			ships: (await stores.shippingRules.listMethods(zone.id)).length > 0,
		})),
	);
	for (const zone of shipping) {
		if (zone.ships) for (const country of zone.countries) regionZoneCountries.add(country);
	}
	return {
		storeCountry: settings.tax?.baseAddress?.country ?? firstZoneCountry,
		regionZoneCountries,
	};
}
