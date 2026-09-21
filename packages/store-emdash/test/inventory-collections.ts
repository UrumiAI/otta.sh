/**
 * The declared storage layout the inventory suites inject, derived from `src`'s
 * own `INVENTORY_COLLECTIONS` rather than restated here.
 *
 * That derivation is the point: a declared index is a **read contract** (a
 * `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`), so
 * the harness's allow-list and the list the plugin descriptor will declare must
 * be the same object, not two lists that agree today.
 */
import { INVENTORY_COLLECTIONS } from "../src/index.js";
import type { StorageLayout } from "./describe-each-dialect.js";

export const INVENTORY_LAYOUT: StorageLayout = Object.fromEntries(
	Object.entries(INVENTORY_COLLECTIONS).map(([name, declaration]) => [
		name,
		{
			indexes: [...(declaration.indexes ?? [])],
			uniqueIndexes: [...(declaration.uniqueIndexes ?? [])],
		},
	]),
);
