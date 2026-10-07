/**
 * The declared storage layout the entitlement, payment-event, settings and
 * order-note suites inject, derived from `src`'s own declarations rather than
 * restated here.
 *
 * That derivation is the point: a declared index is a **read contract** (a
 * `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`, and
 * these stores filter on `orderId`, `buyerRefLower`, `sku` and `state`), so the
 * harness's allow-list and the list the plugin descriptor will declare must be the
 * same object, not two lists that agree today.
 */
import {
	ENTITLEMENT_COLLECTIONS,
	ORDER_NOTES_COLLECTIONS,
	PAYMENT_EVENT_COLLECTIONS,
	SETTINGS_COLLECTIONS,
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

/** What every suite in this tier needs: all seven collections at once. */
export const MISC_LAYOUT: StorageLayout = toLayout({
	...ENTITLEMENT_COLLECTIONS,
	...PAYMENT_EVENT_COLLECTIONS,
	...SETTINGS_COLLECTIONS,
	...ORDER_NOTES_COLLECTIONS,
});

/**
 * The same layout with every `entitlements` index REMOVED.
 *
 * It exists so one case can prove the declaration is load-bearing rather than
 * decorative: the delivery gate's fallback query binds four fields, and over this
 * layout it raises `StorageQueryError` instead of answering. That is the
 * document-store equivalent of the SQL tier's EXPLAIN assertions — there is no
 * physical index in any tier here, so "the index serves the predicate" can only be
 * checked as "the read contract admits it".
 */
export const MISC_LAYOUT_WITHOUT_ENTITLEMENT_INDEXES: StorageLayout = {
	...MISC_LAYOUT,
	entitlements: { indexes: [], uniqueIndexes: [] },
};
