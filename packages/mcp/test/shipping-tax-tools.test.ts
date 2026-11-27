/**
 * The shipping and tax WRITE tools, driven through `withMcp`'s routes over a real
 * SQLite document store. Zones, rates and the tax options go through the plugin's
 * admin OPERATIONS (`createZone`, `updateZone`, `upsertRate`, `updateTaxSettings`),
 * which own the guards (regions, first zone, flat-rate threshold); methods, tax
 * classes and tax rates have no rule above the surface and call it directly.
 * These cases pin how each outcome reaches an agent: success data, or a
 * `ToolError` with a stable code.
 */
import { cents, currency as toCurrency } from "@urumi.ai/otta-domain";
import { createOttaPlugin } from "@urumi.ai/otta-plugin";
import {
	EmdashShippingRulesStore,
	systemClock,
	TAX_CLASSES_COLLECTION,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { OTTA_MCP_TOOLS, withMcp, type McpRouteEntry } from "../src/index.js";
import { makeAdminHarness, type AdminHarness } from "./helpers/admin-harness.js";

let harness: AdminHarness;
let shippingRules: EmdashShippingRulesStore;
const plugin = withMcp(createOttaPlugin());

beforeAll(async () => {
	harness = await makeAdminHarness();
	const storage = harness.ctx.storage;
	if (storage === undefined) throw new Error("harness has no storage");
	shippingRules = new EmdashShippingRulesStore({ storage, clock: systemClock });
});
beforeEach(async () => {
	await harness.reset();
});
afterAll(async () => {
	expect(harness.egressAttempts()).toBe(0);
	await harness?.close();
});

async function call(name: string, input: unknown): Promise<any> {
	const route = plugin.routes[`mcp/${name}`] as McpRouteEntry | undefined;
	if (route === undefined) throw new Error(`no route mcp/${name}`);
	return route.handler(
		{ input, request: new Request("http://x"), user: { name: "Ada" } } as never,
		harness.ctx,
	);
}

async function failure(
	name: string,
	input: unknown,
): Promise<{ name: string; code: string; message: string; details?: any }> {
	try {
		await call(name, input);
	} catch (e) {
		return e as { name: string; code: string; message: string; details?: any };
	}
	throw new Error(`${name} did not fail`);
}

async function zones(): Promise<any[]> {
	return (await call("shipping_zones_list", {})).items;
}

/** A zone `id` covering `regions`, the first-zone warning acknowledged. */
async function seedZone(id: string, regions: string): Promise<void> {
	const out = await call("shipping_zone_create", {
		id,
		name: `Zone ${id}`,
		regions,
		acknowledgeFirstZone: true,
	});
	expect(out.status).toBe("created");
}

async function seedMethod(zoneId: string, id: string, type: string): Promise<void> {
	const out = await call("shipping_method_create", { zoneId, id, name: `Method ${id}`, type });
	expect(out.status).toBe("created");
}

const WRITE_TOOLS = [
	"shipping_zone_create",
	"shipping_zone_update",
	"shipping_zone_delete",
	"shipping_method_create",
	"shipping_method_update",
	"shipping_method_delete",
	"shipping_rate_set",
	"shipping_rate_delete",
	"tax_settings_update",
	"tax_class_create",
	"tax_class_update",
	"tax_class_delete",
	"tax_rate_create",
	"tax_rate_update",
	"tax_rate_delete",
];

test("the shipping and tax write tools are in the table; every delete is destructive", () => {
	const byName = new Map(OTTA_MCP_TOOLS.map((t) => [t.name, t]));
	for (const name of WRITE_TOOLS) expect(byName.has(name), name).toBe(true);
	const destructive = WRITE_TOOLS.filter((n) => byName.get(n)?.destructive === true);
	expect(destructive).toEqual(WRITE_TOOLS.filter((n) => n.endsWith("_delete")));
	// The legacy-threshold refusal is said up front, not discovered.
	expect(byName.get("shipping_rate_set")?.description).toMatch(/legacy/i);
});

describe("shipping_zone_create", () => {
	test("the first zone needs confirmation; nothing is written until it is acknowledged", async () => {
		const input = { id: "us", name: "United States", regions: "US" };
		expect(await call("shipping_zone_create", input)).toEqual({
			status: "needs_confirmation",
			message: expect.stringMatching(/first (shipping )?zone/i),
			retryWith: { acknowledgeFirstZone: true },
		});
		expect(await zones()).toEqual([]);
		const out = await call("shipping_zone_create", { ...input, acknowledgeFirstZone: true });
		expect(out).toEqual({
			status: "created",
			zone: { id: "us", name: "United States", regions: ["US"] },
		});
		// The second zone needs no acknowledgement.
		expect(
			(await call("shipping_zone_create", { id: "de", name: "Germany", regions: "de" })).status,
		).toBe("created");
	});

	test("an id defaults to a fresh one when omitted", async () => {
		const out = await call("shipping_zone_create", {
			name: "Canada",
			regions: "CA",
			acknowledgeFirstZone: true,
		});
		expect(out.status).toBe("created");
		expect(out.zone.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("a zone overlapping another is ZONE_REGION_OVERLAP with details.code; nothing is written", async () => {
		await seedZone("us", "US, CA");
		const err = await failure("shipping_zone_create", {
			id: "na",
			name: "North America",
			regions: "MX, ca",
		});
		expect(err.code).toBe("ZONE_REGION_OVERLAP");
		expect(err.details).toEqual({ code: "CA", zoneId: "us", zoneName: "Zone us" });
		expect((await zones()).map((z) => z.id)).toEqual(["us"]);
	});

	test("an invalid region is INVALID_REGION_CODES with details.invalid", async () => {
		const err = await failure("shipping_zone_create", {
			id: "eu",
			name: "Europe",
			regions: "DE, Narnia, US-ZZ",
			acknowledgeFirstZone: true,
		});
		expect(err.code).toBe("INVALID_REGION_CODES");
		expect(err.details).toEqual({ invalid: ["Narnia", "US-ZZ"] });
		expect(await zones()).toEqual([]);
	});

	test("a taken id is ZONE_ID_TAKEN", async () => {
		await seedZone("us", "US");
		const err = await failure("shipping_zone_create", { id: "us", name: "Again", regions: "" });
		expect(err.code).toBe("ZONE_ID_TAKEN");
	});

	test("a blank name is INVALID_INPUT", async () => {
		const err = await failure("shipping_zone_create", {
			id: "x",
			name: "   ",
			regions: "US",
			acknowledgeFirstZone: true,
		});
		expect(err.code).toBe("INVALID_INPUT");
	});
});

describe("shipping_zone_update", () => {
	test("a rename alone keeps the regions", async () => {
		await seedZone("us", "US, CA");
		const out = await call("shipping_zone_update", { zoneId: "us", name: "North" });
		expect(out).toEqual({
			status: "updated",
			zone: { id: "us", name: "North", regions: ["US", "CA"] },
		});
	});

	test("regions alone keep the name; an overlap is refused", async () => {
		await seedZone("us", "US");
		await seedZone("de", "DE");
		expect(await call("shipping_zone_update", { zoneId: "de", regions: "DE, AT" })).toEqual({
			status: "updated",
			zone: { id: "de", name: "Zone de", regions: ["DE", "AT"] },
		});
		const err = await failure("shipping_zone_update", { zoneId: "de", regions: "us" });
		expect(err.code).toBe("ZONE_REGION_OVERLAP");
		expect(err.details.code).toBe("US");
	});

	test("nothing to change is INVALID_INPUT; an unknown key is refused by name", async () => {
		await seedZone("us", "US");
		const empty = await failure("shipping_zone_update", { zoneId: "us" });
		expect(empty.code).toBe("INVALID_INPUT");
		expect(empty.message).toMatch(/nothing to change/i);
		const unknown = await failure("shipping_zone_update", { zoneId: "us", countries: "CA" });
		expect(unknown.code).toBe("INVALID_INPUT");
		expect(unknown.message).toMatch(/countries/);
	});

	test("an unknown zone is NOT_FOUND", async () => {
		const err = await failure("shipping_zone_update", { zoneId: "nope", name: "X" });
		expect(err.code).toBe("NOT_FOUND");
	});

	test("a rename of a zone with legacy free-text regions is LEGACY_ZONE_REGIONS", async () => {
		await shippingRules.createZone({ id: "old", name: "Old", regions: ["United States"] });
		const err = await failure("shipping_zone_update", { zoneId: "old", name: "Older" });
		expect(err.code).toBe("LEGACY_ZONE_REGIONS");
		expect(err.message).toMatch(/ISO codes/);
		// Re-entering them as codes works.
		expect(
			(await call("shipping_zone_update", { zoneId: "old", name: "Older", regions: "US" })).status,
		).toBe("updated");
	});
});

describe("shipping_zone_delete", () => {
	test("a zone with methods is ZONE_IN_USE; an empty one is deleted; again is NOT_FOUND", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "std", "flat_rate");
		expect((await failure("shipping_zone_delete", { zoneId: "us" })).code).toBe("ZONE_IN_USE");
		await call("shipping_method_delete", { methodId: "std" });
		expect(await call("shipping_zone_delete", { zoneId: "us" })).toEqual({ status: "deleted" });
		expect((await failure("shipping_zone_delete", { zoneId: "us" })).code).toBe("NOT_FOUND");
	});

	// #741: a zone a tax rate still names was deleted, leaving the rate behind with
	// no zone (unlistable, and blocking its class's delete).
	test("a zone a tax rate still names is ZONE_IN_USE, writing nothing; once the rate is gone it deletes", async () => {
		await seedZone("us", "US");
		await call("tax_class_create", { id: "standard", name: "Standard" });
		await call("tax_rate_create", {
			id: "us-std",
			taxClassId: "standard",
			zoneId: "us",
			rateBps: 725,
		});
		const refused = await failure("shipping_zone_delete", { zoneId: "us" });
		expect(refused.code).toBe("ZONE_IN_USE");
		expect(refused.message).toMatch(/tax_rate_delete/);
		// Nothing was written: the zone is still listed, and so is its rate.
		expect((await zones()).map((z) => z.id)).toContain("us");
		const rates = await call("tax_rates_list", { zoneId: "us" });
		expect(rates.items.map((r: { id: string }) => r.id)).toEqual(["us-std"]);

		await call("tax_rate_delete", { rateId: "us-std" });
		expect(await call("shipping_zone_delete", { zoneId: "us" })).toEqual({ status: "deleted" });
	});
});

describe("shipping methods", () => {
	test("create, a partial update that keeps the type, and delete", async () => {
		await seedZone("us", "US");
		expect(
			await call("shipping_method_create", {
				zoneId: "us",
				id: "std",
				name: "Standard",
				type: "flat_rate",
			}),
		).toEqual({
			status: "created",
			method: { id: "std", zoneId: "us", name: "Standard", type: "flat_rate", taxable: true },
		});
		const out = await call("shipping_method_update", {
			zoneId: "us",
			methodId: "std",
			name: "Ground",
		});
		expect(out).toEqual({
			status: "updated",
			method: { id: "std", zoneId: "us", name: "Ground", type: "flat_rate", taxable: true },
		});
		expect(await call("shipping_method_delete", { methodId: "std" })).toEqual({
			status: "deleted",
		});
	});

	test("an unknown type is INVALID_INPUT; an unknown zone is NOT_FOUND; a taken id is METHOD_ID_TAKEN", async () => {
		await seedZone("us", "US");
		expect(
			(
				await failure("shipping_method_create", {
					zoneId: "us",
					id: "x",
					name: "X",
					type: "teleport",
				})
			).code,
		).toBe("INVALID_INPUT");
		expect(
			(
				await failure("shipping_method_create", {
					zoneId: "mars",
					id: "x",
					name: "X",
					type: "flat_rate",
				})
			).code,
		).toBe("NOT_FOUND");
		await seedMethod("us", "std", "flat_rate");
		expect(
			(
				await failure("shipping_method_create", {
					zoneId: "us",
					id: "std",
					name: "Again",
					type: "flat_rate",
				})
			).code,
		).toBe("METHOD_ID_TAKEN");
	});

	test("an update with nothing to change, or of an unknown method, is refused", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "std", "flat_rate");
		const empty = await failure("shipping_method_update", { zoneId: "us", methodId: "std" });
		expect(empty.code).toBe("INVALID_INPUT");
		expect(empty.message).toMatch(/nothing to change/i);
		expect(
			(await failure("shipping_method_update", { zoneId: "us", methodId: "nope", name: "N" })).code,
		).toBe("NOT_FOUND");
	});

	test("free_shipping → flat_rate says that thresholds stop applying", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "free", "free_shipping");
		const out = await call("shipping_method_update", {
			zoneId: "us",
			methodId: "free",
			type: "flat_rate",
		});
		expect(out.status).toBe("updated");
		expect(out.note).toMatch(/threshold/i);
	});

	test("a method with rates is METHOD_IN_USE", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "std", "flat_rate");
		await call("shipping_rate_set", {
			zoneId: "us",
			methodId: "std",
			currency: "USD",
			amountCents: 500,
		});
		expect((await failure("shipping_method_delete", { methodId: "std" })).code).toBe(
			"METHOD_IN_USE",
		);
	});
});

