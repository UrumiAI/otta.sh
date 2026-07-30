import { createHash, timingSafeEqual } from "node:crypto";
import {
	DuplicateCustomerEmailError,
	email as toEmail,
	type Clock,
	type CustomerCredentialVerifier,
	type CustomerId,
	type CustomerStore,
	type Email,
	type IdGen,
	type IssueChallengeResult,
	type VerifyChallengeResult,
} from "@otta-sh/domain";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";

/** Default magic-link challenge lifetime. */
export const DEFAULT_CHALLENGE_TTL_MS = 15 * 60 * 1000;

/** Default per-email active-challenge cap (review round H1, §9 Risk 4). */
export const DEFAULT_MAX_ACTIVE_CHALLENGES = 3;

export interface KyselyCredentialVerifierOptions {
	db: Kysely<Database>;
	/** Used to get-or-create the customer on the first successful verify. */
	customerStore: CustomerStore;
	idGen: IdGen;
	clock: Clock;
	ttlMs?: number;
	/** Per-email active-challenge cap (H1). */
	maxActiveChallenges?: number;
}

/**
 * Magic-link `CustomerCredentialVerifier` over Kysely (§4). **Mechanism-specific**
 * — the only surface that changes if the auth mechanism does (§4 two-port split).
 * The one-time token is stored as a hash (single-use via `consumed_at`, guarded
 * so a URL replay is `CONSUMED`), TTL-expired tokens are `EXPIRED`, and the
 * customer is get-or-created on the first successful verify.
 *
 * Rate limiting (review round H1, §9 Risk 4): `issueChallenge` is a DB-backed
 * per-email window — when N unconsumed, unexpired challenges already exist for
 * the address it no-ops (`THROTTLED`), bounding both the email-bombing rate and
 * `login_challenges` growth per address. Per-IP limiting is gateway-layer scope
 * (ADR-0004), not this adapter's. `pruneChallenges` deletes consumed/expired
 * rows so the table cannot grow unboundedly (driven by the same internal
 * maintenance tick as the outbox dispatcher).
 */
export class KyselyCredentialVerifier implements CustomerCredentialVerifier {
	readonly #db: Kysely<Database>;
	readonly #customerStore: CustomerStore;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #ttlMs: number;
	readonly #maxActive: number;

	constructor(options: KyselyCredentialVerifierOptions) {
		this.#db = options.db;
		this.#customerStore = options.customerStore;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
		this.#maxActive = options.maxActiveChallenges ?? DEFAULT_MAX_ACTIVE_CHALLENGES;
	}

	async issueChallenge(email: Email): Promise<IssueChallengeResult> {
		const now = this.#clock.now();
		const nowIso = now.toISOString();

		// Per-email window (H1): count active (unconsumed, unexpired) challenges.
		const active = await this.#db
			.selectFrom("login_challenges")
			.select(({ fn }) => fn.countAll().as("n"))
			.where("email", "=", email)
			.where("consumed_at", "is", null)
			.where("expires_at", ">", nowIso)
			.executeTakeFirstOrThrow();
		if (Number(active.n) >= this.#maxActive) return { ok: false, reason: "THROTTLED" };

		const challengeId = this.#idGen.newId();
		const token = this.#idGen.newId();
		await this.#db
			.insertInto("login_challenges")
			.values({
				id: challengeId,
				email,
				token_hash: hashToken(token),
				created_at: nowIso,
				expires_at: new Date(now.getTime() + this.#ttlMs).toISOString(),
				consumed_at: null,
			})
			.execute();
		return { ok: true, challengeId, token };
	}

	async pruneChallenges(now: string): Promise<number> {
		const res = await this.#db
			.deleteFrom("login_challenges")
			.where((eb) => eb.or([eb("consumed_at", "is not", null), eb("expires_at", "<=", now)]))
			.executeTakeFirst();
		return Number(res.numDeletedRows);
	}

	async verifyChallenge(challengeId: string, token: string): Promise<VerifyChallengeResult> {
		const row = await this.#db
			.selectFrom("login_challenges")
			.selectAll()
			.where("id", "=", challengeId)
			.executeTakeFirst();
		if (row === undefined || !tokenMatches(token, row.token_hash)) {
			return { ok: false, reason: "INVALID" };
		}
		if (row.consumed_at !== null) return { ok: false, reason: "CONSUMED" };
		if (row.expires_at <= this.#clock.now().toISOString()) return { ok: false, reason: "EXPIRED" };

		// Guarded single-use consume — a concurrent verify that already consumed it
		// leaves 0 rows here ⇒ CONSUMED, never a double login.
		const consumed = await this.#db
			.updateTable("login_challenges")
			.set({ consumed_at: this.#clock.now().toISOString() })
			.where("id", "=", challengeId)
			.where("consumed_at", "is", null)
			.returning("id")
			.executeTakeFirst();
		if (consumed === undefined) return { ok: false, reason: "CONSUMED" };

		const customerId = await this.#resolveCustomer(toEmail(row.email));
		return { ok: true, customerId };
	}

	async #resolveCustomer(email: Email): Promise<CustomerId> {
		const existing = await this.#customerStore.getByEmail(email);
		if (existing !== null) return existing.id;
		try {
			const created = await this.#customerStore.create({ email });
			return created.id;
		} catch (err) {
			if (err instanceof DuplicateCustomerEmailError) {
				const raced = await this.#customerStore.getByEmail(email);
				if (raced !== null) return raced.id;
			}
			throw err;
		}
	}
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare of the token against the stored hash. */
function tokenMatches(token: string, storedHash: string): boolean {
	const provided = Buffer.from(hashToken(token), "hex");
	const expected = Buffer.from(storedHash, "hex");
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}
