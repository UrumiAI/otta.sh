import { beforeEach, describe, expect, test } from "vitest";
import { deleteShippingZone } from "../src/pricing/delete-shipping-zone.js";
import { InMemoryShippingRulesStore } from "../src/testing/in-memory-shipping-rules-store.js";
import { InMemoryTaxRulesStore } from "../src/testing/in-memory-tax-rules-store.js";

/**
 * `deleteShippingZone` (#741) — a zone is the referent of two things that live in
 * different store aggregates: its shipping methods (embedded, guarded atomically
 * by `ShippingRulesStore.deleteZone`) and the tax rates that name it
 * (`TaxRate.zoneId`, held by the tax store). Deleting a zone a tax rate still
 * names used to succeed and leave the rate behind with no zone, unlistable and
 * blocking its class's delete. The guard is composed here so every caller of the
 * use-case is protected.
 */
describe("deleteShippingZone (delete-in-use guard over the in-memory fakes)", () => {
	let shippingRules: InMemoryShippingRulesStore;
	let taxRules: InMemoryTaxRulesStore;

	beforeEach(async () => {
		shippingRules = new InMemoryShippingRulesStore();
		taxRules = new InMemoryTaxRulesStore();
		await shippingRules.createZone({ id: "z-us", name: "US", regions: ["US"] });
		await shippingRules.createZone({ id: "z-eu", name: "EU", regions: ["FR"] });
		await taxRules.createClass({ id: "standard", name: "Standard" });
		await taxRules.createClass({ id: "reduced", name: "Reduced" });
	});

	const rate = (id: string, zoneId: string, taxClassId = "standard") =>
		taxRules.createRate({ id, taxClassId, zoneId, rateBps: 725, appliesToShipping: false });

	test("deletes a zone with no methods and no tax rates", async () => {
		expect(await deleteShippingZone({ shippingRules, taxRules }, "z-us")).toEqual({ ok: true });
		expect(await shippingRules.getZone("z-us")).toBeNull();
	});

	test("not_found for an unknown zone", async () => {
		expect(await deleteShippingZone({ shippingRules, taxRules }, "nope")).toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	test("refuses a zone a tax rate still names (in_use_by_tax_rates), writing nothing", async () => {
		await rate("r1", "z-us");
		expect(await deleteShippingZone({ shippingRules, taxRules }, "z-us")).toEqual({
			ok: false,
			reason: "in_use_by_tax_rates",
			count: 1,
		});
		// Nothing was written: the zone and its rate both survive.
		expect(await shippingRules.getZone("z-us")).not.toBeNull();
		expect((await taxRules.listRatesForZone("z-us")).map((r) => r.id)).toEqual(["r1"]);
	});

	test("in_use_by_tax_rates carries every rate in the zone, across classes", async () => {
		await rate("r1", "z-us", "standard");
		await rate("r2", "z-us", "reduced");
		await rate("r3", "z-eu", "standard");
		expect(await deleteShippingZone({ shippingRules, taxRules }, "z-us")).toEqual({
			ok: false,
			reason: "in_use_by_tax_rates",
			count: 2,
		});
	});

	test("a rate in ANOTHER zone does not block the delete", async () => {
		await rate("r-eu", "z-eu");
		expect(await deleteShippingZone({ shippingRules, taxRules }, "z-us")).toEqual({ ok: true });
	});

	test("still refuses a zone with shipping methods (in_use_by_methods)", async () => {
		await shippingRules.createMethod({ id: "m1", zoneId: "z-us", name: "Flat", type: "flat_rate" });
		expect(await deleteShippingZone({ shippingRules, taxRules }, "z-us")).toEqual({
			ok: false,
			reason: "in_use_by_methods",
		});
		expect(await shippingRules.getZone("z-us")).not.toBeNull();
	});

	test("once the zone's tax rates are deleted, the zone deletes", async () => {
		await rate("r1", "z-us");
		await taxRules.deleteRate("r1");
		expect(await deleteShippingZone({ shippingRules, taxRules }, "z-us")).toEqual({ ok: true });
	});

	test("a zone already gone stays not_found even when a rate left over from before the guard names it", async () => {
		// The state #741 left behind: a rate naming a zone that no longer exists. A
		// replayed delete of that zone is the idempotent no-op, not an in-use refusal.
		await rate("r-orphan", "z-gone");
		expect(await deleteShippingZone({ shippingRules, taxRules }, "z-gone")).toEqual({
			ok: false,
			reason: "not_found",
		});
	});
});
