/**
 * The wiring every shipping/tax rules suite shares: real stores over real plugin
 * storage repositories, plus the raw collections the assertions the ports cannot
 * express are made against (an orphaned id claim, a class document holding rates
 * for a class nobody declared).
 *
 * There is no seeding surface here, and deliberately so: both contracts build
 * their state through the ports, so a fixture that wrote documents directly
 * could never drift from what the stores really produce.
 */
import { FixedClock } from "@otta-sh/domain/testing";
import type { ShippingRulesStoreHarness, TaxRulesStoreHarness } from "@otta-sh/domain/testing";
import {
	collectionOf,
	EmdashShippingRulesStore,
	EmdashTaxRulesStore,
	SHIPPING_METHOD_OWNERS_COLLECTION,
	SHIPPING_ZONES_COLLECTION,
	TAX_CLASSES_COLLECTION,
	TAX_RATE_OWNERS_COLLECTION,
	type ShippingMethodOwnerDoc,
	type ShippingZoneDoc,
	type StorageAccess,
	type StorageCollection,
	type TaxClassDoc,
	type TaxRateOwnerDoc,
} from "../src/index.js";

/** The epoch every rules suite starts from. */
export const RULES_EPOCH = new Date("2026-07-10T00:00:00.000Z");

export interface RulesHarnessOptions {
	/** Override the compare-and-set ceiling (the race suites measure the depth). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Page ceiling for the bounded scans. */
	maxListPages?: number;
	/** Wrap the storage the STORE writes through (fault injection). */
	storageForStore?: StorageAccess;
	/** Reuse another harness's clock, so a fault-injected twin shares its time. */
	clock?: FixedClock;
}

export interface ShippingRulesHarness extends ShippingRulesStoreHarness {
	readonly clock: FixedClock;
	readonly store: EmdashShippingRulesStore;
	/** The zone documents, for the assertions the port cannot express. */
	readonly zones: StorageCollection<ShippingZoneDoc>;
	/** The method-id claims — where an orphan is visible. */
	readonly methodOwners: StorageCollection<ShippingMethodOwnerDoc>;
}

export interface TaxRulesHarness extends TaxRulesStoreHarness {
	readonly clock: FixedClock;
	readonly store: EmdashTaxRulesStore;
	/** The class documents, including the ones holding rates for undeclared classes. */
	readonly classes: StorageCollection<TaxClassDoc>;
	/** The rate-id claims — where an orphan is visible. */
	readonly rateOwners: StorageCollection<TaxRateOwnerDoc>;
}

/** Build a shipping-rules harness over an already-bound `StorageAccess`. */
export function makeShippingRulesHarness(
	storage: StorageAccess,
	options: RulesHarnessOptions = {},
): ShippingRulesHarness {
	const clock = options.clock ?? new FixedClock(new Date(RULES_EPOCH.getTime()));
	const store = new EmdashShippingRulesStore({
		storage: options.storageForStore ?? storage,
		clock,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
		maxListPages: options.maxListPages,
	});
	// The RAW collections, deliberately unwrapped by any fault injection: an
	// assertion about what landed must read what the host really holds.
	return {
		clock,
		store,
		zones: collectionOf<ShippingZoneDoc>(storage, SHIPPING_ZONES_COLLECTION),
		methodOwners: collectionOf<ShippingMethodOwnerDoc>(storage, SHIPPING_METHOD_OWNERS_COLLECTION),
	};
}

/** Build a tax-rules harness over an already-bound `StorageAccess`. */
export function makeTaxRulesHarness(
	storage: StorageAccess,
	options: RulesHarnessOptions = {},
): TaxRulesHarness {
	const clock = options.clock ?? new FixedClock(new Date(RULES_EPOCH.getTime()));
	const store = new EmdashTaxRulesStore({
		storage: options.storageForStore ?? storage,
		clock,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
		maxListPages: options.maxListPages,
	});
	return {
		clock,
		store,
		classes: collectionOf<TaxClassDoc>(storage, TAX_CLASSES_COLLECTION),
		rateOwners: collectionOf<TaxRateOwnerDoc>(storage, TAX_RATE_OWNERS_COLLECTION),
	};
}
