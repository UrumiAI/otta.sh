import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import type { ShippingRulesStore } from "../ports/shipping-rules-store.js";

export interface ShippingRulesStoreHarness {
	store: ShippingRulesStore;
}

export interface ShippingRulesStoreContractOptions {
	dialect: string;
}

const USD = currency("USD");
const EUR = currency("EUR");

/** Behavioral spec for every `ShippingRulesStore` adapter (Phase 6 §6). */
export function shippingRulesStoreContract(
	makeStore: () => Promise<ShippingRulesStoreHarness>,
	opts: ShippingRulesStoreContractOptions,
): void {
	describe(`shippingRulesStoreContract [${opts.dialect}]`, () => {
		test("create + list + get zones", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: ["US"] });
			await store.createZone({ id: "z-eu", name: "EU", regions: ["FR", "DE"] });
			const zones = await store.listZones();
			expect(zones.map((z) => z.id).toSorted()).toEqual(["z-eu", "z-us"]);
			expect((await store.getZone("z-us"))?.name).toBe("US");
			expect(await store.getZone("missing")).toBeNull();
		});

		test("create + list methods scoped to a zone", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: null });
			await store.createZone({ id: "z-eu", name: "EU", regions: null });
			await store.createMethod({ id: "m-flat", zoneId: "z-us", name: "Flat", type: "flat_rate" });
			await store.createMethod({
				id: "m-free",
				zoneId: "z-us",
				name: "Free",
				type: "free_shipping",
			});
			await store.createMethod({ id: "m-eu", zoneId: "z-eu", name: "EU", type: "flat_rate" });
			const methods = await store.listMethods("z-us");
			expect(methods.map((m) => m.id).toSorted()).toEqual(["m-flat", "m-free"]);
			expect((await store.getMethod("m-free"))?.type).toBe("free_shipping");
		});

		test("getRate returns the rate for a method+currency, null otherwise", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: null });
			await store.createMethod({ id: "m-flat", zoneId: "z-us", name: "Flat", type: "flat_rate" });
			await store.createRate({
				methodId: "m-flat",
				currency: USD,
				amountCents: cents(599),
				minSubtotalCents: null,
			});
			const rate = await store.getRate("m-flat", USD);
			expect(rate?.amountCents).toBe(599);
			expect(rate?.minSubtotalCents).toBeNull();
			expect(await store.getRate("m-flat", EUR)).toBeNull();
			expect(await store.getRate("missing", USD)).toBeNull();
		});

		test("free_shipping rate carries a nullable min-subtotal threshold", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: null });
			await store.createMethod({
				id: "m-free",
				zoneId: "z-us",
				name: "Free",
				type: "free_shipping",
			});
			await store.createRate({
				methodId: "m-free",
				currency: USD,
				amountCents: cents(0),
				minSubtotalCents: cents(50_00),
			});
			expect((await store.getRate("m-free", USD))?.minSubtotalCents).toBe(50_00);
		});
	});
}
