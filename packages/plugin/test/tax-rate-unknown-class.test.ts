/**
 * #740: a tax rate naming a tax class that does not exist is refused at the admin
 * rules surface — the one every caller goes through (the Tax console, the MCP
 * tools) — the same way the tax options refuse an unknown fixed shipping class.
 *
 * The client contract pins the refusal and what a caller can see afterwards; this
 * file pins what the contract cannot see: that NOTHING reached the document store.
 * Before the fix the create answered `created`, minted a nameless
 * `tax_classes/{id}` document to hold the rate (which `listClasses` hides), and
 * pinned the tax options on the way, so the store read as "has rates".
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
	await h.stores.shippingRules.createZone({ id: "z-us", name: "US", regions: ["US"] });
});
afterEach(async () => {
	await h.close();
});

function collection(name: string) {
	const found = h.ctx.storage?.[name];
	if (found === undefined) throw new Error(`no ${name} collection`);
	return found;
}

const unknownClassRate = {
	id: "t-nope",
	taxClassId: "nope-class",
	zoneId: "z-us",
	rateBps: 100,
};

describe("createTaxRate on a tax class that does not exist", () => {
	test("is refused as invalid input naming taxClassId", async () => {
		const client = new InProcessAdminRulesClient(h.ctx);
		await expect(client.createTaxRate(unknownClassRate)).rejects.toMatchObject({
			code: "INVALID_INPUT",
			field: "taxClassId",
		});
	});

	test("writes no class record, no rate, no id claim, and pins no tax options", async () => {
		const client = new InProcessAdminRulesClient(h.ctx);
		await client.createTaxRate(unknownClassRate).catch(() => undefined);

		expect(await collection(TAX_CLASSES_COLLECTION).get("nope-class")).toBeNull();
		expect(await collection(TAX_RATE_OWNERS_COLLECTION).get("t-nope")).toBeNull();
		expect(await h.stores.taxRules.hasAnyRate()).toBe(false);
		expect((await h.stores.settingsStore.get()).tax).toBeUndefined();
		expect(await client.getTaxSettings()).toMatchObject({ saved: false, hasRates: false });
	});

	test("a class whose document exists only to hold legacy rates (never declared) is unknown too", async () => {
		// The port still lets a rate exist without its class (the SQL had no foreign
		// key), so a store can hold a nameless class document from before #740. It
		// is not a class a merchant can see, so the surface refuses it the same way.
		await h.stores.taxRules.createRate({
			id: "t-legacy",
			taxClassId: "nope-class",
			zoneId: "z-us",
			rateBps: 100,
			appliesToShipping: false,
		});
		const client = new InProcessAdminRulesClient(h.ctx);
		await expect(
			client.createTaxRate({ ...unknownClassRate, zoneId: "z-other" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT", field: "taxClassId" });
		expect(await collection(TAX_RATE_OWNERS_COLLECTION).get("t-nope")).toBeNull();
	});

	test("a declared class still takes its rate", async () => {
		await h.stores.taxRules.createClass({ id: "nope-class", name: "Declared" });
		const client = new InProcessAdminRulesClient(h.ctx);
		const created = await client.createTaxRate(unknownClassRate);
		expect(created).toMatchObject({ ok: true, value: { id: "t-nope", taxClassId: "nope-class" } });
	});
});
