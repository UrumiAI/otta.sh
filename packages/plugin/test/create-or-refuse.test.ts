import { TaxRateDuplicateError } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { createOrRefuse } from "../src/admin/in-process-admin-rules-client.js";

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

	test("an object that only claims the code is a GENERIC 409 — nothing unverified is named", async () => {
		for (const thrown of [
			{ code: "TAX_RATE_DUPLICATE" },
			{ code: "TAX_RATE_DUPLICATE", existingRateId: 7, existingRateBps: 725 },
			{ code: "TAX_RATE_DUPLICATE", existingRateId: "x", existingRateBps: "725" },
		]) {
			expect(await createOrRefuse(() => Promise.reject(thrown))).toEqual({
				ok: false,
				status: 409,
			});
		}
	});

	test("anything else still propagates", async () => {
		await expect(createOrRefuse(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
	});
});
