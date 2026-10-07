/**
 * `AttemptThrottle` over plugin storage — the SIGN-IN THROTTLE's own mechanism,
 * reused (QA U-2): the same `login_challenge_claims` collection, the same
 * `ChallengeThrottleDoc` shape, the same `liveSlots` window and the same
 * compare-and-set admit as `EmdashCredentialVerifier#admit`. A slot here names an
 * attempt rather than a challenge, and lapses `windowMs` after it was taken.
 *
 * NAMESPACED: every document id is `attempt:<keyPrefix><key>`. An email address
 * cannot begin `attempt:` (a colon is not valid unquoted in an address), so an
 * attempt window never shares a document with an address's sign-in window.
 *
 * No new collection, so no descriptor change; the documents are bounded by the
 * cap they enforce and never deleted: like the sign-in window, a document
 * whose slots have all lapsed is simply rewritten on the next admit. That is at
 * most one small document per throttled key.
 */
import type { AttemptThrottle, Clock, IdGen } from "@otta-sh/domain";
import { CAS_RETRY, casDone, withCasRetry, type CasRetryOptions } from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import {
	LOGIN_CHALLENGE_CLAIMS_COLLECTION,
	liveSlots,
	normalizeThrottleDoc,
	type ChallengeThrottleDoc,
} from "./identity-documents.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

export interface EmdashAttemptThrottleOptions {
	/** Must declare `login_challenge_claims` (`IDENTITY_COLLECTIONS` does). */
	storage: StorageAccess;
	clock: Clock;
	/** Names each slot. */
	idGen: IdGen;
	windowMs: number;
	maxAttempts: number;
	/** Prepended to every key (after `attempt:`). */
	keyPrefix?: string;
	maxCasAttempts?: number;
}

const NAMESPACE = "attempt:";

export class EmdashAttemptThrottle implements AttemptThrottle {
	readonly #docs: StorageCollection<ChallengeThrottleDoc>;
	readonly #clock: Clock;
	readonly #idGen: IdGen;
	readonly #windowMs: number;
	readonly #maxAttempts: number;
	readonly #prefix: string;
	readonly #retry: CasRetryOptions;

	constructor(options: EmdashAttemptThrottleOptions) {
		this.#docs = collectionOf<ChallengeThrottleDoc>(
			options.storage,
			LOGIN_CHALLENGE_CLAIMS_COLLECTION,
		);
		this.#clock = options.clock;
		this.#idGen = options.idGen;
		this.#windowMs = options.windowMs;
		this.#maxAttempts = options.maxAttempts;
		this.#prefix = `${NAMESPACE}${options.keyPrefix ?? ""}`;
		this.#retry = { maxAttempts: options.maxCasAttempts };
	}

	admit(key: string): Promise<boolean> {
		const id = `${this.#prefix}${key}`;
		const now = this.#clock.now();
		const nowIso = now.toISOString();
		const slot = {
			challengeId: this.#idGen.newId(),
			expiresAt: new Date(now.getTime() + this.#windowMs).toISOString(),
		};
		return withCasRetry<boolean>(
			"attemptThrottle.admit",
			async () => {
				const current = await this.#docs.getVersioned(id);
				const doc =
					current === null ? { emailLower: id, slots: [] } : normalizeThrottleDoc(current.value);
				const live = liveSlots(doc, nowIso);
				if (live.length >= this.#maxAttempts) return casDone(false);
				const written = await this.#docs.compareAndSet(id, current?.revision ?? null, {
					emailLower: id,
					slots: [...live, slot],
				});
				return written.applied ? casDone(true) : CAS_RETRY;
			},
			this.#retry,
		);
	}
}
