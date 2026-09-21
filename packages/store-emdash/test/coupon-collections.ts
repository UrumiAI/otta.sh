/**
 * The declared storage layout the coupon suites inject, derived from `src`'s own
 * `COUPON_COLLECTIONS` rather than restated here.
 *
 * That derivation is the point: a declared index is a **read contract** (a
 * `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`, and
 * this store filters on `couponId`, `orderId`, `holdsUse` and `redemptionId` while
 * ORDERING on `createdAt`), so the harness's allow-list and the list the plugin
 * descriptor will declare must be the same object, not two lists that agree today.
 *
 * `COUPON_LIFECYCLE_LAYOUT` adds the order, cart and inventory collections, because
 * the lifecycle suite drives a real checkout end to end: the coupon is redeemed and
 * released by the order use-cases, not by direct store calls.
 */
import {
	CART_COLLECTIONS,
	COUPON_COLLECTIONS,
	INVENTORY_COLLECTIONS,
	ORDER_COLLECTIONS,
} from "../src/index.js";
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

/** What a coupon-only suite needs: the four coupon collections. */
export const COUPON_LAYOUT: StorageLayout = toLayout(COUPON_COLLECTIONS);

/** The coupon collections plus everything a real checkout walks. */
export const COUPON_LIFECYCLE_LAYOUT: StorageLayout = {
	...toLayout(INVENTORY_COLLECTIONS),
	...toLayout(CART_COLLECTIONS),
	...toLayout(ORDER_COLLECTIONS),
	...COUPON_LAYOUT,
};
