import { createHash } from "node:crypto";
import {
	customerId as toCustomerId,
	type Clock,
	type CustomerId,
	type IdGen,
	type Session,
	type SessionStore,
	type SessionSummary,
} from "@otta-sh/domain";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";

/** Default session lifetime — long-lived so magic-link isn't needed every visit. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface KyselySessionStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	clock: Clock;
	ttlMs?: number;
}

/**
 * `SessionStore` over Kysely (§4/§9 decision 5). Opaque DB-backed tokens (not
 * JWT) so revocation actually works. **Only the token hash is stored** — a DB
 * read can't leak a usable session. `validate` rejects unknown / expired /
 * revoked tokens; it is the sole authority on identity for every `/me/*` handler.
 */
export class KyselySessionStore implements SessionStore {
	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #ttlMs: number;

	constructor(options: KyselySessionStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
	}

	async create(customerId: CustomerId): Promise<Session> {
		const token = this.#idGen.newId();
		const now = this.#clock.now();
		const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();
		await this.#db
			.insertInto("customer_sessions")
			.values({
				id: this.#idGen.newId(),
				customer_id: customerId,
				token_hash: hashToken(token),
				created_at: now.toISOString(),
				expires_at: expiresAt,
				revoked_at: null,
			})
			.execute();
		return { token, expiresAt };
	}

	async validate(token: string): Promise<CustomerId | null> {
		const row = await this.#db
			.selectFrom("customer_sessions")
			.select("customer_id")
			.where("token_hash", "=", hashToken(token))
			.where("revoked_at", "is", null)
			.where("expires_at", ">", this.#clock.now().toISOString())
			.executeTakeFirst();
		return row === undefined ? null : toCustomerId(row.customer_id);
	}

	async revoke(token: string): Promise<void> {
		await this.#db
			.updateTable("customer_sessions")
			.set({ revoked_at: this.#clock.now().toISOString() })
			.where("token_hash", "=", hashToken(token))
			.where("revoked_at", "is", null)
			.execute();
	}

	async listForCustomer(customerId: CustomerId): Promise<SessionSummary[]> {
		// Token-free session history for the admin customer-context read (admin-UX
		// Increment 1). Deliberately NEVER selects `token_hash` — there is no path
		// for credential material onto the admin surface even by accident. Includes
		// expired + revoked rows (a history, not a liveness check — `validate`
		// stays the sole authority on liveness).
		const rows = await this.#db
			.selectFrom("customer_sessions")
			.select(["id", "created_at", "expires_at", "revoked_at"])
			.where("customer_id", "=", customerId)
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.execute();
		return rows.map((r) => ({
			id: r.id,
			createdAt: r.created_at,
			expiresAt: r.expires_at,
			revokedAt: r.revoked_at,
		}));
	}
}

/** SHA-256 hex of the opaque token — the only thing persisted (§4). */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
