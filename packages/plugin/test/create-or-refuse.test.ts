import { TaxRateDuplicateError } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { createOrRefuse } from "../src/admin/in-process-admin-rules-client.js";
import { createRateNotice } from "../src/admin/tax-page.js";

// How a create's thrown refusal becomes the console's `RulesCreateResult`.
describe("createOrRefuse — the one-rate-per-(class, zone) refusal", () => {
	test("a real duplicate error is a 409 that names the existing rate", async () => {
		const res = await createOrRefuse(() =>
			Promise.reject(
				new TaxRateDuplicateError({
					id: "std-us",
					taxClassId: "standard",
					zoneId: "us",
					rateBps: 725,
				}),
			),
		);
		expect(res).toEqual({
			ok: false,
			status: 409,
			duplicateTaxRate: { id: "std-us", rateBps: 725 },
		});
	});

	test("an object that only claims the code is a duplicate-SLOT 409 that names nothing unverified", async () => {
		for (const thrown of [
			{ code: "TAX_RATE_DUPLICATE" },
			{ code: "TAX_RATE_DUPLICATE", existingRateId: 7, existingRateBps: 725 },
			{ code: "TAX_RATE_DUPLICATE", existingRateId: "x", existingRateBps: "725" },
		]) {
			expect(await createOrRefuse(() => Promise.reject(thrown))).toEqual({
				ok: false,
				status: 409,
				duplicateTaxRate: null,
			});
		}
	});

	test("anything else still propagates", async () => {
		await expect(createOrRefuse(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
	});
});

describe("createRateNotice — the console's words for each refusal", () => {
	test("an unnamed duplicate says the SLOT is taken, never that the id is", () => {
		const notice = createRateNotice(
			{ ok: false, status: 409, duplicateTaxRate: null },
			"std-us-2",
			"standard",
			"us",
		);
		expect(notice.description).toBe(
			'Class "standard" already has a rate for zone "us". A class can have one rate per zone — edit that rate instead, or delete it first.',
		);
		expect(notice.description).not.toMatch(/ID/);
	});

	test("a named duplicate names it; a bare 409 is the id collision", () => {
		expect(
			createRateNotice(
				{ ok: false, status: 409, duplicateTaxRate: { id: "std-us", rateBps: 725 } },
				"x",
				"standard",
				"us",
			).description,
		).toContain('"std-us" (7.25%)');
		expect(createRateNotice({ ok: false, status: 409 }, "x", "standard", "us").description).toMatch(
			/A tax rate with the ID "x" already exists/,
		);
	});
});
