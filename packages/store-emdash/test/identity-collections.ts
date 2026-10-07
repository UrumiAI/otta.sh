/**
 * The declared storage layout the identity suites inject, derived from `src`'s own
 * `IDENTITY_COLLECTIONS` rather than restated here.
 *
 * That derivation is the point: a declared index is a **read contract** (a
 * `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`, and
 * these stores filter on `emailLower`, `customerId`, `consumed` and `expiresAt`),
 * so the harness's allow-list and the list the plugin descriptor will declare must
 * be the same object, not two lists that agree today.
 */
import { IDENTITY_COLLECTIONS } from "../src/index.js";
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

/** What every identity suite needs: the five identity collections. */
export const IDENTITY_LAYOUT: StorageLayout = toLayout(IDENTITY_COLLECTIONS);
