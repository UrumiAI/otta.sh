import type { CustomerId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type { Session, SessionStore } from "../ports/session-store.js";

interface StoredSession {
	token: string;
	customerId: CustomerId;
	expiresAt: string;
	revokedAt: string | null;
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
		const expiresAt = new Date(this.#clock.now().getTime() + this.#ttlMs).toISOString();
		this.#byToken.set(token, { token, customerId, expiresAt, revokedAt: null });
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
}
