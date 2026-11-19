import type { AgentCheckoutSession, AgentSessionId } from "../agentic/model.js";

/**
 * The `AgentSessionStore` port (ADR-0047). Holds agent checkout sessions, one
 * document each (ADR-0019), written by compare-and-set on `revision`, plus the
 * create-time idempotency index (a session cannot hold the record of its own
 * create before it exists). Writes to an existing session keep their
 * idempotency records on the session itself, inside the same compare-and-set.
 *
 * Every method answers what it stores; none throws for an expected outcome.
 */
export interface AgentSessionStore {
	/** The session, or null. */
	get(id: AgentSessionId): Promise<AgentCheckoutSession | null>;
	/**
	 * Compare-and-set. `expectedRevision: null` inserts and wins only when no
	 * session has that id; a number wins only when the stored revision equals it.
	 * The winner's document is stored with `revision` = expected + 1 (1 on insert)
	 * and returned; a loser gets the current document (null if there is none).
	 * The `revision` field of the passed session is ignored.
	 */
	write(
		session: AgentCheckoutSession,
		expectedRevision: number | null,
	): Promise<
		| { ok: true; session: AgentCheckoutSession }
		| { ok: false; current: AgentCheckoutSession | null }
	>;
	/** The session whose LIVE hand-off token hashes to `tokenHash`, or null. */
	findByHandoffTokenHash(tokenHash: string): Promise<AgentCheckoutSession | null>;
	/** The most recently created session that last quoted on `cartId`, or null. */
	findByCartId(cartId: string): Promise<AgentCheckoutSession | null>;
	/** The create record for `key`, or null. */
	getIdempotency(key: string): Promise<AgentCreateIdempotencyRecord | null>;
	/**
	 * Insert-if-absent. Exactly one of any number of racing puts for one key is
	 * stored; every other answers the record that was.
	 */
	putIdempotency(
		record: AgentCreateIdempotencyRecord,
	): Promise<{ stored: true } | { stored: false; existing: AgentCreateIdempotencyRecord }>;
	/**
	 * Atomically mark the session's hand-off used, guarded on: the session is
	 * open (not canceled or completed), its live token hash is `tokenHash`, and it
	 * is not already used. Exactly one of any number of racing calls wins.
	 */
	markHandoffUsed(
		id: AgentSessionId,
		tokenHash: string,
		usedAt: string,
	): Promise<
		| { ok: true; session: AgentCheckoutSession }
		| { ok: false; reason: "not_found" | "token_mismatch" | "closed" | "already_used" }
	>;
	/** Sessions that are open and whose `expiresAt` is after `now`. */
	countLive(now: string): Promise<number>;
	/** Sessions created by `networkKey` at or after `since`. */
	countCreatedSince(networkKey: string, since: string): Promise<number>;
	/** Ids of sessions whose `purgeAt` is at or before `now`, at most `limit` of them. */
	listPurgeDue(now: string, limit: number): Promise<AgentSessionId[]>;
	/**
	 * Delete the session, and its create record, if its `purgeAt` is at or before
	 * `now`. Answers whether it deleted; idempotent.
	 */
	purge(id: AgentSessionId, now: string): Promise<boolean>;
}

/** Maps a create's `Idempotency-Key` to the session it created. */
export interface AgentCreateIdempotencyRecord {
	key: string;
	fingerprint: string;
	sessionId: AgentSessionId;
	createdAt: string;
}
