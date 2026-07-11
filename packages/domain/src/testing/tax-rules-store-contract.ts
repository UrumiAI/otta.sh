import { describe, expect, test } from "vitest";
import type { TaxRulesStore } from "../ports/tax-rules-store.js";

export interface TaxRulesStoreHarness {
	store: TaxRulesStore;
}

export interface TaxRulesStoreContractOptions {
	dialect: string;
}

/** Behavioral spec for every `TaxRulesStore` adapter (Phase 6 §6). */
export function taxRulesStoreContract(
	makeStore: () => Promise<TaxRulesStoreHarness>,
	opts: TaxRulesStoreContractOptions,
): void {
	describe(`taxRulesStoreContract [${opts.dialect}]`, () => {
		test("create + list tax classes", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			await store.createClass({ id: "zero", name: "Zero-rated" });
			const classes = await store.listClasses();
			expect(classes.map((c) => c.id).toSorted()).toEqual(["standard", "zero"]);
		});

		test("getRate returns the (class, zone) rate in integer bps, null otherwise", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			await store.createRate({
				id: "r1",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 725,
				appliesToShipping: false,
			});
			const rate = await store.getRate("standard", "z-us");
			expect(rate?.rateBps).toBe(725);
			expect(rate?.appliesToShipping).toBe(false);
			expect(await store.getRate("standard", "z-eu")).toBeNull();
			expect(await store.getRate("reduced", "z-us")).toBeNull();
		});

		test("listRatesForZone returns every class's rate and marks the shipping-tax class", async () => {
			const { store } = await makeStore();
			await store.createRate({
				id: "r1",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 1000,
				appliesToShipping: true,
			});
			await store.createRate({
				id: "r2",
				taxClassId: "zero",
				zoneId: "z-us",
				rateBps: 0,
				appliesToShipping: false,
			});
			await store.createRate({
				id: "r3",
				taxClassId: "standard",
				zoneId: "z-eu",
				rateBps: 2000,
				appliesToShipping: false,
			});
			const rates = await store.listRatesForZone("z-us");
			expect(rates.map((r) => r.taxClassId).toSorted()).toEqual(["standard", "zero"]);
			const shippingClass = rates.find((r) => r.appliesToShipping);
			expect(shippingClass?.taxClassId).toBe("standard");
		});
	});
}
