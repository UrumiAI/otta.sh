/**
 * The admin SHIPPING and TAX operations, called directly — no console action,
 * no notice.
 *
 * These are the decisions `shipping-page.ts` and `tax-options-screen.ts` used to
 * make inline around each rules-client write: the zone regions check (ISO codes,
 * one zone per code), the first-zone acknowledgement, the "threshold on a flat
 * rate" guard, and the tax options' compare-and-set token and idempotency key.
 * Plus `upsertRate` and the PARTIAL `updateZone`, which only the MCP tools use.
 * The admin console and the MCP tools both call these, so a guard here holds for
 * both. `shipping-page.sandbox.test.ts` and `tax-page.sandbox.test.ts` pin the
 * notices the console renders from these outcomes; this file pins the outcomes.
 *
 * Real document store (in-memory SQLite, the host's migrations) and the client's
 * own stores.
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { taxSettingsDigest, type TaxSettingsWire } from "../src/admin/admin-rules-surface.js";
import { InProcessAdminRulesClient } from "../src/admin/in-process-admin-rules-client.js";
import {
	checkZoneRegions,
	createRate,
	createZone,
	updateRate,
	updateTaxSettings,
	updateZone,
	upsertRate,
} from "../src/admin/operations/index.js";
import * as pluginIndex from "../src/index.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;
let client: InProcessAdminRulesClient;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	client = new InProcessAdminRulesClient(harness.ctx);
});

afterAll(async () => {
	await harness?.close();
});

/** A US zone with a flat-rate method (`standard`, USD 4.99) and a free-shipping
 *  method (`free`, no rate yet), written through the surface. */
async function seedShipping(): Promise<void> {
	expect((await client.createZone({ id: "us", name: "United States", regions: ["US"] })).ok).toBe(
		true,
	);
	expect((await client.createZone({ id: "empty", name: "Empty zone", regions: null })).ok).toBe(
		true,
	);
	await client.createMethod("us", { id: "standard", name: "Standard", type: "flat_rate" });
	await client.createMethod("us", { id: "free", name: "Free over $50", type: "free_shipping" });
	expect((await client.createRate("standard", { currency: "USD", amountCents: 499 })).ok).toBe(
		true,
	);
}

const zone = (id: string) => harness.stores.shippingRules.getZone(id);

describe("checkZoneRegions", () => {
	test("valid codes come back upper-cased, in order", async () => {
		await seedShipping();
		expect(await checkZoneRegions(client, " fr , de ", null)).toEqual({
			ok: true,
			codes: ["FR", "DE"],
		});
	});

	test("blank is `codes: null` (a zone that matches no address)", async () => {
		expect(await checkZoneRegions(client, "  ", null)).toEqual({ ok: true, codes: null });
	});

	test("bad tokens are `invalid_codes`, listing every bad token as typed and no good one", async () => {
		expect(await checkZoneRegions(client, "UK, US-XX, US-TX, Narnia", null)).toEqual({
			ok: false,
			reason: "invalid_codes",
			invalid: ["UK", "US-XX", "Narnia"],
		});
	});

	test("a code another zone lists is `overlap`, naming the code and the zone", async () => {
		await seedShipping();
		expect(await checkZoneRegions(client, "US-CA, us", null)).toEqual({
			ok: false,
			reason: "overlap",
			code: "US",
			zoneId: "us",
			zoneName: "United States",
		});
	});

	test("a zone's OWN codes are not an overlap", async () => {
		await seedShipping();
		expect(await checkZoneRegions(client, "US", "us")).toEqual({ ok: true, codes: ["US"] });
	});
});

describe("createZone", () => {
	test("happy: `ok`, carrying the surface's create result; the zone is stored", async () => {
		await seedShipping();
		const outcome = await createZone(client, { id: "eu", name: "Europe", regions: "FR, DE" });
		expect(outcome).toEqual({
			ok: true,
			result: { ok: true, value: { id: "eu", name: "Europe", regions: ["FR", "DE"] } },
		});
		expect(await zone("eu")).toMatchObject({ regions: ["FR", "DE"] });
	});

	test("invalid codes are refused before any write", async () => {
		await seedShipping();
		const outcome = await createZone(client, { id: "bad", name: "Bad", regions: "UK" });
		expect(outcome).toEqual({ ok: false, reason: "invalid_codes", invalid: ["UK"] });
		expect(await zone("bad")).toBeNull();
	});

	test("an overlap is refused before any write", async () => {
		await seedShipping();
		const outcome = await createZone(client, { id: "us2", name: "Again", regions: "US" });
		expect(outcome).toMatchObject({ ok: false, reason: "overlap", code: "US", zoneId: "us" });
		expect(await zone("us2")).toBeNull();
	});

	test("the FIRST zone without the acknowledgement is `first_zone_unacknowledged`; with it, created", async () => {
		const refused = await createZone(client, { id: "jp", name: "Japan", regions: "JP" });
		expect(refused).toEqual({ ok: false, reason: "first_zone_unacknowledged" });
		expect(await zone("jp")).toBeNull();
		const created = await createZone(client, {
			id: "jp",
			name: "Japan",
			regions: "JP",
			acknowledgeFirstZone: true,
		});
		expect(created).toMatchObject({ ok: true, result: { ok: true } });
	});

	test("on the first zone, a bad region wins over the missing acknowledgement", async () => {
		const outcome = await createZone(client, { id: "uk", name: "Britain", regions: "UK" });
		expect(outcome).toMatchObject({ ok: false, reason: "invalid_codes" });
	});

	test("a taken id is the surface's 409, passed through", async () => {
		await seedShipping();
		const outcome = await createZone(client, { id: "us", name: "Again", regions: "CA" });
		expect(outcome).toEqual({ ok: true, result: { ok: false, status: 409 } });
	});
});

