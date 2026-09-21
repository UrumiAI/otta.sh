/**
 * `CustomerCredentialVerifier` — the magic-link adapter — over two documents: the
 * challenge, and the per-address throttle claim that replaces a real race.
 *
 * Two of the three SQL guards port straight across. The third does not, and that
 * is the whole point of this file.
 *
 * - **Single use.** `SET consumed_at = :now WHERE id = :id AND consumed_at IS NULL`
 *   becomes a compare-and-set on the challenge document guarded on its revision,
 *   with `consumedAt` still absent on the document that revision was read from. A
 *   caller that loses that race re-reads and answers `CONSUMED`, which is exactly
 *   what the SQL's zero-rows-updated meant (ADR-0019 §7.17).
 * - **The prune.** `DELETE … WHERE consumed_at IS NOT NULL OR expires_at <= :now`
 *   becomes two bounded paged queries, because the filter algebra has no OR. The
 *   two arms overlap and the deletes deduplicate themselves: a document deleted by
 *   the first arm reports `false` to the second, so the returned count stays the
 *   number of documents actually removed.
 * - **The throttle was a genuine race, and it is retired by construction.** The SQL
 *   counted active challenges for an address and then inserted, in two statements,
 *   with no transaction and **no unique constraint on `login_challenges` at all** —
 *   so N concurrent requests could all read a count below the cap and all insert.
 *   ADR-0019 §7.17 names it and refuses to let it be inherited silently. Here the
 *   window is a **claim document**: `login_challenge_claims/{emailLower}` holds the
 *   set of slots currently taken, and a request is admitted only by a compare-and-set
 *   that adds its own slot to the value it counted. Of N concurrent requests exactly
 *   one wins each revision, so the cap is exact rather than approximate, and the
 *   losers recount against what the winner wrote.
 *
 * **Every residual resolves toward over-refusal** (ADR-0019's cross-cutting rule
 * (c)). A slot is taken BEFORE the challenge document is written and released AFTER
 * the consume commits, so a crash on either seam leaves a slot held for a challenge
 * that cannot be redeemed — a request refused that could have been admitted, never
 * an extra one admitted. Every such slot lapses on its own at the challenge's
 * expiry, which is what makes the residue self-healing: the window a slot can hold
 * is bounded by the challenge TTL, and no sweeper is required.
 *
 * **The window is the injected clock's**, never `Date.now()`: expiry is computed
 * from `clock.now()` and compared against it, so a test crosses the window by
 * advancing the clock and the throttle is deterministic rather than wall-timed.
 */
