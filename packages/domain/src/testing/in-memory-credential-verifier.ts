import type { CustomerId, Email } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	CustomerCredentialVerifier,
	IssueChallengeResult,
	VerifyChallengeResult,
} from "../ports/credential-verifier.js";
import type { CustomerStore } from "../ports/customer-store.js";
import { DuplicateCustomerEmailError } from "../customers/errors.js";

interface StoredChallenge {
	id: string;
	email: Email;
	token: string;
	expiresAt: string;
	consumedAt: string | null;
}

/** Default magic-link challenge lifetime. */
export const DEFAULT_CHALLENGE_TTL_MS = 15 * 60 * 1000;

/** Default per-email active-challenge cap (review round H1, §9 Risk 4). */
export const DEFAULT_MAX_ACTIVE_CHALLENGES = 3;

/**
 * IO-free magic-link `CustomerCredentialVerifier` fake — the first adapter to
 * pass `credentialVerifierContract`. Models the real adapter: a one-time token
 * (stored as a hash by the DB adapter; here directly), single-use
 * (`consumedAt`), TTL expiry against the clock, get-or-create of the customer
 * on the first successful verify, the per-email rate-limit window, and the
 * consumed/expired prune (review round H1).
 */
export class InMemoryCredentialVerifier implements CustomerCredentialVerifier {
	#customerStore: CustomerStore;
	#idGen: IdGen;
	#clock: Clock;
	#ttlMs: number;
	#maxActive: number;
	#challenges = new Map<string, StoredChallenge>();

	constructor(options: {
		customerStore: CustomerStore;
		idGen: IdGen;
		clock: Clock;
		ttlMs?: number;
		maxActiveChallenges?: number;
	}) {
		this.#customerStore = options.customerStore;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
		this.#maxActive = options.maxActiveChallenges ?? DEFAULT_MAX_ACTIVE_CHALLENGES;
	}

	async issueChallenge(email: Email): Promise<IssueChallengeResult> {
		// Per-email window (H1): at most N unconsumed, unexpired challenges may
		// exist for one address — the Nth+1 rapid request issues nothing.
		const now = this.#clock.now().toISOString();
		let active = 0;
		for (const c of this.#challenges.values()) {
			if (c.email === email && c.consumedAt === null && c.expiresAt > now) active++;
		}
		if (active >= this.#maxActive) return { ok: false, reason: "THROTTLED" };

		const id = this.#idGen.newId();
		const token = this.#idGen.newId();
		this.#challenges.set(id, {
			id,
			email,
			token,
			expiresAt: new Date(this.#clock.now().getTime() + this.#ttlMs).toISOString(),
			consumedAt: null,
		});
		return { ok: true, challengeId: id, token };
	}

	async pruneChallenges(now: string): Promise<number> {
		let pruned = 0;
		for (const [id, c] of this.#challenges) {
			if (c.consumedAt !== null || c.expiresAt <= now) {
				this.#challenges.delete(id);
				pruned++;
			}
		}
		return pruned;
	}

	async verifyChallenge(challengeId: string, token: string): Promise<VerifyChallengeResult> {
		const challenge = this.#challenges.get(challengeId);
		if (challenge === undefined || challenge.token !== token) {
			return { ok: false, reason: "INVALID" };
		}
		if (challenge.consumedAt !== null) return { ok: false, reason: "CONSUMED" };
		if (challenge.expiresAt <= this.#clock.now().toISOString()) {
			return { ok: false, reason: "EXPIRED" };
		}
		challenge.consumedAt = this.#clock.now().toISOString();
		const customerId = await this.#resolveCustomer(challenge.email);
		return { ok: true, customerId };
	}

	async #resolveCustomer(email: Email): Promise<CustomerId> {
		const existing = await this.#customerStore.getByEmail(email);
		if (existing !== null) return existing.id;
		try {
			const created = await this.#customerStore.create({ email });
			return created.id;
		} catch (err) {
			// A concurrent verify created it first — re-read.
			if (err instanceof DuplicateCustomerEmailError) {
				const raced = await this.#customerStore.getByEmail(email);
				if (raced !== null) return raced.id;
			}
			throw err;
		}
	}
}
