/**
 * The declared storage layout the rules suites inject, derived from `src`'s own
 * `SHIPPING_RULES_COLLECTIONS` / `TAX_RULES_COLLECTIONS` rather than restated
 * here.
 *
 * The derivation matters even though both declarations are EMPTY: "no declared
 * index" is a read contract too, and it is the one these stores are written
 * against — a `where` or `orderBy` on any field would be a runtime
 * `StorageQueryError`, which is why both stores order in code after an
 * unfiltered paged scan. A layout restated by hand could gain an index the
 * descriptor never declares, and the suites would then be proving a read the
 * plugin cannot issue.
 */
import { SHIPPING_RULES_COLLECTIONS, TAX_RULES_COLLECTIONS } from "../src/index.js";
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

/** The zone aggregate and the method-id claim. */
export const SHIPPING_RULES_LAYOUT: StorageLayout = toLayout(SHIPPING_RULES_COLLECTIONS);

/** The class aggregate and the rate-id claim. */
export const TAX_RULES_LAYOUT: StorageLayout = toLayout(TAX_RULES_COLLECTIONS);

/** Both, for a suite that drives the pair. */
export const RULES_LAYOUT: StorageLayout = { ...SHIPPING_RULES_LAYOUT, ...TAX_RULES_LAYOUT };
