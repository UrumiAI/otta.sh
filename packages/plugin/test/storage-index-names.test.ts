/**
 * What UPGRADING.md ("EmDash 1.3.1 to 1.5.0") relies on about Otta's storage
 * declaration, pinned so a later edit cannot quietly break it.
 *
 * - NO `uniqueIndexes`. EmDash's migration `095_plugin_storage_unique_scope` only
 *   touches tracked unique indexes, and its maintenance window applies only to a
 *   site that has them. Otta's once-only rules are create-if-absent documents.
 * - EVERY index name fits in 63 characters. EmDash 1.5.0's `generateIndexName`
 *   (`src/database/plugin-storage-index-name.ts`) names a declared index
 *   `idx_plugin_<plugin>_<collection>_<fields joined by _>` and HASHES any name
 *   longer than 63 characters, which renames (rebuilds) it on the next index sync.
 *   The rule is restated here because EmDash does not export it; the host builds a
 *   lookup index per distinct `indexes` entry (`getStorageIndexDefinitions`).
 */
import { describe, expect, test } from "vitest";
import { COMMERCE_STORAGE_COLLECTIONS, OTTA_PLUGIN_ID } from "../src/index.js";

const MAX_UNHASHED_NAME = 63;

/** EmDash 1.5.0's name for a declared, non-unique index (before the hash fallback). */
function hostLookupIndexName(
	pluginId: string,
	collection: string,
	fields: readonly string[],
): string {
	return `idx_plugin_${pluginId}_${collection}_${fields.join("_")}`;
}

/** Every `[collection, index name]` the host would build for a layout. */
function declaredIndexNames(
	layout: Readonly<Record<string, { readonly indexes?: readonly (string | readonly string[])[] }>>,
	pluginId: string,
): Array<[string, string]> {
	return Object.entries(layout).flatMap(([collection, declaration]) =>
		(declaration.indexes ?? []).map((entry): [string, string] => [
			collection,
			hostLookupIndexName(pluginId, collection, typeof entry === "string" ? [entry] : entry),
		]),
	);
}

describe("Otta's storage indexes under EmDash 1.5.0's naming", () => {
	test("no collection declares uniqueIndexes", () => {
		const withUnique = Object.entries(COMMERCE_STORAGE_COLLECTIONS)
			.filter(([, declaration]) => (declaration.uniqueIndexes ?? []).length > 0)
			.map(([collection]) => collection);
		expect(withUnique).toEqual([]);
	});

	test("every declared index keeps its readable name (63 characters or fewer)", () => {
		const names = declaredIndexNames(COMMERCE_STORAGE_COLLECTIONS, OTTA_PLUGIN_ID);
		expect(names.length).toBeGreaterThan(0);
		const tooLong = names.filter(([, name]) => name.length > MAX_UNHASHED_NAME);
		expect(tooLong).toEqual([]);
	});

	test("the check catches a name that would be hashed", () => {
		const names = declaredIndexNames(
			{ orders_with_a_long_collection_name: { indexes: [["customerId", "createdAt"]] } },
			OTTA_PLUGIN_ID,
		);
		expect(names[0]?.[1].length).toBeGreaterThan(MAX_UNHASHED_NAME);
	});
});
