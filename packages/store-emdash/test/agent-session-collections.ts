/**
 * The agent-session store's storage layout for the test tiers, built from the
 * adapter's own declaration (never restated), as every other `*-collections.ts`.
 */
import { AGENT_SESSION_COLLECTIONS } from "../src/index.js";
import type { StorageLayout } from "./describe-each-dialect.js";

function toEntry(index: string | readonly string[]): string | string[] {
	return typeof index === "string" ? index : [...index];
}

export const AGENT_SESSION_LAYOUT: StorageLayout = Object.fromEntries(
	Object.entries(AGENT_SESSION_COLLECTIONS).map(([name, declaration]) => [
		name,
		{
			indexes: (declaration.indexes ?? []).map(toEntry),
			uniqueIndexes: (declaration.uniqueIndexes ?? []).map(toEntry),
		},
	]),
);
