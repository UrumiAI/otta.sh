/**
 * `storeRegionFacts` (#478): every fact degrades to "nothing known" when its read
 * fails — including when the stores themselves cannot be built, which must
 * happen inside the guarded read, not when the facts are created.
 */
import { describe, expect, test, vi } from "vitest";

const build = vi.hoisted(() => vi.fn());
vi.mock("../src/commerce/in-process-commerce-stores.js", () => ({
	createInProcessCommerceStores: build,
}));

import { storeRegionFacts } from "../src/storefront/store-region-facts.js";
import type { PluginContext } from "../src/types.js";

const ctx = { kv: {}, http: {} } as unknown as PluginContext;

describe("storeRegionFacts", () => {
	test("a failure building the stores degrades every fact, never escapes", async () => {
		build.mockReset();
		build.mockImplementation(() => {
			throw new Error("storage collection missing");
		});
		const facts = storeRegionFacts(ctx);
		expect(build).not.toHaveBeenCalled();
		expect(await facts.regionCountries()).toEqual(new Set());
		expect(await facts.storeCountry()).toBeNull();
		expect(await facts.baseCountry()).toBeNull();
		expect(await facts.regionZoneCountries()).toEqual(new Set());
	});

	test("the stores are built once, on the first fact read", async () => {
		build.mockReset();
		build.mockReturnValue({
			shippingRules: {
				listZones: async () => [{ id: "z1", regions: ["ES-CN"] }],
				listMethods: async () => [{ id: "m1" }],
			},
			settingsStore: { get: async () => ({ tax: { baseAddress: { country: "ES" } } }) },
		});
		const facts = storeRegionFacts(ctx);
		expect(build).not.toHaveBeenCalled();
		expect(await facts.regionCountries()).toEqual(new Set(["ES"]));
		expect(await facts.storeCountry()).toBe("ES");
		expect(build).toHaveBeenCalledTimes(1);
	});
});
