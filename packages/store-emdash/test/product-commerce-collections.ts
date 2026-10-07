/**
 * The declared storage layout the product-commerce suites inject, derived from
 * `src`'s own constants rather than restated here.
 *
 * That derivation is the point: a declared index is a **read contract** (a
 * `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`), so
 * the harness's allow-list and the list the plugin descriptor will declare must
 * be the same object, not two lists that agree today.
 *
 * The INVENTORY collections are part of the layout because this store shares them
 * rather than duplicating them: the stock projections read `inventory`, and the
 * sku-rename carry reads and writes it plus the `inventory_movements` audit trail.
 */
import { INVENTORY_COLLECTIONS, PRODUCT_COMMERCE_COLLECTIONS } from "../src/index.js";
import type { StorageLayout } from "./describe-each-dialect.js";

export const PRODUCT_COMMERCE_LAYOUT: StorageLayout = Object.fromEntries(
	Object.entries({ ...INVENTORY_COLLECTIONS, ...PRODUCT_COMMERCE_COLLECTIONS }).map(
		([name, declaration]) => [
			name,
			{
				indexes: [...(declaration.indexes ?? [])],
				uniqueIndexes: [...(declaration.uniqueIndexes ?? [])],
			},
		],
	),
);