describe("updateZone", () => {
	test("a full edit: `ok`, both fields written", async () => {
		await seedShipping();
		const outcome = await updateZone(client, "empty", { name: "Canada", regions: "ca" });
		expect(outcome).toEqual({
			ok: true,
			result: { ok: true, value: { id: "empty", name: "Canada", regions: ["CA"] } },
		});
	});

	test("an overlap is refused; nothing is written", async () => {
		await seedShipping();
		const outcome = await updateZone(client, "empty", { name: "Empty zone", regions: "US" });
		expect(outcome).toMatchObject({ ok: false, reason: "overlap", code: "US", zoneId: "us" });
		expect((await zone("empty"))?.regions).toBeNull();
	});

	test("invalid codes are refused; nothing is written", async () => {
		await seedShipping();
		const outcome = await updateZone(client, "empty", { regions: "EU" });
		expect(outcome).toEqual({ ok: false, reason: "invalid_codes", invalid: ["EU"] });
	});

	test("a PARTIAL edit (name only) keeps the stored regions", async () => {
		await seedShipping();
		const outcome = await updateZone(client, "us", { name: "USA" });
		expect(outcome).toMatchObject({ ok: true, result: { ok: true } });
		expect(await zone("us")).toEqual({ id: "us", name: "USA", regions: ["US"] });
	});

	test("a PARTIAL edit (regions only) keeps the stored name; blank clears the regions", async () => {
		await seedShipping();
		expect(await updateZone(client, "us", { regions: "" })).toMatchObject({ ok: true });
		expect(await zone("us")).toEqual({ id: "us", name: "United States", regions: null });
	});

	test("a missing zone is the surface's `not_found`", async () => {
		await seedShipping();
		expect(await updateZone(client, "gone", { name: "X", regions: "" })).toEqual({
			ok: true,
			result: { ok: false, reason: "not_found" },
		});
		expect(await updateZone(client, "gone", { name: "X" })).toEqual({
			ok: true,
			result: { ok: false, reason: "not_found" },
		});
	});
});

describe("createRate / updateRate", () => {
	test("a threshold on a FLAT-RATE method is `threshold_on_flat_rate`; nothing is written", async () => {
		await seedShipping();
		await client.createMethod("us", { id: "bare", name: "Bare", type: "flat_rate" });
		const outcome = await createRate(client, "us", "bare", {
			currency: "USD",
			amountCents: 499,
			minSubtotalCents: 3500,
		});
		expect(outcome).toEqual({ ok: false, reason: "threshold_on_flat_rate" });
		expect(await client.getRate("bare", "USD")).toBeNull();
	});

	test("a flat-rate rate with NO threshold is created", async () => {
		await seedShipping();
		await client.createMethod("us", { id: "bare", name: "Bare", type: "flat_rate" });
		const outcome = await createRate(client, "us", "bare", {
			currency: "USD",
			amountCents: 0,
			minSubtotalCents: null,
		});
		expect(outcome).toMatchObject({ ok: true, result: { ok: true, value: { amountCents: 0 } } });
	});

	test("a free-shipping method takes its threshold", async () => {
		await seedShipping();
		const outcome = await createRate(client, "us", "free", {
			currency: "USD",
			amountCents: 0,
			minSubtotalCents: 5000,
		});
		expect(outcome).toMatchObject({
			ok: true,
			result: { ok: true, value: { minSubtotalCents: 5000 } },
		});
	});

	test("a currency that already has a rate is the surface's 409", async () => {
		await seedShipping();
		const outcome = await createRate(client, "us", "standard", {
			currency: "USD",
			amountCents: 100,
			minSubtotalCents: null,
		});
		expect(outcome).toEqual({ ok: true, result: { ok: false, status: 409 } });
	});

	test("updateRate: a threshold on a flat-rate method is refused; the CAS edit otherwise lands", async () => {
		await seedShipping();
		expect(
			await updateRate(client, "us", "standard", "USD", {
				amountCents: 599,
				minSubtotalCents: 3500,
				expectedAmountCents: 499,
			}),
		).toEqual({ ok: false, reason: "threshold_on_flat_rate" });
		expect(
			await updateRate(client, "us", "standard", "USD", {
				amountCents: 599,
				minSubtotalCents: null,
				expectedAmountCents: 499,
			}),
		).toMatchObject({ ok: true, result: { ok: true, value: { amountCents: 599 } } });
	});

	test("updateRate: a losing CAS is the surface's `stale`, with the current row", async () => {
		await seedShipping();
		const outcome = await updateRate(client, "us", "standard", "USD", {
			amountCents: 599,
			minSubtotalCents: null,
			expectedAmountCents: 100,
		});
		expect(outcome).toMatchObject({
			ok: true,
			result: { ok: false, reason: "stale", current: { amountCents: 499 } },
		});
	});
});

