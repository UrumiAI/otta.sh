/**
 * `SettingsStore` over the settings singleton and a claim per mutation key.
 *
 * The SQL did the whole of `update` inside one transaction: read current, merge, claim
 * the key with the merged values, and — as the claim's winner only — upsert the settings
 * row. There is no transaction here, so the claim and the write are two documents, and
 * the design turns on two things: separating what was DECIDED from what LANDED, and
 * pinning the decision to the revision it was made against.
 *
 * ```
 * claim  : settings_mutations/{key} create-if-absent, carrying the PATCH and the
 *          settings revision the creator just read — both written once, never rewritten
 * apply  : merge the patch over the current settings, compare-and-set —
 *          the CREATOR at the revision it just read, anyone else at `decidedRevision`
 * record : the claim's `result`, assigned EXACTLY ONCE, after that write committed
 * ```
 *
 * **A recorded result is always a value that really was applied.** It is written after
 * the settings write, guarded on the claim revision that had `result: null`, so it is
 * single-assignment: of any number of callers of one key, the first to record decides the
 * answer and every other one reads it. That is what makes two callers of one key unable to
 * disagree — the failure mode a claim carrying a PRE-COMPUTED result has, because a merged
 * value stored before the write can be invalidated by a peer and then has to be re-decided
 * against a newer base, leaving whoever read it holding an answer no state ever had.
 *
 * **A replay of a landed mutation writes nothing**, so a stale replay arriving after a
 * newer update returns what its mutation applied and cannot clobber the newer value.
 *
 * **A replay of an UN-LANDED claim may complete it only at the revision it was decided
 * against.** That pin is the whole of the no-clobber guarantee for the crash case: a
 * mutation decided against a state that no longer exists would, if re-merged over the
 * current one, overwrite whatever replaced that state. So a non-creator that finds the
 * settings past `decidedRevision` refuses with a non-retryable
 * {@link SettingsMutationSupersededError} and writes no settings at all. Because the pin
 * is to ONE revision — and applying it moves that revision — **a non-creator completion
 * can succeed at most once, ever**, so the patch can never be applied twice.
 *
 * **The creator keeps re-merging over the new base**, because its intent is live: it is
 * the call the operator is waiting on, not a replay of a decision made earlier. A creator
 * that loses the write re-reads, re-merges and tries again, which is why distinct-key
 * updates never lose each other's fields.
 *
 * **A merge that changes nothing writes nothing.** If the patch's effect is already
 * present in the document that was read, the mutation is recorded against the value that
 * is there without a settings write. It cannot mask a clobber — a no-op write clobbers
 * nothing — and it does two useful things: it lets a mutation whose own write landed but
 * whose stamp was lost be completed rather than refused, and it keeps a same-key stampede
 * from refusing everybody but the creator, because every caller of one key merges the same
 * patch to the same value.
 *
 * **The accepted residual.** A creator may land its value while a concurrent replay of the
 * same key concludes "superseded": the value was applied and the replay was refused. That
 * is over-refusal, never a double apply and never a clobber, and it is the direction this
 * tier resolves every residual in.
 *
 * **Validation is not here.** The port's `update` is documented as a *validated* partial
 * update and the domain's `updateSettings` use-case (with `InvalidSettingsError`) is what
 * validates it; the SQL adapter validates nothing either. A store that re-validated would
 * be a second, drifting copy of a rule the domain owns.
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
import { SettingsMutationSupersededError } from "./settings-errors.js";
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

/** A claim, and whether THIS call is the one that created it. */
interface HeldClaim {
	readonly claim: Versioned<SettingsMutationDoc>;
	readonly created: boolean;
}

/** What this call has already committed to the settings document, if anything. */
interface Landed {
	readonly value: OperationalSettings;
	/** The revision the write produced — `null` when nothing was written. */
	readonly revision: string | null;
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

	/** Claim the key with the patch, apply the patch, then record what it applied. */
	async update(
		patch: Partial<OperationalSettings>,
		idempotencyKey: IdempotencyKey,
	): Promise<OperationalSettings> {
		const held = await this.#holdClaim(idempotencyKey, toPatchDoc(patch));
		if (held.claim.value.result !== null) return held.claim.value.result;
		return this.#settle(idempotencyKey, held.created);
	}

