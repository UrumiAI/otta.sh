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
