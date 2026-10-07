/**
 * The declared storage layout the reporting suites inject: the two reporting
 * collections PLUS every collection a reporting READ touches.
 *
 * Reporting is the one adapter in this package that reads documents four other
 * adapters own. Revenue and the status counts come from `reporting_daily`, but
 * `topProducts` reads the frozen line snapshots off `orders`, `lowStock` drives
 * from `inventory`, and the live title it carries comes from `product_commerce`
 * through the `sku_owners` claim. So the layout is a union, derived from `src`'s
 * own declarations rather than restated here — a declared index is a read
 * contract, and the harness's allow-list and the descriptor's must be one object.
 *
 * The cart and order-key collections come along because the hook suites drive a
 * REAL checkout through the order store to produce the events the rollups are
 * built from.
 */
import {
	CART_COLLECTIONS,
	INVENTORY_COLLECTIONS,
	ORDER_COLLECTIONS,
	PRODUCT_COMMERCE_COLLECTIONS,
	REPORTING_COLLECTIONS,
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

/** What a reporting suite needs: the rollups plus everything a read reaches. */
export const REPORTING_LAYOUT: StorageLayout = {
	...toLayout(INVENTORY_COLLECTIONS),
	...toLayout(CART_COLLECTIONS),
	...toLayout(ORDER_COLLECTIONS),
	...toLayout(PRODUCT_COMMERCE_COLLECTIONS),
	...toLayout(REPORTING_COLLECTIONS),
};

/**
 * The same layout with every `reporting_daily` index REMOVED.
 *
 * It exists so one case can prove the declaration is load-bearing rather than
 * decorative: every read in this adapter binds the `date` range, and over this
 * layout it raises `StorageQueryError` instead of answering. There is no physical
 * index in any tier, so "the index serves the predicate" can only be checked here
 * as "the read contract admits it".
 */
export const REPORTING_LAYOUT_WITHOUT_DAILY_INDEXES: StorageLayout = {
	...REPORTING_LAYOUT,
	reporting_daily: { indexes: [], uniqueIndexes: [] },
};
