import { describe, expect, test } from "vitest";
import { productListFilterSchema, productsListQuery } from "../src/schemas.js";

// The FAST LOOP half of the low-stock query-parameter guard (port doc, the
// admin Products list filter). The HTTP half — that a bad value 400s rather
// than 500s against a live server, and that a valid one actually filters —
// lives in `admin-products-http.test.ts`, which is `describe.skipIf(PG ===
// undefined)`. These cases need no server and no database, so they fire on
// every local run: if `lowStockThreshold` ever loses its constraint again
// (the regression this increment fixes — it was absent from
// `productListFilterSchema` while `lowStockQuery`/`settingsBody` already had
// it), this file goes red immediately.

describe("productsListQuery COERCES `lowStockThreshold` from the raw query string, like `limit`", () => {
	test("a valid non-negative integer string parses to a number", () => {
		const res = productsListQuery.safeParse({ lowStockThreshold: "5" });
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("unreachable");
		expect(res.data.lowStockThreshold).toBe(5);
	});

	test("zero is its own valid boundary, not falsy-and-dropped", () => {
		const res = productsListQuery.safeParse({ lowStockThreshold: "0" });
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("unreachable");
		expect(res.data.lowStockThreshold).toBe(0);
	});

	test("omitted stays omitted — no default, no coercion to 0", () => {
		const res = productsListQuery.safeParse({});
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("unreachable");
		expect(res.data.lowStockThreshold).toBeUndefined();
	});

	test("REJECTS negative, fractional, and non-numeric strings — a 400, never silently clamped", () => {
		for (const bad of ["-1", "2.5", "not-a-number", "NaN", "Infinity"]) {
			const res = productsListQuery.safeParse({ lowStockThreshold: bad });
			expect(res.success, bad).toBe(false);
		}
	});
});

describe("productListFilterSchema validates `lowStockThreshold` the same domain, one layer in (the cursor-embedded filter)", () => {
	test("a valid non-negative integer (already a real number, not a query string) passes", () => {
		const res = productListFilterSchema.safeParse({ lowStockThreshold: 5 });
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("unreachable");
		expect(res.data.lowStockThreshold).toBe(5);
	});

	test("REJECTS a negative, fractional, or non-finite number — MOD-1's re-validation of a decoded cursor", () => {
		for (const bad of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const res = productListFilterSchema.safeParse({ lowStockThreshold: bad });
			expect(res.success, String(bad)).toBe(false);
		}
	});

	test("omitted stays omitted, same as every other filter axis here", () => {
		const res = productListFilterSchema.safeParse({});
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("unreachable");
		expect(res.data.lowStockThreshold).toBeUndefined();
	});

	test("REJECTS a string — the cursor's own field is a real number, unlike the query string it started from", () => {
		const res = productListFilterSchema.safeParse({ lowStockThreshold: "5" });
		expect(res.success).toBe(false);
	});
});
