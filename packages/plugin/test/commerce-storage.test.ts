/**
 * The declared collection set.
 *
 * It is assembled by spreading the adapter modules' own per-aggregate
 * declarations, and a spread has one failure mode worth pinning: if two modules
 * declared the same collection, one module's index list would silently win and the
 * loser's reads would fail at runtime on a field it believed it had declared — a
 * declared index being a read contract rather than a performance knob. So the
 * disjointness is asserted rather than assumed, by rebuilding the union the long
 * way and comparing counts.
 */
import { describe, expect, test } from "vitest";
import {
	CART_COLLECTIONS,
	COUPON_COLLECTIONS,
	ENTITLEMENT_COLLECTIONS,
	IDENTITY_COLLECTIONS,
	INVENTORY_COLLECTIONS,
	ORDER_COLLECTIONS,
	ORDER_NOTES_COLLECTIONS,
	PAYMENT_EVENT_COLLECTIONS,
	PRODUCT_COMMERCE_COLLECTIONS,
	REPORTING_COLLECTIONS,
	RULES_COLLECTIONS,
	SETTINGS_COLLECTIONS,
} from "@otta-sh/store-emdash";
import {
	COMMERCE_STORAGE_COLLECTION_NAMES,
	COMMERCE_STORAGE_COLLECTIONS,
} from "../src/commerce/commerce-storage.js";

/** The same twelve declarations the module spreads, as a list of name lists. */
const SOURCES = [
	INVENTORY_COLLECTIONS,
	CART_COLLECTIONS,
	ORDER_COLLECTIONS,
	ORDER_NOTES_COLLECTIONS,
	PRODUCT_COMMERCE_COLLECTIONS,
	COUPON_COLLECTIONS,
	RULES_COLLECTIONS,
	IDENTITY_COLLECTIONS,
	ENTITLEMENT_COLLECTIONS,
	PAYMENT_EVENT_COLLECTIONS,
	SETTINGS_COLLECTIONS,
	REPORTING_COLLECTIONS,
];

describe("the declared commerce collections", () => {
	test("no collection is declared twice — nothing is silently overwritten by the spread", () => {
		const declared = SOURCES.flatMap((source) => Object.keys(source));
		const duplicates = declared.filter((name, index) => declared.indexOf(name) !== index);
		expect(duplicates).toEqual([]);
		// And the union really is the sum of its parts.
		expect(COMMERCE_STORAGE_COLLECTION_NAMES).toHaveLength(declared.length);
	});

	test("every declared index survives the assembly, composites included", () => {
		for (const source of SOURCES) {
			for (const [name, declaration] of Object.entries(source)) {
				const assembled = COMMERCE_STORAGE_COLLECTIONS[name];
				expect(assembled, name).toBeDefined();
				expect(assembled?.indexes ?? [], name).toEqual(declaration.indexes ?? []);
				expect(assembled?.uniqueIndexes ?? [], name).toEqual(declaration.uniqueIndexes ?? []);
			}
		}
	});

	test("the set covers the aggregates the storefront surface reads and writes", () => {
		// A spot check with a purpose: these six are the ones a missing declaration
		// would break at runtime rather than at construction, because the composition
		// asks for them by name only when a method is first called.
		for (const name of [
			"inventory",
			"carts",
			"orders",
			"product_commerce",
			"sessions",
			"customers",
		]) {
			expect(COMMERCE_STORAGE_COLLECTION_NAMES, name).toContain(name);
		}
	});
});
