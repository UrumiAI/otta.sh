/**
 * #744: tax rates whose shipping zone no longer exists. A zone deleted before
 * #741 (or in `deleteShippingZone`'s accepted race window) left its rates
 * behind: no zone list shows them, yet they hold their tax class against delete.
 * The admin rules surface now lists a class's rates whatever zone they name,
 * flagging the ones whose zone is gone, and deletes them by id — no zone has to
 * be recreated. A zone-delete refusal now says which guard refused and how many.
 *
 * The orphan is arranged through the store directly: no admin path can create
 * one any more (#741 refuses the zone delete, #743 the rate create).
 *
 * In-process over a real document store (no mocks).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminRulesClient } from "../src/admin/in-process-admin-rules-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let h: InProcessCommerceHarness;
let client: InProcessAdminRulesClient;

beforeEach(async () => {
	h = await makeInProcessCommerce();
	client = new InProcessAdminRulesClient(h.ctx);
	await h.stores.shippingRules.createZone({ id: "z-us", name: "US", regions: ["US"] });
	await h.stores.taxRules.createClass({ id: "standard", name: "Standard" });
	await h.stores.taxRules.createRate({
		id: "t-us",
		taxClassId: "standard",
		zoneId: "z-us",
		rateBps: 725,
		appliesToShipping: false,
	});
	// The orphan: its zone was deleted out from under it.
	await h.stores.taxRules.createRate({
		id: "t-gone",
		taxClassId: "standard",
		zoneId: "z-gone",
		rateBps: 2000,
		appliesToShipping: true,
	});
});
afterEach(async () => {
	await h.close();
});

describe("listTaxRatesForClass", () => {
	test("lists every rate of the class, flagging the one whose zone no longer exists", async () => {
		expect(await client.listTaxRatesForClass("standard")).toEqual([
			{
				id: "t-gone",
				taxClassId: "standard",
				zoneId: "z-gone",
				rateBps: 2000,
				appliesToShipping: true,
				zoneExists: false,
			},
			{
				id: "t-us",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 725,
				appliesToShipping: false,
				zoneExists: true,
			},
		]);
		expect(await client.listTaxRatesForClass("nope")).toEqual([]);
	});

	test("refuses an ill-formed class id as invalid input", async () => {
		await expect(client.listTaxRatesForClass("has space")).rejects.toMatchObject({
			code: "INVALID_INPUT",
			field: "taxClassId",
		});
	});
});

describe("an orphaned rate is removable without recreating its zone", () => {
	test("deleteTaxRate removes it, and then its class can be deleted", async () => {
		expect(await client.deleteTaxClass("standard")).toEqual({
			ok: false,
			reason: "in_use_by_rates",
			count: 2,
		});
		expect(await client.deleteTaxRate("t-gone")).toEqual({ ok: true });
		expect(await client.deleteTaxRate("t-us")).toEqual({ ok: true });
		expect(await client.listTaxRatesForClass("standard")).toEqual([]);
		expect(await client.deleteTaxClass("standard")).toEqual({ ok: true });
		// No zone was recreated on the way.
		expect(await h.stores.shippingRules.getZone("z-gone")).toBeNull();
	});
});

describe("deleteZone says which guard refused", () => {
	test("tax rates: usedBy tax_rates with their count", async () => {
		expect(await client.deleteZone("z-us")).toEqual({
			ok: false,
			reason: "in_use",
			usedBy: "tax_rates",
			count: 1,
		});
	});

	test("shipping methods: usedBy methods with their count", async () => {
		await h.stores.shippingRules.createZone({ id: "z-m", name: "M", regions: null });
		for (const id of ["m1", "m2"]) {
			await h.stores.shippingRules.createMethod({
				id,
				zoneId: "z-m",
				name: id,
				type: "flat_rate",
			});
		}
		expect(await client.deleteZone("z-m")).toEqual({
			ok: false,
			reason: "in_use",
			usedBy: "methods",
			count: 2,
		});
	});
});
