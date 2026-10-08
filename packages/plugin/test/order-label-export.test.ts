import { orderLabel as domainOrderLabel } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { ORDER_LABEL_FALLBACK, orderLabel } from "../src/index.js";

// The storefront depends on `@otta-sh/plugin` alone, and it names a shopper's
// order the way the order emails do — by its products, never its id. It must
// reach the domain's ONE `orderLabel`, re-exported, not a second copy that could
// spell the same order differently.
describe("orderLabel re-export", () => {
	test("is the domain's own function, not a copy", () => {
		expect(orderLabel).toBe(domainOrderLabel);
	});

	test("names an order by its products", () => {
		expect(orderLabel([{ title: "Otta Tee", quantity: 2 }])).toBe("Otta Tee × 2");
		expect(orderLabel([])).toBe(ORDER_LABEL_FALLBACK);
	});
});

// ADR-0033: the console's tie-breakers and number matcher (admin-presentation,
// which depends on nothing) mirror the domain's number length. Pinned here, where
// both packages are in reach, so the two cannot drift.
describe("the order number length", () => {
	test("admin-presentation and the domain agree", async () => {
		const domain = await import("@otta-sh/domain");
		const presentation = await import("@otta-sh/admin-presentation");
		expect(presentation.ORDER_NUMBER_LENGTH).toBe(domain.ORDER_NUMBER_LENGTH);
	});
});
