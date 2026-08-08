import { isValidLowStockThreshold, MAX_LOW_STOCK_THRESHOLD } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import {
	lowStockQuery,
	productListFilterSchema,
	productsListQuery,
	settingsBody,
} from "../src/schemas.js";

// The FAST LOOP half of the low-stock query-parameter guard (port doc, the
// admin Products list filter). The HTTP half — that a bad value 400s rather
// than 500s against a live server, and that a valid one actually filters —
// lives in `admin-products-http.test.ts`, which is `describe.skipIf(PG ===
// undefined)`. These cases need no server and no database, so they fire on
// every local run: if `lowStockThreshold` ever loses its constraint again (it
// was once absent from `productListFilterSchema` while
// `lowStockQuery`/`settingsBody` already had it), this file goes red
// immediately.

describe("productsListQuery reads `lowStockThreshold` off the raw query string as DIGITS, not by coercion", () => {
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

	test("REJECTS `?lowStockThreshold=` — an EMPTY value is not a threshold of zero", () => {
		// THE ONE `Number()` WOULD HAVE WAVED THROUGH, and the reason this field
		// gates on digits instead of coercing. `Number("")` is 0, a perfectly
		// valid threshold, so an empty parameter would have narrowed the list to
		// out-of-stock rows — silently, and to the one answer an operator who
		// typed nothing cannot have meant. Absent and empty must not diverge.
		const res = productsListQuery.safeParse({ lowStockThreshold: "" });
		expect(res.success).toBe(false);
	});

	test("REJECTS the other shapes `Number()` accepts — hex, exponent, and padded digits", () => {
		// `Number` reads "0x10" as 16, "1e2" as 100 and " 7 " as 7. None of those
		// is a threshold a query string should be allowed to express: the value
		// an operator sees in the URL would not be the value the predicate uses.
		for (const bad of ["0x10", "1e2", " 7 ", "+7", "7 "]) {
			const res = productsListQuery.safeParse({ lowStockThreshold: bad });
			expect(res.success, bad).toBe(false);
		}
	});

	test("REJECTS a threshold above int4 — digits alone are not the whole domain", () => {
		// `inventory.on_hand` is a Postgres `integer` and the predicate binds the
		// threshold straight into `on_hand <= $1`. Above `int4`'s maximum Postgres
		// throws on the bind while better-sqlite3 and the fake accept it and
		// answer — the three-way dialect disagreement the port's guard exists to
		// make unreachable, arriving as a 500 through the very catch that turns a
		// bad threshold into a 400. A shape gate does not stop it; the bound does.
		expect(
			productsListQuery.safeParse({ lowStockThreshold: String(MAX_LOW_STOCK_THRESHOLD) }).success,
		).toBe(true);
		expect(
			productsListQuery.safeParse({ lowStockThreshold: String(MAX_LOW_STOCK_THRESHOLD + 1) })
				.success,
		).toBe(false);
		expect(productsListQuery.safeParse({ lowStockThreshold: "99999999999999" }).success).toBe(
			false,
		);
	});
});

describe("the ceiling is the SAME number everywhere it is enforced", () => {
	test("the domain guard agrees with the wire, at the boundary and one past it", () => {
		// ONE DEFINITION, THREE LAYERS. The query string, the cursor-embedded
		// filter and the port's own guard all bound on `MAX_LOW_STOCK_THRESHOLD`;
		// a value the wire lets through and the guard refuses (or the reverse) is
		// the drift `isValidLowStockThreshold` was extracted to prevent.
		expect(isValidLowStockThreshold(MAX_LOW_STOCK_THRESHOLD)).toBe(true);
		expect(isValidLowStockThreshold(MAX_LOW_STOCK_THRESHOLD + 1)).toBe(false);
		expect(isValidLowStockThreshold(Number.MAX_SAFE_INTEGER)).toBe(false);
		// ...and the three schemas draw the line in the same place.
		expect(
			productListFilterSchema.safeParse({ lowStockThreshold: MAX_LOW_STOCK_THRESHOLD }).success,
		).toBe(true);
		expect(
			productListFilterSchema.safeParse({ lowStockThreshold: MAX_LOW_STOCK_THRESHOLD + 1 }).success,
		).toBe(false);
		expect(lowStockQuery.safeParse({ threshold: String(MAX_LOW_STOCK_THRESHOLD) }).success).toBe(
			true,
		);
		expect(
			lowStockQuery.safeParse({ threshold: String(MAX_LOW_STOCK_THRESHOLD + 1) }).success,
		).toBe(false);
	});

	test("the SETTINGS WRITE is bounded too — the saved value is what every later read binds", () => {
		// THE PATH THAT NEVER APPEARS IN A URL. An operator saves the threshold
		// once; every subsequent list read then binds that stored number into the
		// predicate. An unbounded write is therefore the same int4 overflow with a
		// longer fuse, and the one the query-string gate cannot see.
		expect(settingsBody.safeParse({ lowStockThreshold: MAX_LOW_STOCK_THRESHOLD }).success).toBe(
			true,
		);
		expect(settingsBody.safeParse({ lowStockThreshold: MAX_LOW_STOCK_THRESHOLD + 1 }).success).toBe(
			false,
		);
		expect(settingsBody.safeParse({ lowStockThreshold: Number.MAX_SAFE_INTEGER }).success).toBe(
			false,
		);
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
