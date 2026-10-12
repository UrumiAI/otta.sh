/**
 * The settings documents: one singleton the operator edits, and one claim per
 * mutation key.
 *
 * The SQL held a `settings` table whose primary key was a literal `'singleton'`
 * and a `settings_mutations` idempotency ledger keyed by the mutation key, and it
 * wrote both inside ONE transaction. There is no transaction here, so the two
 * writes become two documents:
 *
 * | Document | What it is |
 * |---|---|
 * | `settings/store` | the current operational settings |
 * | `settings_mutations/{idempotencyKey}` | one mutation's INTENT, and — written exactly once, after a settings write lands — its result |
 *
 * **The claim separates DECIDED from LANDED, and only the landed half is an
 * answer.** On create it carries the patch and the settings revision its creator
 * read, and nothing else: both are written once and never rewritten, and a claim in
 * that state means "this mutation was admitted, against that revision, and has not
 * landed yet". `result` is assigned exactly once, by a compare-and-set that runs
 * only after the settings write it describes has committed — so a recorded result is
 * always a value that really was applied, and two callers of one key can never be
 * handed different answers.
 *
 * **`decidedRevision` is what keeps a stale completion from clobbering.** A caller
 * that did not create the claim may only apply it by a compare-and-set at exactly
 * that revision; if the revision has moved, the patch was computed against a state
 * that no longer exists and the completion is refused (see
 * `SettingsMutationSupersededError`). Because the pin is to one revision, a
 * non-creator completion can succeed **at most once, ever** — applying it moves the
 * revision it was pinned to — so the patch can never be applied twice.
 *
 * That is the whole reason the claim does not carry a pre-computed result. The SQL
 * could store the merged values at claim time because the claim and the upsert were
 * one transaction, so "claimed" and "applied" were the same instant. Split across
 * two documents they are not, and a result recorded before the write is a
 * PROVISIONAL one: if that write is then lost to a peer, the mutation has to be
 * re-decided against a newer base, and anything that read the provisional value
 * holds an answer no state ever had.
 *
 * **A claim is a once-only record, not a lease**, which is why ADR-0019's
 * cross-cutting rule (a) does not bind it: nobody can take it over, so there is no
 * owner token to re-assert. The guard on the only value-bearing write is the
 * settings document's own revision, re-read on every attempt and used immediately
 * after, which is what rule (a) asks for.
 */
import type { OperationalSettings, TaxSettings } from "@otta-sh/domain";
import { DEFAULT_OPERATIONAL_SETTINGS, readStoreCurrency, readTaxSettings } from "@otta-sh/domain";

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
	/** The tax options (ADR-0032). Absent on every document written before PR 2a —
	 *  and on any store that never saved them: that is "never saved", not "off". */
	readonly tax?: TaxSettings;
	/** The store currency. Absent on every document written before it existed —
	 *  and on any store that never saved one: that is "never saved" (USD). */
	readonly currency?: string;
	readonly updatedAt: string;
}

/** The fields a mutation asked to change. An absent field means "keep what is there". */
export interface SettingsPatchDoc {
	readonly holdTtlMinutes?: number;
	readonly lowStockThreshold?: number;
	/** Replaces the whole tax block. */
	readonly tax?: TaxSettings;
	readonly currency?: string;
}

/**
 * `settings_mutations/{idempotencyKey}` — one mutation's intent, then its outcome.
 *
 * `patch` is written once, on create, and never rewritten. `result` is `null` until
 * a settings write lands and is then assigned exactly once. The pair IS the
 * decided/landed distinction this store depends on.
 */
export interface SettingsMutationDoc {
	readonly patch: SettingsPatchDoc;
	/**
	 * The `settings/store` revision the CREATOR read before claiming, or `null` if the
	 * document did not exist. Single-assigned: it is what a later completion is pinned
	 * to, and rewriting it would be rewriting the decision.
	 */
	readonly decidedRevision: string | null;
	readonly createdAt: string;
	/** The settings this mutation actually applied, or `null` while un-landed. */
	readonly result: OperationalSettings | null;
	/** The `settings/store` revision the applying write produced. */
	readonly appliedRevision: string | null;
	readonly appliedAt: string | null;
	/**
	 * When a non-creator found the settings past {@link decidedRevision} and refused.
	 * A terminal marker, never written over a LANDED result — and ignored by the
	 * claim's own creator, whose intent is still live.
	 */
	readonly supersededAt: string | null;
}

/** Drop the keys a caller left undefined, so the stored intent says what it meant. */
export function toPatchDoc(patch: Partial<OperationalSettings>): SettingsPatchDoc {
	const doc: {
		holdTtlMinutes?: number;
		lowStockThreshold?: number;
		tax?: TaxSettings;
		currency?: string;
	} = {};
	if (patch.holdTtlMinutes !== undefined) doc.holdTtlMinutes = patch.holdTtlMinutes;
	if (patch.lowStockThreshold !== undefined) doc.lowStockThreshold = patch.lowStockThreshold;
	// Re-read through the domain's reader, so the stored block has exactly its fields
	// in one key order (the no-op check compares blocks by value).
	const tax = readTaxSettings(patch.tax);
	if (tax !== undefined) doc.tax = tax;
	const currency = readStoreCurrency(patch.currency);
	if (currency !== undefined) doc.currency = currency;
	return doc;
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
	return withOptional(
		{
			holdTtlMinutes: doc.holdTtlMinutes ?? DEFAULT_OPERATIONAL_SETTINGS.holdTtlMinutes,
			lowStockThreshold: doc.lowStockThreshold ?? DEFAULT_OPERATIONAL_SETTINGS.lowStockThreshold,
		},
		readTaxSettings(doc.tax),
		readStoreCurrency(doc.currency),
	);
}

/**
 * Apply a partial patch: every field the caller omitted keeps its current value.
 *
 * The patch holds ABSOLUTE values rather than deltas, so re-merging it over a newer
 * base is what every losing attempt does. Merging cannot revert a field this patch
 * OMITS, because an omitted field is read from the base — it says nothing about the
 * fields the patch names, which is why a completion by anyone but the claim's creator
 * is pinned to the revision it was decided against.
 */
export function mergeSettings(
	base: OperationalSettings,
	patch: SettingsPatchDoc,
): OperationalSettings {
	return withOptional(
		{
			holdTtlMinutes: patch.holdTtlMinutes ?? base.holdTtlMinutes,
			lowStockThreshold: patch.lowStockThreshold ?? base.lowStockThreshold,
		},
		patch.tax ?? base.tax,
		patch.currency ?? base.currency,
	);
}

/** The settings with `tax` and `currency` only when there is one: absent stays
 *  absent (each is "never saved" when missing, never a default). */
function withOptional(
	settings: OperationalSettings,
	tax: TaxSettings | undefined,
	currency: string | undefined,
): OperationalSettings {
	const out: OperationalSettings = tax === undefined ? settings : { ...settings, tax };
	return currency === undefined ? out : { ...out, currency };
}
