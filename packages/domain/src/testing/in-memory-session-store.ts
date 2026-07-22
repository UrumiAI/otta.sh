import type { CustomerId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type { Session, SessionStore, SessionSummary } from "../ports/session-store.js";

interface StoredSession {
	id: string;
	token: string;
	customerId: CustomerId;
	createdAt: string;
	expiresAt: string;
	revokedAt: string | null;
}

/** Descending code-unit string comparison (`>` first) — mirrors the SQL
 *  `ORDER BY ... DESC` byte ordering (never `localeCompare`), matching the
 *  admin-list fake's convention. */
function codeUnitDesc(a: string, b: string): number {
	return a > b ? -1 : a < b ? 1 : 0;
}

/** Default session lifetime — long-lived so magic-link isn't needed every visit
 *  (§4 consequences). */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * IO-free `SessionStore` fake — the first adapter to pass `sessionContract`.
 * Models the real adapter: opaque tokens (the fake stores them directly; the DB
 * adapter stores only a hash), expiry checked against the injected clock, and
 * revoked/expired tokens rejected by `validate`.
 */
export class InMemorySessionStore implements SessionStore {
	#idGen: IdGen;
	#clock: Clock;
	#ttlMs: number;
	#byToken = new Map<string, StoredSession>();

	constructor(options: { idGen: IdGen; clock: Clock; ttlMs?: number }) {
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
	}

	async create(customerId: CustomerId): Promise<Session> {
		const token = this.#idGen.newId();
		const now = this.#clock.now();
		const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();
		this.#byToken.set(token, {
			id: this.#idGen.newId(),
			token,
			customerId,
			createdAt: now.toISOString(),
			expiresAt,
			revokedAt: null,
		});
		return { token, expiresAt };
	}

	async validate(token: string): Promise<CustomerId | null> {
		const s = this.#byToken.get(token);
		if (s === undefined || s.revokedAt !== null) return null;
		if (s.expiresAt <= this.#clock.now().toISOString()) return null; // expired
		return s.customerId;
	}

	async revoke(token: string): Promise<void> {
		const s = this.#byToken.get(token);
		if (s !== undefined && s.revokedAt === null) s.revokedAt = this.#clock.now().toISOString();
	}

	async listForCustomer(customerId: CustomerId): Promise<SessionSummary[]> {
		// Token-free history, newest-first (`createdAt DESC, id DESC`) — the
		// mapped summary NEVER carries the token (mirrors the SQL adapter never
		// selecting token_hash).
		return [...this.#byToken.values()]
			.filter((s) => s.customerId === customerId)
			.toSorted((a, b) =>
				a.createdAt === b.createdAt
					? codeUnitDesc(a.id, b.id)
					: codeUnitDesc(a.createdAt, b.createdAt),
			)
			.map((s) => ({
				id: s.id,
				createdAt: s.createdAt,
				expiresAt: s.expiresAt,
				revokedAt: s.revokedAt,
			}));
	}
}