describe("shipping_rate_set", () => {
	test("creates, then updates, the rate in one currency", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "std", "flat_rate");
		const rate = { zoneId: "us", methodId: "std", currency: "USD" };
		expect(await call("shipping_rate_set", { ...rate, amountCents: 500 })).toEqual({
			status: "set",
			rate: { methodId: "std", currency: "USD", amountCents: 500, minSubtotalCents: null },
		});
		expect((await call("shipping_rate_set", { ...rate, amountCents: 750 })).rate.amountCents).toBe(
			750,
		);
		expect(await call("shipping_rate_get", { methodId: "std", currency: "USD" })).toMatchObject({
			amountCents: 750,
		});
	});

	test("a threshold on a flat-rate method is THRESHOLD_ON_FLAT_RATE and nothing is written", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "std", "flat_rate");
		const err = await failure("shipping_rate_set", {
			zoneId: "us",
			methodId: "std",
			currency: "USD",
			amountCents: 500,
			minSubtotalCents: 5000,
		});
		expect(err.code).toBe("THRESHOLD_ON_FLAT_RATE");
		expect((await failure("shipping_rate_get", { methodId: "std", currency: "USD" })).code).toBe(
			"NOT_FOUND",
		);
	});

	test("a threshold on a free-shipping method is kept; omitting it later keeps it", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "free", "free_shipping");
		const rate = { zoneId: "us", methodId: "free", currency: "USD" };
		await call("shipping_rate_set", { ...rate, amountCents: 0, minSubtotalCents: 5000 });
		const out = await call("shipping_rate_set", { ...rate, amountCents: 100 });
		expect(out.rate).toEqual({
			methodId: "free",
			currency: "USD",
			amountCents: 100,
			minSubtotalCents: 5000,
		});
	});

	test("an amount-only update on a flat rate carrying a legacy threshold is refused; null clears it", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "std", "flat_rate");
		// Written before the rule, straight to the store.
		await shippingRules.createRate({
			methodId: "std",
			currency: toCurrency("USD"),
			amountCents: cents(500),
			minSubtotalCents: cents(5000),
		});
		const rate = { zoneId: "us", methodId: "std", currency: "USD" };
		expect((await failure("shipping_rate_set", { ...rate, amountCents: 600 })).code).toBe(
			"THRESHOLD_ON_FLAT_RATE",
		);
		const out = await call("shipping_rate_set", {
			...rate,
			amountCents: 600,
			minSubtotalCents: null,
		});
		expect(out.rate).toMatchObject({ amountCents: 600, minSubtotalCents: null });
	});

	test("a stale expectedAmountCents is RATE_CHANGED with the live rate; nothing is written", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "std", "flat_rate");
		const rate = { zoneId: "us", methodId: "std", currency: "USD" };
		await call("shipping_rate_set", { ...rate, amountCents: 500 });
		const err = await failure("shipping_rate_set", {
			...rate,
			amountCents: 900,
			expectedAmountCents: 400,
		});
		expect(err.code).toBe("RATE_CHANGED");
		expect(err.details.current).toMatchObject({ amountCents: 500 });
	});

	test("a method outside the zone is NOT_FOUND; a malformed currency is INVALID_INPUT", async () => {
		await seedZone("us", "US");
		await seedZone("de", "DE");
		await seedMethod("us", "std", "flat_rate");
		const base = { methodId: "std", amountCents: 500 };
		expect(
			(await failure("shipping_rate_set", { ...base, zoneId: "de", currency: "USD" })).code,
		).toBe("NOT_FOUND");
		expect(
			(await failure("shipping_rate_set", { ...base, zoneId: "us", currency: "usd" })).code,
		).toBe("INVALID_INPUT");
	});
});

