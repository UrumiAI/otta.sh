import { TaxRateDuplicateError } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { createOrRefuse } from "../src/admin/in-process-admin-rules-client.js";
import { duplicateRateNotice } from "../src/admin/tax-page.js";

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

	test("an object that only claims the code is not trusted to name a rate — it propagates", async () => {
		// Unreachable from the store (it runs in this isolate and always sets the
		// fields); pinned so a forged or truncated error never becomes a named refusal.
		await expect(
			createOrRefuse(() => Promise.reject({ code: "TAX_RATE_DUPLICATE" })),
		).rejects.toMatchObject({ code: "TAX_RATE_DUPLICATE" });
	});

	test("anything else still propagates", async () => {
		await expect(createOrRefuse(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
	});
});

describe("duplicateRateNotice — the console's words for the refusal", () => {
	test("names the class, the zone by NAME, and the rate already there", () => {
		expect(
			duplicateRateNotice("standard", "United States", { id: "std-us", rateBps: 725 }).description,
		).toBe(
			'Class "standard" already has a rate for "United States": "std-us" (7.25%). A class can have one rate per zone — edit "std-us" instead, or delete it first.',
		);
	});
});
