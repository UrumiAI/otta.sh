import { describe, expect, test } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { isProductSellable, unsellableReasons } from "../src/product-commerce/sellable.js";

/**
 * THE SELLABILITY RULE (#109, #166): a product can be sold only when it is live
 * (published, not deleted), priced AND titled. The title is part of the rule
 * because an order line snapshots it: `createOrderFromCart` refuses a null title,
 * so any surface that called a title-less product sellable was promising a
 * checkout that would fail at the last step.
 */
describe("the sellability rule", () => {
	const live = {
		active: true,
		deletedAt: null,
		price: money(cents(1200), currency("USD")),
		title: "Otta Tee",
	};

	test("a live, priced, titled product is sellable, with no reasons against it", () => {
		expect(isProductSellable(live)).toBe(true);
		expect(unsellableReasons(live)).toEqual([]);
	});

	test("a priced, published product with NO TITLE is not sellable — the title is part of the rule", () => {
		expect(isProductSellable({ ...live, title: null })).toBe(false);
		expect(unsellableReasons({ ...live, title: null })).toEqual(["untitled"]);
	});

	test("an empty title is no title: an order line cannot snapshot a name it does not have", () => {
		expect(isProductSellable({ ...live, title: "" })).toBe(false);
		expect(unsellableReasons({ ...live, title: "" })).toEqual(["untitled"]);
	});

	test("an unpriced product is not sellable", () => {
		expect(isProductSellable({ ...live, price: null })).toBe(false);
		expect(unsellableReasons({ ...live, price: null })).toEqual(["unpriced"]);
	});

	test("an unpublished or deleted product is not sellable (the liveness half is unchanged)", () => {
		expect(unsellableReasons({ ...live, active: false })).toEqual(["unpublished"]);
		expect(unsellableReasons({ ...live, active: false, deletedAt: new Date(0) })).toEqual([
			"deleted",
		]);
		expect(isProductSellable({ ...live, active: false })).toBe(false);
	});

	test("every missing piece is reported, deleted outranking unpublished, so a surface can say all of why", () => {
		expect(unsellableReasons({ active: false, deletedAt: null, price: null, title: null })).toEqual(
			["unpublished", "unpriced", "untitled"],
		);
	});

	test("a view with no tombstone field (the catalog read already drops deleted rows) is judged on the rest", () => {
		expect(isProductSellable({ active: true, price: live.price, title: "Otta Tee" })).toBe(true);
		expect(isProductSellable({ active: true, price: live.price, title: null })).toBe(false);
	});
});