describe("shipping_rate_delete", () => {
	test("deletes; again is NOT_FOUND", async () => {
		await seedZone("us", "US");
		await seedMethod("us", "std", "flat_rate");
		const rate = { zoneId: "us", methodId: "std", currency: "USD" };
		await call("shipping_rate_set", { ...rate, amountCents: 500 });
		expect(await call("shipping_rate_delete", rate)).toEqual({ status: "deleted" });
		expect((await failure("shipping_rate_delete", rate)).code).toBe("NOT_FOUND");
	});
});

describe("tax_settings_update", () => {
	const settings = {
		enabled: true,
		pricesIncludeTax: true,
		basedOn: "billing",
		baseAddress: { country: "DE", region: null },
		shippingTaxClass: { kind: "inherit" },
		roundAtSubtotal: true,
		displayCart: "incl",
		totalsDisplay: "single",
		displayShop: "incl",
	};

	test("round-trips through tax_settings_get", async () => {
		expect(await call("tax_settings_update", { settings })).toEqual({
			status: "updated",
			settings,
		});
		const read = await call("tax_settings_get", {});
		expect(read.settings).toEqual(settings);
		expect(read.saved).toBe(true);
	});

	test("a malformed block is INVALID_INPUT and nothing is saved", async () => {
		const err = await failure("tax_settings_update", {
			settings: { ...settings, basedOn: "moon" },
		});
		expect(err.code).toBe("INVALID_INPUT");
		const partial = await failure("tax_settings_update", { settings: { enabled: true } });
		expect(partial.code).toBe("INVALID_INPUT");
		expect((await call("tax_settings_get", {})).saved).toBe(false);
	});

	test("a fixed shipping tax class that does not exist is refused by the domain", async () => {
		const err = await failure("tax_settings_update", {
			settings: { ...settings, shippingTaxClass: { kind: "fixed", taxClassId: "ghost" } },
		});
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.details.field).toBeTypeOf("string");
		expect((await call("tax_settings_get", {})).saved).toBe(false);
	});
});

