/**
 * The declared commerce collections, in the shape the adapter package's dialect
 * harness takes.
 *
 * DERIVED, NEVER RESTATED. `COMMERCE_STORAGE_COLLECTIONS` is the one list a
 * deployment declares and the adapters query, and a declared index is a read
 * contract rather than a performance knob — so a test-side copy of it would be a
 * copy that silently stops matching. This converts, and converts only: the
 * declarations are readonly and may carry a composite entry (a multi-field
 * ordering), while the harness takes mutable arrays, so each entry is copied out
 * at exactly that boundary and nothing is renamed, added or dropped on the way.
 */
import type { StorageLayout } from "@otta-sh/store-emdash/testing";
import { COMMERCE_STORAGE_COLLECTIONS } from "../../src/commerce/commerce-storage.js";

export function commerceStorageLayout(): StorageLayout {
	return Object.fromEntries(
		Object.entries(COMMERCE_STORAGE_COLLECTIONS).map(([name, declaration]) => [
			name,
			{
				indexes: (declaration.indexes ?? []).map(copy),
				uniqueIndexes: (declaration.uniqueIndexes ?? []).map(copy),
			},
		]),
	);
}

function copy(index: string | readonly string[]): string | string[] {
	return typeof index === "string" ? index : [...index];
}
