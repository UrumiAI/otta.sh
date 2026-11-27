/**
 * #744: `EmdashTaxRulesStore.listRatesForClass` — every rate of one class,
 * whatever zone it names, so the admin surface can show (and delete) a rate whose
 * zone no longer exists. An adapter read, not a `TaxRulesStore` port method: only
 * the plugin's admin surface needs it, and the port stays unchanged. Shared by
 * the sqlite/pg tier (`tax-rates-for-class.dialects.test.ts`) and the D1 tier
 * (`d1/tax-rates-for-class.d1.spec.ts`).
 */
import { expect, test } from "vitest";
import type { StorageAccess } from "../src/index.js";
import { makeTaxRulesHarness } from "./rules-harness.js";

/** A store's storage binding, resolved lazily (it opens in a `beforeAll`). */
export interface BoundStorage {
	readonly storage: StorageAccess;
}

export function taxRatesForClassCases(bound: BoundStorage): void {
	test("lists every rate of the class across zones, by id, and [] otherwise", async () => {
		const { store } = makeTaxRulesHarness(bound.storage);
		await store.createClass({ id: "standard", name: "Standard" });
		await store.createRate({
			id: "r2",
			taxClassId: "standard",
			zoneId: "z-gone",
			rateBps: 2000,
			appliesToShipping: true,
		});
		await store.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});
		await store.createRate({
			id: "r3",
			taxClassId: "zero",
			zoneId: "z-us",
			rateBps: 0,
			appliesToShipping: false,
		});

		const rates = await store.listRatesForClass("standard");
		expect(rates).toEqual([
			{ id: "r1", taxClassId: "standard", zoneId: "z-us", rateBps: 725, appliesToShipping: false },
			{
				id: "r2",
				taxClassId: "standard",
				zoneId: "z-gone",
				rateBps: 2000,
				appliesToShipping: true,
			},
		]);
		// The list and the delete refusal's count agree.
		expect(await store.countRatesByClass("standard")).toBe(rates.length);
		// A class never declared still lists the rates naming it; none lists nothing.
		expect((await store.listRatesForClass("zero")).map((r) => r.id)).toEqual(["r3"]);
		expect(await store.listRatesForClass("missing")).toEqual([]);
		// A deleted rate leaves the list.
		expect(await store.deleteRate("r2")).toEqual({ ok: true });
		expect((await store.listRatesForClass("standard")).map((r) => r.id)).toEqual(["r1"]);
	});
}
