import type { Cents, Currency } from "../money/cents.js";
import type { ShippingMethodType } from "../pricing/types.js";

/**
 * `ShippingRulesStore` (Phase 6 §6) — zone → method → flat rate config, plus the
 * checkout-time read the totals pipeline needs. All config data; the pure engine
 * (`resolveShippingRate`) never touches this store.
 *
 * Admin CRUD (create/list/get) mirrors the REST surface 1:1; `getRate` /
 * `resolveMethod` are the checkout reads.
 */
export interface ShippingRulesStore {
	createZone(input: CreateShippingZoneInput): Promise<ShippingZone>;
	listZones(): Promise<ShippingZone[]>;
	getZone(zoneId: string): Promise<ShippingZone | null>;

	createMethod(input: CreateShippingMethodInput): Promise<ShippingMethod>;
	listMethods(zoneId: string): Promise<ShippingMethod[]>;
	getMethod(methodId: string): Promise<ShippingMethod | null>;

	createRate(input: CreateShippingRateInput): Promise<ShippingRate>;
	/** The rate for a method in a currency, or null. */
	getRate(methodId: string, currency: Currency): Promise<ShippingRate | null>;
}

export interface ShippingZone {
	id: string;
	name: string;
	/** Country/state/postal match list — opaque config the engine never reads. */
	regions: unknown;
}

export interface CreateShippingZoneInput {
	id: string;
	name: string;
	regions: unknown;
}

export interface ShippingMethod {
	id: string;
	zoneId: string;
	name: string;
	type: ShippingMethodType;
}

export interface CreateShippingMethodInput {
	id: string;
	zoneId: string;
	name: string;
	type: ShippingMethodType;
}

export interface ShippingRate {
	methodId: string;
	currency: Currency;
	amountCents: Cents;
	/** Free-shipping threshold; null = none. */
	minSubtotalCents: Cents | null;
}

export interface CreateShippingRateInput {
	methodId: string;
	currency: Currency;
	amountCents: Cents;
	minSubtotalCents: Cents | null;
}
