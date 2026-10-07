/**
 * The declared storage layout the order suites inject: the order collections
 * (`src`'s own `ORDER_COLLECTIONS`) PLUS the cart and inventory ones, because
 * every order suite drives a real checkout — cart → order → hold adoption — over
 * the real `EmdashCartStore` and `EmdashInventoryStore`.
 *
 * All three halves are derived from `src` rather than restated. That derivation is
 * the point: a declared index is a **read contract** (a `where`/`orderBy` on an
 * undeclared field is a runtime `StorageQueryError`, and `listExpirable` queries
 * `state` + `holdExpiresAt`), so the harness's allow-list and the list the plugin
 * descriptor will declare must be the same object, not two lists that agree today.
 *
 * `orders` declares one COMPOSITE index (`["state", "createdAt"]`), which the
 * inventory and cart collections never needed — hence the local `toLayout` here
 * accepting `string | readonly string[]` entries. The host folds a composite into
 * the queryable-field allow-list field by field, exactly as `describe-each-dialect`
 * already passes `[...indexes, ...uniqueIndexes]` through to the repository.
 */
import { CART_COLLECTIONS, INVENTORY_COLLECTIONS, ORDER_COLLECTIONS } from "../src/index.js";
import type { StorageLayout } from "./describe-each-dialect.js";

type Declarations = Readonly<
	Record<
		string,
		{
			readonly indexes?: readonly (string | readonly string[])[];
			readonly uniqueIndexes?: readonly (string | readonly string[])[];
		}
	>
>;

/** One declared index: a field name, or a composite's field list. */
function toEntry(index: string | readonly string[]): string | string[] {
	return typeof index === "string" ? index : [...index];
}

function toLayout(declarations: Declarations): StorageLayout {
	return Object.fromEntries(
		Object.entries(declarations).map(([name, declaration]) => [
			name,
			{
				indexes: (declaration.indexes ?? []).map(toEntry),
				uniqueIndexes: (declaration.uniqueIndexes ?? []).map(toEntry),
			},
		]),
	);
}

/** What an order suite needs: orders plus the two aggregates a checkout touches. */
export const ORDER_LAYOUT: StorageLayout = {
	...toLayout(INVENTORY_COLLECTIONS),
	...toLayout(CART_COLLECTIONS),
	...toLayout(ORDER_COLLECTIONS),
};
