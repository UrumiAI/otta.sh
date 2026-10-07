/**
 * The declared storage layout the cart suites inject: the cart collections
 * (`src`'s own `CART_COLLECTIONS`) PLUS the inventory ones, because every cart
 * suite drives the cart store over a real `EmdashInventoryStore`.
 *
 * Both halves are derived from `src` rather than restated. That derivation is the
 * point: a declared index is a **read contract** (a `where`/`orderBy` on an
 * undeclared field is a runtime `StorageQueryError`, and `listExpired` queries
 * `holdExpiresAt`), so the harness's allow-list and the list the plugin descriptor
 * will declare must be the same object, not two lists that agree today.
 */
import { CART_COLLECTIONS, INVENTORY_COLLECTIONS } from "../src/index.js";
import type { StorageLayout } from "./describe-each-dialect.js";

function toLayout(
	declarations: Readonly<
		Record<string, { indexes?: readonly string[]; uniqueIndexes?: readonly string[] }>
	>,
): StorageLayout {
	return Object.fromEntries(
		Object.entries(declarations).map(([name, declaration]) => [
			name,
			{
				indexes: [...(declaration.indexes ?? [])],
				uniqueIndexes: [...(declaration.uniqueIndexes ?? [])],
			},
		]),
	);
}

/** What a cart suite needs: the cart collections plus the inventory authority's. */
export const CART_LAYOUT: StorageLayout = {
	...toLayout(INVENTORY_COLLECTIONS),
	...toLayout(CART_COLLECTIONS),
};