	/**
	 * The claim for this key, creating it if it is not there yet, and whether THIS call
	 * created it.
	 *
	 * Creating it reads the settings first, because the revision that read returns is the
	 * decision this claim is pinned to for everybody else. The patch and that revision are
	 * written together and never rewritten: a second call with the same key and a
	 * different patch gets the first patch, which is what "the key decides, not the
	 * payload" means.
	 */
	async #holdClaim(
		idempotencyKey: string,
		patch: SettingsMutationDoc["patch"],
	): Promise<HeldClaim> {
		return this.#cas<HeldClaim>("claimSettingsMutation", async () => {
			const held = await this.#mutations.getVersioned(idempotencyKey);
			if (held !== null) return casDone({ claim: held, created: false });
			const base = await this.#settings.getVersioned(SETTINGS_DOC_ID);
			const value: SettingsMutationDoc = {
				patch,
				// The read and this create are two statements, so the pin can be stale the
				// moment it is written — a peer may commit between them. That only ever
				// costs a later completion a refusal it might not have needed: the creator
				// re-reads and is unaffected, and no write is admitted at a revision that is
				// not current, which is the whole point.
				decidedRevision: base?.revision ?? null,
				createdAt: this.#clock.now().toISOString(),
				result: null,
				appliedRevision: null,
				appliedAt: null,
				supersededAt: null,
			};
			const created = await this.#mutations.compareAndSet(idempotencyKey, null, value);
			// A refused create means a peer with this key claimed first; the next attempt
			// reads its claim and this call becomes a completer rather than a creator.
			return created.applied
				? casDone({ claim: { value, revision: created.revision }, created: true })
				: CAS_RETRY;
		});
	}

	/**
	 * Apply the claim and record what it applied — or refuse, if this call may not.
	 *
	 * Every attempt re-reads the claim, because a peer may have landed it (its result is
	 * then the answer for everyone) or marked it superseded.
	 */
	async #settle(idempotencyKey: string, created: boolean): Promise<OperationalSettings> {
		// What this call has already committed, so a lost STAMP is retried without
		// re-deciding — and without being mistaken for a stale completion on the way back.
		let landed: Landed | undefined;

		return this.#cas<OperationalSettings>("updateSettings", async () => {
			const claim = await this.#mutations.getVersioned(idempotencyKey);
			// Nothing in this package deletes a claim, so an absent one is a read that
			// raced its own create; re-read.
			if (claim === null) return CAS_RETRY;
			if (claim.value.result !== null) return casDone(claim.value.result);

			const now = this.#clock.now().toISOString();
			if (landed !== undefined) return this.#stamp(idempotencyKey, claim, landed, now);

			// A terminal refusal by a peer. The creator ignores it: its intent is live, and
			// a peer's view of the revision says nothing about the call the operator is
			// waiting on. The current revision is read for the error rather than restated
			// from the claim — the two are what the message contrasts, and a marker written
			// by somebody else says only that they differed then, not what they are now.
			if (!created && claim.value.supersededAt !== null) {
				const seen = await this.#settings.getVersioned(SETTINGS_DOC_ID);
				throw new SettingsMutationSupersededError(
					idempotencyKey,
					claim.value.decidedRevision,
					seen?.revision ?? null,
				);
			}

			const base = await this.#settings.getVersioned(SETTINGS_DOC_ID);
			const baseRevision = base?.revision ?? null;
			const current = toOperationalSettings(base?.value ?? null);
			const next = mergeSettings(current, claim.value.patch);

			// The patch's effect is already present, so there is nothing to write — and a
			// write that changes nothing can clobber nothing, which is why this precedes
			// the pin. It is what completes a mutation whose own write landed and whose
			// stamp was lost.
			if (base !== null && sameSettings(current, next)) {
				return this.#stamp(idempotencyKey, claim, { value: next, revision: null }, now);
			}

			// The pin: a caller that did not decide this mutation may write only at the
			// revision it was decided against. Past that, the patch would overwrite
			// whatever replaced the state it was computed from.
			if (!created && baseRevision !== claim.value.decidedRevision) {
				await this.#markSuperseded(idempotencyKey, claim, now);
				throw new SettingsMutationSupersededError(
					idempotencyKey,
					claim.value.decidedRevision,
					baseRevision,
				);
			}

			const written = await this.#settings.compareAndSet(SETTINGS_DOC_ID, baseRevision, {
				...next,
				updatedAt: now,
			});
			// The creator recomputes from the new base. A non-creator's next attempt finds
			// the revision past its pin and refuses, which is the same rule one statement
			// later.
			if (!written.applied) return CAS_RETRY;
			landed = { value: next, revision: written.revision };
			return this.#stamp(idempotencyKey, claim, landed, now);
		});
	}

	/**
	 * Record the result, once, on the claim revision that still had `result: null`.
	 *
	 * A refusal means a peer moved the claim — landing it, or marking it superseded — so
	 * the next attempt re-reads: a landed result is the answer, and a superseded marker is
	 * written over, because a mutation that HAS landed is landed whatever a peer concluded
	 * while it was in flight.
	 */
	async #stamp(
		idempotencyKey: string,
		claim: Versioned<SettingsMutationDoc>,
		landed: Landed,
		now: string,
	): Promise<CasStep<OperationalSettings>> {
		const stamped = await this.#mutations.compareAndSet(idempotencyKey, claim.revision, {
			...claim.value,
			result: landed.value,
			appliedRevision: landed.revision,
			appliedAt: now,
			supersededAt: null,
		});
		return stamped.applied ? casDone(landed.value) : CAS_RETRY;
	}

	/**
	 * Mark a claim this call refused to complete. Best-effort and guarded on the revision
	 * that still had `result: null`, so it can never overwrite a landed result: a peer that
	 * landed the mutation between the read and here simply refuses this write, and the
	 * marker is not written at all.
	 */
	async #markSuperseded(
		idempotencyKey: string,
		claim: Versioned<SettingsMutationDoc>,
		now: string,
	): Promise<void> {
		await this.#mutations.compareAndSet(idempotencyKey, claim.revision, {
			...claim.value,
			supersededAt: now,
		});
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}

/** Two settings are the same when both fields are. */
function sameSettings(a: OperationalSettings, b: OperationalSettings): boolean {
	return a.holdTtlMinutes === b.holdTtlMinutes && a.lowStockThreshold === b.lowStockThreshold;
}
