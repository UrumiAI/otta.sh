/**
 * ADR-0031's upgrade rule on the admin side, for a store with an outside tax
 * calculator (ADR-0030): such a store has no rates — the calculator replaces the
 * table — yet already charges tax, so with nothing saved it must read as tax ON,
 * exactly as the quote does. Otherwise the options screen shows "off" and the
 * first rate created pins "off" for good.
 *
 * In-process over a real document store (no mocks).
 */
import { LEGACY_TAX_SETTINGS, NEW_STORE_TAX_SETTINGS } from "@otta-sh/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { taxSettingsDigest } from "../src/admin/admin-rules-surface.js";
import { InProcessAdminRulesClient } from "../src/admin/in-process-admin-rules-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let h: InProcessCommerceHarness;

beforeEach(async () => {
	h = await makeInProcessCommerce();
});
afterEach(async () => {
	await h.close();
});

function rules(hasOutsideTaxCalculator: boolean): InProcessAdminRulesClient {
	return new InProcessAdminRulesClient(h.ctx, { hasOutsideTaxCalculator });
}

describe("tax options with an outside calculator, no rates, nothing saved", () => {
	test("getTaxSettings reports tax ON (the legacy options), not the new-store defaults", async () => {
		const read = await rules(true).getTaxSettings();
		expect(read).toEqual({ settings: LEGACY_TAX_SETTINGS, saved: false, hasRates: false });
		expect(read.settings.enabled).toBe(true);
	});

	test("without a calculator the same store still reads as a new store: tax OFF", async () => {
		const read = await rules(false).getTaxSettings();
		expect(read).toEqual({ settings: NEW_STORE_TAX_SETTINGS, saved: false, hasRates: false });
	});

	test("the first rate created pins tax ON, never off", async () => {
		const client = rules(true);
		await h.stores.shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
		await h.stores.taxRules.createClass({ id: "standard", name: "Standard" });
		const created = await client.createTaxRate({
			id: "t-gb",
			taxClassId: "standard",
			zoneId: "z-gb",
			rateBps: 2000,
		});
		expect(created.ok).toBe(true);
		const saved = (await h.stores.settingsStore.get()).tax;
		expect(saved).toEqual(LEGACY_TAX_SETTINGS);
	});

	test("a save guarded on the options the screen showed (tax on) is accepted, not stale", async () => {
		const client = rules(true);
		const next = { ...LEGACY_TAX_SETTINGS, totalsDisplay: "itemized" as const };
		const res = await client.updateTaxSettings(next, {
			expected: taxSettingsDigest(LEGACY_TAX_SETTINGS),
			idempotencyKey: "save-1",
		});
		expect(res).toEqual({ ok: true, settings: next });
		expect((await h.stores.settingsStore.get()).tax).toEqual(next);
	});
});
