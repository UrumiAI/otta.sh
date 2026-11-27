/**
 * #743: a tax rate naming a shipping zone that does not exist is refused at the
 * admin rules surface — the one every caller goes through (the Tax console, the
 * MCP tools) — the same way #740 refuses an unknown tax class.
 *
 * The client contract pins the refusal and what a caller can see afterwards; this
 * file pins what the contract cannot see: that NOTHING reached the document store.
 * Before the fix the create answered `created`, stored a rate no checkout can ever
 * resolve (and that no list shows, and that blocks its class's delete), and pinned
 * the tax options on the way, so the store read as "has rates".
 *
 * In-process over a real document store (no mocks).
 */
import { TAX_CLASSES_COLLECTION, TAX_RATE_OWNERS_COLLECTION } from "@urumi.ai/otta-store-emdash";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminRulesClient } from "../src/admin/in-process-admin-rules-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let h: InProcessCommerceHarness;

beforeEach(async () => {
	h = await makeInProcessCommerce();
	await h.stores.taxRules.createClass({ id: "standard", name: "Standard" });
});
afterEach(async () => {
	await h.close();
});

function collection(name: string) {
	const found = h.ctx.storage?.[name];
	if (found === undefined) throw new Error(`no ${name} collection`);
	return found;
}

const unknownZoneRate = {
	id: "t-nope",
	taxClassId: "standard",
	zoneId: "nope-zone",
	rateBps: 100,
};

describe("createTaxRate on a shipping zone that does not exist", () => {
	test("is refused as invalid input naming zoneId", async () => {
		const client = new InProcessAdminRulesClient(h.ctx);
		await expect(client.createTaxRate(unknownZoneRate)).rejects.toMatchObject({
			code: "INVALID_INPUT",
			field: "zoneId",
			message: expect.stringMatching(/nope-zone/),
		});
	});

	test("writes no rate, no id claim, and pins no tax options", async () => {
		const client = new InProcessAdminRulesClient(h.ctx);
		const classBefore = await collection(TAX_CLASSES_COLLECTION).get("standard");
		await client.createTaxRate(unknownZoneRate).catch(() => undefined);

		expect(await collection(TAX_RATE_OWNERS_COLLECTION).get("t-nope")).toBeNull();
		expect(await collection(TAX_CLASSES_COLLECTION).get("standard")).toEqual(classBefore);
		expect(await h.stores.taxRules.listRatesForZone("nope-zone")).toEqual([]);
		expect(await h.stores.taxRules.hasAnyRate()).toBe(false);
		expect((await h.stores.settingsStore.get()).tax).toBeUndefined();
		expect(await client.getTaxSettings()).toMatchObject({ saved: false, hasRates: false });
		// The class it named is not held by a hidden rate.
		expect(await client.deleteTaxClass("standard")).toEqual({ ok: true });
	});

	test("an unknown class is still reported first, as #740 does", async () => {
		const client = new InProcessAdminRulesClient(h.ctx);
		await expect(
			client.createTaxRate({ ...unknownZoneRate, taxClassId: "nope-class" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT", field: "taxClassId" });
	});

	test("an existing zone still takes its rate", async () => {
		await h.stores.shippingRules.createZone({ id: "nope-zone", name: "Real now", regions: null });
		const client = new InProcessAdminRulesClient(h.ctx);
		const created = await client.createTaxRate(unknownZoneRate);
		expect(created).toMatchObject({ ok: true, value: { id: "t-nope", zoneId: "nope-zone" } });
	});
});
