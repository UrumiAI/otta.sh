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

/**
 * IO-free magic-link `CustomerCredentialVerifier` fake — the first adapter to
 * pass `credentialVerifierContract`. Models the real adapter: a one-time token
 * (stored as a hash by the DB adapter; here directly), single-use
 * (`consumedAt`), TTL expiry against the clock, and get-or-create of the
 * customer on the first successful verify.
 */
export class InMemoryCredentialVerifier implements CustomerCredentialVerifier {
	#customerStore: CustomerStore;
	#idGen: IdGen;
	#clock: Clock;
	#ttlMs: number;
	#challenges = new Map<string, StoredChallenge>();

	constructor(options: {
		customerStore: CustomerStore;
		idGen: IdGen;
		clock: Clock;
		ttlMs?: number;
	}) {
		this.#customerStore = options.customerStore;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
	}

	async issueChallenge(email: Email): Promise<IssueChallengeResult> {
		const id = this.#idGen.newId();
		const token = this.#idGen.newId();
		this.#challenges.set(id, {
			id,
			email,
			token,
			expiresAt: new Date(this.#clock.now().getTime() + this.#ttlMs).toISOString(),
			consumedAt: null,
		});
		return { challengeId: id, token };
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
