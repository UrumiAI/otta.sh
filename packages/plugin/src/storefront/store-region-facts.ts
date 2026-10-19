/**
 * What the checkout review needs to know about where the STORE is and how its
 * zones use regions — codes only, each fact read LAZILY and at most once per
 * render, so a review pays only for what it shows:
 *
 *  - `regionCountries` (one `listZones`): countries ANY zone lists at region
 *    level (`ES-CN` ⇒ `ES`). The domain refuses a blank region for exactly these
 *    (`SHIPPING_REGION_CODE_REQUIRED`), so the delivery block marks the
 *    state/province REQUIRED for them. It is satisfied by a subdivision at or
 *    inside a zoned one (`ES-TF` in `ES-CN` matches through containment), or
 *    one no zone touches; a pick CONTAINING a zoned one is asked again.
 *  - `storeCountry` (settings, zones and one `listMethods` a zone — only on a
 *    FRESH visit, the one time the review preselects): the country the review
 *    preselects so its state/province list renders on first load with no JS —
 *    always one the store ships to: the tax options' base country when a zone
 *    with methods serves it, else the first such zone's country (store order),
 *    else none.
 *  - `baseCountry` (settings): for an address-only (billing) page, the base
 *    country only.
 *  - `regionZoneCountries` (as `storeCountry` — only on a
 *    SHIPPING_ZONE_NOT_MATCHED refusal with a region): countries some zone WITH
 *    SHIPPING METHODS lists at REGION level. Such a refusal is for the STATE:
 *    other states of that country are shipped to. A region-level zone with no
 *    methods (one that only carries a tax rate) ships nowhere, so it never makes
 *    a refusal about the state.
 *
 * A failed read only costs a preselect, a blame or a `required` attribute —
 * never the review — so every fact degrades to "nothing known".
 */
import { parseZoneRegions, type ShippingZone } from "@urumi-ai/otta-domain";
import { createInProcessCommerceStores } from "../commerce/in-process-commerce-stores.js";
import type { PluginContext } from "../types.js";

export interface StoreRegionFacts {
	regionCountries(): Promise<ReadonlySet<string>>;
	/** For the DELIVERY block: a country the store ships to (see above). */
	storeCountry(): Promise<string | null>;
	/** For an address-only page (billing): the tax options' base country, or none. */
	baseCountry(): Promise<string | null>;
	regionZoneCountries(): Promise<ReadonlySet<string>>;
}

function once<T>(read: () => Promise<T>, fallback: T): () => Promise<T> {
	let memo: Promise<T> | undefined;
	return () => (memo ??= read().catch(() => fallback));
}

/** The countries of every REGION-level code (`ES-CN` ⇒ `ES`). */
function countriesOf(codes: readonly string[][]): ReadonlySet<string> {
	return new Set(codes.flat().flatMap((code) => (code.includes("-") ? [code.slice(0, 2)] : [])));
}

export function storeRegionFacts(ctx: PluginContext): StoreRegionFacts {
	// Built on the first read, INSIDE a guarded read, so a failure building them
	// degrades like any other failed read instead of escaping (#478).
	let built: ReturnType<typeof createInProcessCommerceStores> | undefined;
	const stores = (): ReturnType<typeof createInProcessCommerceStores> =>
		(built ??= createInProcessCommerceStores(ctx));
	const zones = once<readonly ShippingZone[]>(async () => stores().shippingRules.listZones(), []);
	const baseCountry = once(
		async () => (await stores().settingsStore.get()).tax?.baseAddress?.country ?? null,
		null,
	);
	// Each SHIPPING zone's codes (one with a method) — one read a zone, store order.
	const shippingZoneCodes = once(async () => {
		const read = await Promise.all(
			(await zones()).map(async (zone) => ({
				codes: parseZoneRegions(zone.regions).codes,
				ships: (await stores().shippingRules.listMethods(zone.id)).length > 0,
			})),
		);
		return read.filter((zone) => zone.ships).map((zone) => zone.codes);
	}, []);
	return {
		regionCountries: once(
			async () => countriesOf((await zones()).map((zone) => parseZoneRegions(zone.regions).codes)),
			new Set<string>(),
		),
		storeCountry: once(async () => {
			const shipped = [...new Set((await shippingZoneCodes()).flat().map((c) => c.slice(0, 2)))];
			const base = await baseCountry();
			// Its own base country when a shipping zone serves it, else the first
			// shipping zone's; else none — never a country the delivery block refuses.
			return base !== null && shipped.includes(base) ? base : (shipped[0] ?? null);
		}, null),
		baseCountry,
		regionZoneCountries: once(
			async () => countriesOf(await shippingZoneCodes()),
			new Set<string>(),
		),
	};
}