describe("tax classes", () => {
	test("create, rename, delete; a taken id is TAX_CLASS_ID_TAKEN", async () => {
		expect(await call("tax_class_create", { id: "reduced", name: "Reduced" })).toEqual({
			status: "created",
			taxClass: { id: "reduced", name: "Reduced" },
		});
		expect((await failure("tax_class_create", { id: "reduced", name: "Again" })).code).toBe(
			"TAX_CLASS_ID_TAKEN",
		);
		expect(await call("tax_class_update", { classId: "reduced", name: "Lower" })).toEqual({
			status: "updated",
			taxClass: { id: "reduced", name: "Lower" },
		});
		expect(await call("tax_class_delete", { classId: "reduced" })).toEqual({ status: "deleted" });
		expect((await failure("tax_class_delete", { classId: "reduced" })).code).toBe("NOT_FOUND");
		expect((await failure("tax_class_update", { classId: "reduced", name: "X" })).code).toBe(
			"NOT_FOUND",
		);
	});

	test("a class a rate uses is TAX_CLASS_IN_USE with what uses it", async () => {
		await seedZone("us", "US");
		await call("tax_class_create", { id: "std", name: "Standard" });
		await call("tax_rate_create", { id: "r1", taxClassId: "std", zoneId: "us", rateBps: 800 });
		const err = await failure("tax_class_delete", { classId: "std" });
		expect(err.code).toBe("TAX_CLASS_IN_USE");
		expect(err.details).toEqual({ usedBy: "rates", count: 1 });
	});
});

