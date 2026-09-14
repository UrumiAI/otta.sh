/**
 * `SettingsStore` over the settings singleton and a claim per mutation key.
 *
 * The SQL did the whole of `update` inside one transaction: read current, merge,
 * claim the key with the merged values, and — as the claim's winner only — upsert
 * the settings row. There is no transaction here, so the claim and the write are two
 * documents, and the design turns on separating what was DECIDED from what LANDED:
 *
 * ```
 * claim  : settings_mutations/{key} create-if-absent, carrying the PATCH and nothing else
 * apply  : read settings/store + revision → merge the patch over it →
 *          compare-and-set pinned to the revision just read
 * record : the claim's `result`, assigned EXACTLY ONCE, after that write committed
 * ```
 *
 * **A recorded result is always a value that really was applied.** It is written
 * after the settings write, guarded on the claim revision that had `result: null`,
 * so it is single-assignment: of any number of callers of one key, the first to
 * record decides the answer and every other one reads it. That is what makes two
 * callers of one key unable to disagree — the failure mode a claim carrying a
 * PRE-COMPUTED result has, because a merged value stored before the write can be
 * invalidated by a peer and then has to be re-decided against a newer base, leaving
 * whoever read it holding an answer no state ever had.
 *
 * **A replay reads the recorded result and writes nothing.** So a stale replay
 * arriving after a newer update returns what its mutation applied and cannot clobber
 * the newer value — the port's own promise.
 *
 * **A replay of an UN-LANDED claim completes it instead.** A crash between the claim
 * and the write leaves a decision with no outcome, and the only honest thing to
 * return is an outcome, so the replay merges the recorded patch over the CURRENT
 * settings and applies it. That is a late write, not a clobber-back: the mutation
 * had never landed, and the patch holds absolute values, so re-merging cannot revert
 * a field another mutation set in the meantime. The port's no-clobber clause is
 * about replaying a mutation whose result is recorded, and that path writes nothing
 * at all.
 *
 * **Losing the apply re-merges over the new base and tries again**, which is why
 * distinct-key updates never lose each other's fields: the loser recomputes from
 * what it can now see rather than re-committing a value it computed earlier.
 *
 * **Validation is not here.** The port's `update` is documented as a *validated*
 * partial update and the domain's `updateSettings` use-case (with
 * `InvalidSettingsError`) is what validates it; the SQL adapter validates nothing
 * either. A store that re-validated would be a second, drifting copy of a rule the
 * domain owns.
 */
import type { Clock, IdempotencyKey, OperationalSettings, SettingsStore } from "@otta-sh/domain";
import {
	CAS_RETRY,
	casDone,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import {
	mergeSettings,
	SETTINGS_COLLECTION,
	SETTINGS_DOC_ID,
	SETTINGS_MUTATIONS_COLLECTION,
	toOperationalSettings,
	toPatchDoc,
	type SettingsDoc,
	type SettingsMutationDoc,
} from "./settings-documents.js";
import type { StorageAccess, StorageCollection, Versioned } from "./storage-access.js";

export interface EmdashSettingsStoreOptions {
	/** The collections the descriptor declared (`SETTINGS_COLLECTIONS`). */
	storage: StorageAccess;
	/** Stamps `updatedAt` on the singleton, and the claim's `createdAt`/`appliedAt`. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
}

export class EmdashSettingsStore implements SettingsStore {
	readonly #settings: StorageCollection<SettingsDoc>;
	readonly #mutations: StorageCollection<SettingsMutationDoc>;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;

	constructor(options: EmdashSettingsStoreOptions) {
		this.#settings = collectionOf<SettingsDoc>(options.storage, SETTINGS_COLLECTION);
		this.#mutations = collectionOf<SettingsMutationDoc>(
			options.storage,
			SETTINGS_MUTATIONS_COLLECTION,
		);
		this.#clock = options.clock;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
	}

	/** One keyed read. An absent document is the domain defaults, never an error. */
	async get(): Promise<OperationalSettings> {
		return toOperationalSettings(await this.#settings.get(SETTINGS_DOC_ID));
	}

	/**
	 * Claim the key with the patch, apply the patch, then record what it applied.
	 *
	 * One bounded step covers all three, because every one of them can lose a race
	 * and the answer to each loss is to re-read and recompute. The step is written so
	 * that each attempt reaches one of three ends: the recorded result (nothing
	 * written), a value this call applied and recorded, or a value it applied that a
	 * peer recorded first.
	 */
	async update(
		patch: Partial<OperationalSettings>,
		idempotencyKey: IdempotencyKey,
	): Promise<OperationalSettings> {
		const intent = toPatchDoc(patch);
		return this.#cas<OperationalSettings>("updateSettings", async () => {
			const claim = await this.#holdClaim(idempotencyKey, intent);
			if (claim === undefined) return CAS_RETRY;
			// The landed half: a recorded result is an answer, and this call writes
			// nothing at all — which is what keeps a stale replay from clobbering a
			// newer update.
			if (claim.value.result !== null) return casDone(claim.value.result);

			// The un-landed half, whether this call just created the claim or is
			// completing somebody else's: merge over what is there NOW.
			const current = await this.#settings.getVersioned(SETTINGS_DOC_ID);
			const next = mergeSettings(toOperationalSettings(current?.value ?? null), claim.value.patch);
			const now = this.#clock.now().toISOString();
			const written = await this.#settings.compareAndSet(
				SETTINGS_DOC_ID,
				current?.revision ?? null,
				{
					...next,
					updatedAt: now,
				},
			);
			// A peer moved the settings between the read and here: recompute from the
			// new base rather than re-committing a value decided against the old one.
			if (!written.applied) return CAS_RETRY;

			// Single assignment, guarded on the revision that still had `result: null`.
			const recorded = await this.#mutations.compareAndSet(idempotencyKey, claim.revision, {
				...claim.value,
				result: next,
				appliedRevision: written.revision,
				appliedAt: now,
			});
			if (recorded.applied) return casDone(next);

			// A peer recorded first. Its value is the answer for every caller of this
			// key — and it landed too, so nothing here has to be undone.
			const peer = await this.#mutations.get(idempotencyKey);
			return peer?.result == null ? CAS_RETRY : casDone(peer.result);
		});
	}

	/**
	 * The claim for this key, creating it if it is not there yet.
	 *
	 * `undefined` means "a peer wrote it under me" — the caller retries and reads it.
	 * The patch is written once and never rewritten: a claim IS the mutation's intent,
	 * so a second call with the same key and a different patch gets the first patch,
	 * which is what "the key decides, not the payload" means.
	 */
	async #holdClaim(
		idempotencyKey: string,
		patch: SettingsMutationDoc["patch"],
	): Promise<Versioned<SettingsMutationDoc> | undefined> {
		const held = await this.#mutations.getVersioned(idempotencyKey);
		if (held !== null) return held;
		const value: SettingsMutationDoc = {
			patch,
			createdAt: this.#clock.now().toISOString(),
			result: null,
			appliedRevision: null,
			appliedAt: null,
		};
		const created = await this.#mutations.compareAndSet(idempotencyKey, null, value);
		return created.applied ? { value, revision: created.revision } : undefined;
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}
