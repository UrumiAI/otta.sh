/**
 * `SettingsStore` over the settings singleton and a claim per mutation key.
 *
 * The SQL did the whole of `update` inside one transaction: read current, merge,
 * claim the key with the merged values, and — only as the claim's winner — upsert
 * the settings row. There is no transaction here, so the same four steps become a
 * claim document and a compare-and-set, in this order:
 *
 * ```
 * read    : settings/store, with its revision
 * merge   : the patch over what was read (absolute fields, so a no-op field is a keep)
 * claim   : settings_mutations/{key} create-if-absent, carrying the RESULT and that revision
 * apply   : settings/store compare-and-set, pinned to the revision the claim recorded
 * ```
 *
 * **Why the claim comes before the write it guards.** A claim with no settings
 * write is completable: it carries the result and the revision that result was
 * computed against, so any later caller with the same key finishes it with one
 * pinned compare-and-set — applying it if nothing has moved, and skipping it if a
 * newer update has. A settings write with no claim would be the opposite: the value
 * is applied and no ledger row says so, so the next replay of that key recomputes
 * from the new state and applies a SECOND time. So the claim is first, and the
 * residue of a crash is an update that has been decided but not yet landed, which
 * the next replay lands.
 *
 * **A replay never re-merges.** The port's promise is that a replay returns the
 * RECORDED result, and that is read straight out of the claim — so a stale replay
 * arriving after a newer update returns what it originally produced and leaves the
 * newer value alone. The completing compare-and-set is what makes that true even
 * when the original call died before applying.
 *
 * **Losing the apply to a concurrent DIFFERENT key re-computes, and rewrites this
 * call's own claim.** The SQL serialized those two callers with a row lock and let
 * the later one win with a value computed from the earlier one's state. Here the
 * loser's pinned compare-and-set fails, and it must not simply record a result it
 * never applied, so it re-reads, re-merges over the new base, and updates its own
 * claim — which it owns, by the revision its create returned — before applying
 * again. The recorded result and the applied value therefore always agree.
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
	toRecordedSettings,
	type SettingsDoc,
	type SettingsMutationDoc,
} from "./settings-documents.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

export interface EmdashSettingsStoreOptions {
	/** The collections the descriptor declared (`SETTINGS_COLLECTIONS`). */
	storage: StorageAccess;
	/** Stamps `updatedAt` on the singleton and `createdAt` on the claim. */
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

	/** Claim the key with the merged result, then apply it pinned to its base. */
	async update(
		patch: Partial<OperationalSettings>,
		idempotencyKey: IdempotencyKey,
	): Promise<OperationalSettings> {
		// The replay fast path, and the completion of a crashed predecessor with it:
		// the recorded result is returned either way, and the pinned write lands the
		// update only if nothing has moved since it was decided.
		const recorded = await this.#mutations.get(idempotencyKey);
		if (recorded !== null) {
			await this.#complete(recorded);
			return toRecordedSettings(recorded);
		}

		// The revision of the claim THIS call created, once it has. It is how the loop
		// tells its own claim from a peer's: only the creator ever rewrites one.
		let mine: string | null = null;

		return this.#cas<OperationalSettings>("updateSettings", async () => {
			const current = await this.#settings.getVersioned(SETTINGS_DOC_ID);
			const baseRevision = current?.revision ?? null;
			const next = mergeSettings(toOperationalSettings(current?.value ?? null), patch);
			const now = this.#clock.now().toISOString();

			const claimed = await this.#mutations.compareAndSet(idempotencyKey, mine, {
				...next,
				baseRevision,
				createdAt: now,
			});
			if (!claimed.applied) {
				const held = await this.#mutations.getVersioned(idempotencyKey);
				// Gone, or moved by nobody: recompute on the next attempt.
				if (held === null) return CAS_RETRY;
				if (mine !== null) {
					// This call's own claim, at a revision it no longer holds. Nothing else
					// writes a claim it did not create, so this is only reachable if the
					// revision moved under us; carry it forward and recompute.
					mine = held.revision;
					return CAS_RETRY;
				}
				// A same-key peer claimed first: its result is THE result, and this call
				// applies nothing. Completing it is how a crashed peer's decision lands.
				await this.#complete(held.value);
				return casDone(toRecordedSettings(held.value));
			}
			mine = claimed.revision;

			const written = await this.#settings.compareAndSet(SETTINGS_DOC_ID, baseRevision, {
				...next,
				updatedAt: now,
			});
			// A refusal means a peer moved the settings between the read and here, so the
			// merge has to be redone over the new base — and the claim rewritten with it,
			// which the next attempt does through `mine`.
			return written.applied ? casDone(next) : CAS_RETRY;
		});
	}

	/**
	 * Land a claim's recorded result, if the base it was computed against is still
	 * current.
	 *
	 * Idempotent and safe to call on every replay: the compare-and-set applies at
	 * most once, because applying it moves the revision it was pinned to. A refusal
	 * is the expected outcome for a mutation that already landed OR for one a newer
	 * update has overtaken — deliberately indistinguishable, because the action is the
	 * same in both cases: leave the current value alone.
	 */
	async #complete(claim: SettingsMutationDoc): Promise<void> {
		await this.#cas<void>("completeSettingsMutation", async () => {
			await this.#settings.compareAndSet(SETTINGS_DOC_ID, claim.baseRevision, {
				...toRecordedSettings(claim),
				updatedAt: claim.createdAt,
			});
			// Either outcome is DONE. The retry loop is here only so a host-level
			// retryable abort is retried rather than surfacing from a replay.
			return casDone(undefined);
		});
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}