describe("tax rates", () => {
	test("a tax class that does not exist is INVALID_INPUT, as tax_settings_update refuses it, and nothing is written (#740)", async () => {
		await seedZone("us", "US");
		const err = await failure("tax_rate_create", {
			taxClassId: "nope-class",
			zoneId: "us",
			rateBps: 100,
		});
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.details.field).toBe("taxClassId");
		expect(err.message).toMatch(/nope-class/);
		expect(await call("tax_rates_list", { zoneId: "us" })).toMatchObject({ items: [] });
		expect(await call("tax_settings_get", {})).toMatchObject({ saved: false, hasRates: false });
		const storage = harness.ctx.storage;
		if (storage === undefined) throw new Error("harness has no storage");
		expect(await storage[TAX_CLASSES_COLLECTION]?.get("nope-class")).toBeNull();
	});

	test("a shipping zone that does not exist is INVALID_INPUT naming zoneId, and nothing is written (#743)", async () => {
		await call("tax_class_create", { id: "std", name: "Standard" });
		const err = await failure("tax_rate_create", {
			taxClassId: "std",
			zoneId: "nope-zone",
			rateBps: 100,
		});
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.details.field).toBe("zoneId");
		expect(err.message).toMatch(/nope-zone/);
		expect(err.message).toMatch(/shipping_zone_create/);
		expect(await call("tax_settings_get", {})).toMatchObject({ saved: false, hasRates: false });
		// The zone created afterwards picks up no hidden rate.
		await seedZone("nope-zone", "US");
		expect(await call("tax_rates_list", { zoneId: "nope-zone" })).toMatchObject({ items: [] });
	});

	test("any field the surface refuses rides details.field", async () => {
		await seedZone("us", "US");
		await call("tax_class_create", { id: "std", name: "Standard" });
		const err = await failure("tax_rate_create", {
			taxClassId: "std",
			zoneId: "us",
			rateBps: 825,
			ratePpm: 1,
		});
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.details.field).toBe("ratePpm");
		expect(await call("tax_rates_list", { zoneId: "us" })).toMatchObject({ items: [] });
	});

	test("create, then a partial update keeps the rate and flips the flag", async () => {
		await seedZone("us", "US");
		await call("tax_class_create", { id: "std", name: "Standard" });
		expect(
			await call("tax_rate_create", { id: "r1", taxClassId: "std", zoneId: "us", rateBps: 825 }),
		).toEqual({
			status: "created",
			taxRate: {
				id: "r1",
				taxClassId: "std",
				zoneId: "us",
				rateBps: 825,
				appliesToShipping: false,
			},
		});
		const out = await call("tax_rate_update", {
			zoneId: "us",
			rateId: "r1",
			appliesToShipping: true,
		});
		expect(out).toEqual({
			status: "updated",
			taxRate: {
				id: "r1",
				taxClassId: "std",
				zoneId: "us",
				rateBps: 825,
				appliesToShipping: true,
			},
		});
		expect(
			(await call("tax_rate_update", { zoneId: "us", rateId: "r1", rateBps: 900 })).taxRate,
		).toMatchObject({ rateBps: 900, appliesToShipping: true });
	});

	test("a second rate in the same class and zone is TAX_RATE_SLOT_TAKEN naming the one there", async () => {
		await seedZone("us", "US");
		await call("tax_class_create", { id: "std", name: "Standard" });
		await call("tax_rate_create", { id: "r1", taxClassId: "std", zoneId: "us", rateBps: 800 });
		const err = await failure("tax_rate_create", {
			id: "r2",
			taxClassId: "std",
			zoneId: "us",
			rateBps: 900,
		});
		expect(err.code).toBe("TAX_RATE_SLOT_TAKEN");
		expect(err.details.existing).toEqual({ id: "r1", rateBps: 800 });
	});

	test("a stale expectedRateBps is TAX_RATE_CHANGED; nothing to change is refused; delete", async () => {
		await seedZone("us", "US");
		await call("tax_class_create", { id: "std", name: "Standard" });
		await call("tax_rate_create", { id: "r1", taxClassId: "std", zoneId: "us", rateBps: 800 });
		const stale = await failure("tax_rate_update", {
			zoneId: "us",
			rateId: "r1",
			rateBps: 1000,
			expectedRateBps: 700,
		});
		expect(stale.code).toBe("TAX_RATE_CHANGED");
		expect(stale.details.current).toMatchObject({ rateBps: 800 });
		const empty = await failure("tax_rate_update", { zoneId: "us", rateId: "r1" });
		expect(empty.code).toBe("INVALID_INPUT");
		expect(empty.message).toMatch(/nothing to change/i);
		expect(
			(await failure("tax_rate_update", { zoneId: "us", rateId: "nope", rateBps: 1 })).code,
		).toBe("NOT_FOUND");
		expect(await call("tax_rate_delete", { rateId: "r1" })).toEqual({ status: "deleted" });
		expect((await failure("tax_rate_delete", { rateId: "r1" })).code).toBe("NOT_FOUND");
	});

	test("expectedRatePpm without expectedRateBps is refused, not ignored; nothing is written", async () => {
		await seedZone("us", "US");
		await call("tax_class_create", { id: "std", name: "Standard" });
		await call("tax_rate_create", { id: "r1", taxClassId: "std", zoneId: "us", rateBps: 800 });
		const err = await failure("tax_rate_update", {
			zoneId: "us",
			rateId: "r1",
			rateBps: 900,
			expectedRatePpm: 80_000,
		});
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.message).toMatch(/expectedRatePpm.*expectedRateBps/);
		expect(await call("tax_rates_list", { zoneId: "us" })).toMatchObject({
			items: [{ id: "r1", rateBps: 800 }],
		});
	});
});