describe("upsertRate", () => {
	test("no rate in that currency: creates it", async () => {
		await seedShipping();
		const outcome = await upsertRate(client, "us", "standard", {
			currency: "EUR",
			amountCents: 450,
		});
		expect(outcome).toMatchObject({ ok: true, result: { ok: true, value: { currency: "EUR" } } });
		expect((await client.getRate("standard", "EUR"))?.amountCents).toBe(450);
	});

	test("a rate exists: updates it against the amount it read", async () => {
		await seedShipping();
		const outcome = await upsertRate(client, "us", "standard", {
			currency: "USD",
			amountCents: 650,
		});
		expect(outcome).toMatchObject({ ok: true, result: { ok: true, value: { amountCents: 650 } } });
	});

	test("an omitted threshold keeps the stored one; null clears it", async () => {
		await seedShipping();
		await createRate(client, "us", "free", {
			currency: "USD",
			amountCents: 0,
			minSubtotalCents: 5000,
		});
		await upsertRate(client, "us", "free", { currency: "USD", amountCents: 100 });
		expect(await client.getRate("free", "USD")).toMatchObject({
			amountCents: 100,
			minSubtotalCents: 5000,
		});
		await upsertRate(client, "us", "free", {
			currency: "USD",
			amountCents: 100,
			minSubtotalCents: null,
		});
		expect((await client.getRate("free", "USD"))?.minSubtotalCents).toBeNull();
	});

	test("a caller's `expectedAmountCents` that no longer holds is `stale`, never a clobber", async () => {
		await seedShipping();
		const outcome = await upsertRate(client, "us", "standard", {
			currency: "USD",
			amountCents: 650,
			expectedAmountCents: 100,
		});
		expect(outcome).toMatchObject({ ok: true, result: { ok: false, reason: "stale" } });
		expect((await client.getRate("standard", "USD"))?.amountCents).toBe(499);
	});

	test("a threshold on a flat-rate method is refused, create or update", async () => {
		await seedShipping();
		expect(
			await upsertRate(client, "us", "standard", {
				currency: "USD",
				amountCents: 499,
				minSubtotalCents: 3500,
			}),
		).toEqual({ ok: false, reason: "threshold_on_flat_rate" });
		expect(
			await upsertRate(client, "us", "standard", {
				currency: "GBP",
				amountCents: 499,
				minSubtotalCents: 3500,
			}),
		).toEqual({ ok: false, reason: "threshold_on_flat_rate" });
		expect(await client.getRate("standard", "GBP")).toBeNull();
	});
});

describe("updateTaxSettings", () => {
	const TAX_ON: TaxSettingsWire = {
		enabled: true,
		pricesIncludeTax: false,
		basedOn: "shipping",
		baseAddress: null,
		shippingTaxClass: { kind: "inherit" },
		roundAtSubtotal: true,
		displayCart: "excl",
		totalsDisplay: "itemized",
	};

	test("happy, against the digest the caller read: the surface's `ok`, and the block is stored", async () => {
		const expected = taxSettingsDigest((await client.getTaxSettings()).settings);
		const outcome = await updateTaxSettings(client, TAX_ON, { expected });
		expect(outcome).toEqual({ ok: true, settings: TAX_ON });
		expect((await harness.stores.settingsStore.get()).tax).toEqual(TAX_ON);
	});

	test("with no `expected`, the options in force are read and used as the token", async () => {
		const outcome = await updateTaxSettings(client, TAX_ON);
		expect(outcome).toEqual({ ok: true, settings: TAX_ON });
		expect((await client.getTaxSettings()).settings).toEqual(TAX_ON);
	});

	test("a stale `expected` is the surface's `stale`, with the current options; nothing is overwritten", async () => {
		const outcome = await updateTaxSettings(client, TAX_ON, { expected: "not-the-digest" });
		expect(outcome).toMatchObject({ ok: false, reason: "stale" });
		expect((await harness.stores.settingsStore.get()).tax).toBeUndefined();
	});

	test("an invalid block is the surface's `invalid`, naming the field", async () => {
		const outcome = await updateTaxSettings(client, {
			...TAX_ON,
			baseAddress: { country: "XX", region: null },
		});
		expect(outcome).toMatchObject({ ok: false, reason: "invalid", field: "tax.baseAddress" });
	});
});

describe("exports", () => {
	test("the operations are on the plugin's entry point", () => {
		for (const name of [
			"checkZoneRegions",
			"createZone",
			"updateZone",
			"createRate",
			"updateRate",
			"upsertRate",
			"updateTaxSettings",
		]) {
			expect(typeof (pluginIndex as Record<string, unknown>)[name], name).toBe("function");
		}
	});
});
