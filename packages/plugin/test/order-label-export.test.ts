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

// ADR-0033: the console spells a number itself only for a row from a server older
// than the wire field (`orderNumberOf`). Pinned here, where both packages are in
// reach, so that fallback cannot drift from the domain's `orderNumber`.
describe("the console's order-number fallback", () => {
	test("matches the domain's orderNumber", async () => {
		const { orderNumber } = await import("@otta-sh/domain");
		const { orderNumberOf } = await import("@otta-sh/admin-presentation");
		for (const id of [crypto.randomUUID(), crypto.randomUUID(), "ord-1", "ab"]) {
			expect(orderNumberOf({ id })).toBe(orderNumber(id));
		}
	});
});