import {
	DuplicateCustomerEmailError,
	type Clock,
	type CustomerCredentialVerifier,
	type CustomerId,
	type CustomerStore,
	type Email,
	type IdGen,
	type IssueChallengeResult,
	type VerifyChallengeResult,
} from "@otta-sh/domain";
import {
	CAS_RETRY,
	casDone,
	isStorageContentionError,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import { ChallengeIdCollisionError } from "./identity-errors.js";
import { ScanPageLimitError } from "./errors.js";
import {
	consumedFor,
	foldEmail,
	liveSlots,
	LOGIN_CHALLENGE_CLAIMS_COLLECTION,
	LOGIN_CHALLENGES_COLLECTION,
	normalizeChallengeDoc,
	normalizeThrottleDoc,
	type ChallengeDoc,
	type ChallengeSlot,
	type ChallengeThrottleDoc,
} from "./identity-documents.js";
import { hashToken, tokenHashEquals } from "./token-hash.js";
import type { StorageAccess, StorageCollection, WhereClause } from "./storage-access.js";

/** Default magic-link lifetime, as the SQL adapter's default is. */
export const DEFAULT_CHALLENGE_TTL_MS = 15 * 60 * 1000;

/** Default per-address cap on live challenges, as the SQL adapter's default is. */
export const DEFAULT_MAX_ACTIVE_CHALLENGES = 3;

/** The host clamps `limit` at 100, so a page larger than that is not askable. */
const PRUNE_PAGE_SIZE = 100;

/**
 * Page ceiling for one arm of the prune. Reaching it is a typed
 * {@link ScanPageLimitError} rather than a silently partial prune — and the prune
 * is a scheduled sweep, so the honest answer to "more than this is due" is to say
 * so and be run again with a bigger budget.
 */
const MAX_PRUNE_PAGES = 1000;

export interface EmdashCredentialVerifierOptions {
	/** The collections the descriptor declared (`IDENTITY_COLLECTIONS`). */
	storage: StorageAccess;
	/** The store a successful verify get-or-creates the customer in. */
	customerStore: CustomerStore;
	/** Mints challenge ids and the emailed token. */
	idGen: IdGen;
	/** Defines the window: every expiry is computed from and compared to this. */
	clock: Clock;
	/** Challenge lifetime. Defaults to {@link DEFAULT_CHALLENGE_TTL_MS}. */
	ttlMs?: number;
	/** Per-address cap. Defaults to {@link DEFAULT_MAX_ACTIVE_CHALLENGES}. */
	maxActiveChallenges?: number;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/** Page ceiling per prune arm. Default 1000. */
	maxPrunePages?: number;
}

/** What one consume attempt decided. `admitted` carries what the release needs. */
type ConsumeOutcome =
	| { readonly kind: "invalid" }
	| { readonly kind: "consumed" }
	| { readonly kind: "expired" }
	| { readonly kind: "admitted"; readonly email: Email; readonly emailLower: string };

/** Structural test for the domain's duplicate-email failure — survives a bridge. */
function isDuplicateEmailError(err: unknown): boolean {
	return (
		err instanceof DuplicateCustomerEmailError ||
		(typeof err === "object" &&
			err !== null &&
			(err as { name?: unknown }).name === "DuplicateCustomerEmailError")
	);
}

export class EmdashCredentialVerifier implements CustomerCredentialVerifier {
	readonly #challenges: StorageCollection<ChallengeDoc>;
	readonly #throttle: StorageCollection<ChallengeThrottleDoc>;
	readonly #customerStore: CustomerStore;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #ttlMs: number;
	readonly #maxActive: number;
	readonly #retry: CasRetryOptions;
	readonly #maxPrunePages: number;

	constructor(options: EmdashCredentialVerifierOptions) {
		this.#challenges = collectionOf<ChallengeDoc>(options.storage, LOGIN_CHALLENGES_COLLECTION);
		this.#throttle = collectionOf<ChallengeThrottleDoc>(
			options.storage,
			LOGIN_CHALLENGE_CLAIMS_COLLECTION,
		);
		this.#customerStore = options.customerStore;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
		this.#maxActive = options.maxActiveChallenges ?? DEFAULT_MAX_ACTIVE_CHALLENGES;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
		this.#maxPrunePages = options.maxPrunePages ?? MAX_PRUNE_PAGES;
	}

	/**
	 * Take a throttle slot, then write the challenge the slot names.
	 *
	 * The ORDER is the guarantee. The slot is what the cap is counted from, so
	 * taking it first means a challenge can never exist outside the window that
	 * bounds it; the reverse order would admit one over the cap for as long as the
	 * write took. A crash in between leaves a slot naming a challenge that was never
	 * written — a refusal this call could have admitted, lapsing by itself at the
	 * expiry the slot carries.
	 *
	 * A refusal returns `THROTTLED` and writes nothing at all: the caller's HTTP
	 * response is identical either way (the port's own note — throttling must not
	 * become an enumeration oracle), and the expired slots this refusal counted past
	 * are dropped by the next admission rather than by a write on the refused path.
	 */
	async issueChallenge(email: Email): Promise<IssueChallengeResult> {
		const now = this.#clock.now();
		const nowIso = now.toISOString();
		const emailLower = foldEmail(email);
		const challengeId = this.#idGen.newId();
		const token = this.#idGen.newId();
		const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();

		const admitted = await this.#admit(emailLower, { challengeId, expiresAt }, nowIso);
		if (!admitted) return { ok: false, reason: "THROTTLED" };

		try {
			const doc: ChallengeDoc = {
				challengeId,
				email,
				emailLower,
				tokenHash: await hashToken(token),
				createdAt: nowIso,
				expiresAt,
				consumedAt: null,
				consumed: consumedFor(null),
			};
			// Create-if-absent: a document already under this id is an id-source
			// collision, not a race to retry. It is loud, and the slot goes back —
			// overwriting the existing challenge would invalidate a link somebody holds.
			const written = await this.#challenges.compareAndSet(challengeId, null, doc);
			if (!written.applied) throw new ChallengeIdCollisionError(challengeId);
		} catch (err) {
			// The challenge was not written, so the slot it named must not stay held.
			await this.#releaseSlot(emailLower, challengeId);
			throw err;
		}
		return { ok: true, challengeId, token };
	}

	/**
	 * Redeem a challenge once, then free its slot, then resolve the customer.
	 *
	 * The slot is released only AFTER the consume has committed — the same
	 * un-embed-then-release ordering every claim in this package uses. Releasing
	 * first would open a window in which the cap was one wider than the set of
	 * redeemable challenges.
	 */
	async verifyChallenge(challengeId: string, token: string): Promise<VerifyChallengeResult> {
		const nowIso = this.#clock.now().toISOString();
		const providedHash = await hashToken(token);
		const outcome = await this.#cas<ConsumeOutcome>("verifyChallenge", async () => {
			const current = await this.#challenges.getVersioned(challengeId);
			if (current === null) return casDone<ConsumeOutcome>({ kind: "invalid" });
			const doc = normalizeChallengeDoc(current.value);
			// Constant-time, because this comparison is the whole of the secret: a
			// challenge id is in a URL, and only the token proves the inbox.
			if (!tokenHashEquals(providedHash, doc.tokenHash)) {
				return casDone<ConsumeOutcome>({ kind: "invalid" });
			}
			if (doc.consumedAt !== null) return casDone<ConsumeOutcome>({ kind: "consumed" });
			if (doc.expiresAt <= nowIso) return casDone<ConsumeOutcome>({ kind: "expired" });
			const written = await this.#challenges.compareAndSet(challengeId, current.revision, {
				...doc,
				consumedAt: nowIso,
				consumed: consumedFor(nowIso),
			});
			// A lost race here is a peer that consumed it: the next attempt reads the
			// consumed document and answers `CONSUMED`, which is what the SQL's
			// zero-rows-updated meant.
			return written.applied
				? casDone<ConsumeOutcome>({
						kind: "admitted",
						email: doc.email,
						emailLower: doc.emailLower,
					})
				: CAS_RETRY;
		});

		if (outcome.kind === "invalid") return { ok: false, reason: "INVALID" };
		if (outcome.kind === "consumed") return { ok: false, reason: "CONSUMED" };
		if (outcome.kind === "expired") return { ok: false, reason: "EXPIRED" };
		await this.#releaseSlot(outcome.emailLower, challengeId);
		return { ok: true, customerId: await this.#resolveCustomer(outcome.email) };
	}

	/**
	 * Delete consumed and expired challenges — the OR the filter algebra cannot
	 * express, as two bounded arms whose overlap the deletes deduplicate.
	 *
	 * Each arm re-queries from the start after deleting a page rather than paging
	 * with a cursor over a collection it is emptying, which is what keeps a
	 * concurrently shifting page from stepping over a due document.
	 *
	 * The throttle slots those challenges held are NOT touched here. A slot carries
	 * its own expiry and lapses on the next admission, so a prune that also swept
	 * slots would buy nothing except a second write and a race with a live
	 * admission.
	 */
	async pruneChallenges(now: string): Promise<number> {
		let removed = 0;
		removed += await this.#pruneArm("pruneConsumedChallenges", { consumed: "yes" });
		removed += await this.#pruneArm("pruneExpiredChallenges", { expiresAt: { lte: now } });
		return removed;
	}

	async #pruneArm(operation: string, where: WhereClause): Promise<number> {
		let removed = 0;
		for (let page = 0; page < this.#maxPrunePages; page++) {
			const result = await this.#challenges.query({ where, limit: PRUNE_PAGE_SIZE });
			if (result.items.length === 0) return removed;
			for (const { id } of result.items) {
				if (await this.#challenges.delete(id)) removed++;
			}
		}
		throw new ScanPageLimitError(operation, this.#maxPrunePages, removed, "maxPrunePages");
	}

	/**
	 * Add a slot to the window, or refuse — the compare-and-set that makes the cap
	 * exact.
	 *
	 * The count is taken from the SAME document value the write is guarded on, so a
	 * peer that took the last slot invalidates this decision instead of racing it.
	 * Expired slots are dropped in the value that is written, which is the only
	 * place the window is ever pruned.
	 */
	async #admit(emailLower: string, slot: ChallengeSlot, nowIso: string): Promise<boolean> {
		return this.#cas<boolean>("issueChallenge.admit", async () => {
			const current = await this.#throttle.getVersioned(emailLower);
			const empty: ChallengeThrottleDoc = { emailLower, slots: [] };
			const doc = current === null ? empty : normalizeThrottleDoc(current.value);
			const live = liveSlots(doc, nowIso);
			if (live.length >= this.#maxActive) return casDone(false);
			const written = await this.#throttle.compareAndSet(emailLower, current?.revision ?? null, {
				emailLower,
				slots: [...live, slot],
			});
			return written.applied ? casDone(true) : CAS_RETRY;
		});
	}

	/**
	 * Give a slot back. Idempotent: a slot that is already gone is not an error, and
	 * a slot belonging to another challenge is never removed.
	 *
	 * **This is the one place a `StorageContentionError` is deliberately not
	 * propagated, and the reason is the direction of the residual.** A release runs
	 * only AFTER the write it compensates for has already been decided — the
	 * challenge was consumed, or it was never written. Raising here would turn a
	 * login that has already succeeded into an error the user cannot retry (the
	 * challenge is spent, so the replay answers `CONSUMED`), in exchange for freeing
	 * a slot a moment earlier. Not raising leaves the slot held until its own expiry,
	 * which refuses a request that could have been admitted and expires by itself —
	 * over-refusal, bounded by the challenge TTL, which is the direction ADR-0019's
	 * rule (c) requires. Every other contention failure in this package propagates.
	 */
	async #releaseSlot(emailLower: string, challengeId: string): Promise<void> {
		try {
			await this.#cas<void>("releaseChallengeSlot", async () => {
				const current = await this.#throttle.getVersioned(emailLower);
				if (current === null) return casDone(undefined);
				const doc = normalizeThrottleDoc(current.value);
				if (!doc.slots.some((slot) => slot.challengeId === challengeId)) {
					return casDone(undefined);
				}
				const remaining = doc.slots.filter((slot) => slot.challengeId !== challengeId);
				// The document exists only while a slot is held, so an empty window leaves
				// no litter behind.
				const written =
					remaining.length === 0
						? await this.#throttle.compareAndDelete(emailLower, current.revision)
						: await this.#throttle.compareAndSet(emailLower, current.revision, {
								emailLower,
								slots: remaining,
							});
				return written.applied ? casDone(undefined) : CAS_RETRY;
			});
		} catch (err) {
			if (!isStorageContentionError(err)) throw err;
		}
	}

	/**
	 * Get-or-create the account behind a redeemed address, resolving the create's own
	 * duplicate race by re-reading.
	 *
	 * The re-read is inside the bounded retry rather than after it, and that is not
	 * cosmetic. The duplicate a concurrent registration raises can arrive BEFORE the
	 * winner's account document is readable: the email claim refuses a second
	 * registration from the moment it is taken, which is a moment before the account
	 * behind it exists (the claim's abandon window, `emdash-customer-store.ts`). A
	 * single re-read would then find nothing and surface a duplicate error for an
	 * address this caller is legitimately logging into. So the step is re-run with the
	 * package's own jittered backoff until the winner's account is readable, and only
	 * an exhausted budget is reported — as the typed, retryable contention failure,
	 * never as a duplicate.
	 */
	async #resolveCustomer(email: Email): Promise<CustomerId> {
		return this.#cas<CustomerId>("verifyChallenge.resolveCustomer", async () => {
			const existing = await this.#customerStore.getByEmail(email);
			if (existing !== null) return casDone(existing.id);
			try {
				return casDone((await this.#customerStore.create({ email })).id);
			} catch (err) {
				if (!isDuplicateEmailError(err)) throw err;
				const raced = await this.#customerStore.getByEmail(email);
				return raced === null ? CAS_RETRY : casDone(raced.id);
			}
		});
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}
