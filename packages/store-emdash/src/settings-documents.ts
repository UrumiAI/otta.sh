/**
 * The settings documents: one singleton the operator edits, and one claim per
 * mutation key.
 *
 * The SQL held a `settings` table whose primary key was a literal `'singleton'`
 * and a `settings_mutations` idempotency ledger keyed by the mutation key, and it
 * wrote both inside ONE transaction. There is no transaction here, so the two
 * writes become two documents and the claim carries what a replayer needs to
 * finish the pair:
 *
 * | Document | What it is |
 * |---|---|
 * | `settings/store` | the current operational settings |
 * | `settings_mutations/{idempotencyKey}` | the recorded result of one mutation, and the revision it was computed against |
 *
 * **The claim records the RESULT, not the patch.** That is the SQL's own choice —
 * its ledger row stored `hold_ttl_minutes` and `low_stock_threshold`, the merged
 * values, not the fields the caller sent — and it is what makes a replay cheap and
 * exact: the answer is read out of the claim, nothing is recomputed, and a stale
 * replay arriving after a newer update cannot clobber it back.
 *
 * **`baseRevision` is the one field the SQL had no need for.** Inside a
 * transaction, reading the current settings and upserting them was atomic; here a
 * crash can land between the claim and the settings write, and a later replayer has
 * to be able to finish the pair WITHOUT double-applying over a newer update. The
 * revision the result was computed against is exactly that guard: the completing
 * write is a compare-and-set pinned to it, so it applies if nothing has moved and
 * is a no-op if something has. `null` means the settings document did not exist
 * yet, which makes the completion a create-if-absent — the same guard, at the other
 * end.
 */
import type { OperationalSettings } from "@otta-sh/domain";
import { DEFAULT_OPERATIONAL_SETTINGS } from "@otta-sh/domain";

/** Collection name: the settings singleton. */
export const SETTINGS_COLLECTION = "settings";
/** Collection name: the mutation idempotency ledger. */
export const SETTINGS_MUTATIONS_COLLECTION = "settings_mutations";

/** The singleton's document id — the SQL's `'singleton'` primary key, renamed. */
export const SETTINGS_DOC_ID = "store";

/** One collection as the plugin descriptor declares it. */
export interface SettingsCollectionIndexDeclaration {
	readonly indexes?: readonly string[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The two settings collections. Neither declares an index: the singleton is read
 * by its fixed id and a mutation by its key, so there is no query to serve.
 */
export const SETTINGS_COLLECTIONS: Readonly<Record<string, SettingsCollectionIndexDeclaration>> = {
	[SETTINGS_COLLECTION]: {},
	[SETTINGS_MUTATIONS_COLLECTION]: {},
};

/** `settings/store` — the current operational settings. */
export interface SettingsDoc {
	readonly holdTtlMinutes: number;
	readonly lowStockThreshold: number;
	readonly updatedAt: string;
}

/** `settings_mutations/{idempotencyKey}` — one mutation's recorded outcome. */
export interface SettingsMutationDoc {
	readonly holdTtlMinutes: number;
	readonly lowStockThreshold: number;
	/**
	 * The `settings/store` revision this result was computed against, or `null` if
	 * the document did not exist yet. The completing write is pinned to it.
	 */
	readonly baseRevision: string | null;
	readonly createdAt: string;
}

/**
 * The port's shape for an absent document: the domain defaults, never an error.
 *
 * A field missing from a stored document falls back to its default for the same
 * reason the absent document does — the port promises `get` defaults unset fields,
 * and a partially written document is the same condition as an unwritten one.
 */
export function toOperationalSettings(doc: SettingsDoc | null): OperationalSettings {
	if (doc === null) return { ...DEFAULT_OPERATIONAL_SETTINGS };
	return {
		holdTtlMinutes: doc.holdTtlMinutes ?? DEFAULT_OPERATIONAL_SETTINGS.holdTtlMinutes,
		lowStockThreshold: doc.lowStockThreshold ?? DEFAULT_OPERATIONAL_SETTINGS.lowStockThreshold,
	};
}

/** The recorded result of a mutation, as the port returns it. */
export function toRecordedSettings(doc: SettingsMutationDoc): OperationalSettings {
	return { holdTtlMinutes: doc.holdTtlMinutes, lowStockThreshold: doc.lowStockThreshold };
}

/**
 * Apply a partial patch: every field the caller omitted keeps its current value.
 *
 * The patch holds ABSOLUTE values rather than deltas, which is why applying the
 * same one twice is harmless in itself — the guard `baseRevision` provides is
 * against clobbering a NEWER update, not against arithmetic.
 */
export function mergeSettings(
	base: OperationalSettings,
	patch: Partial<OperationalSettings>,
): OperationalSettings {
	return {
		holdTtlMinutes: patch.holdTtlMinutes ?? base.holdTtlMinutes,
		lowStockThreshold: patch.lowStockThreshold ?? base.lowStockThreshold,
	};
}
