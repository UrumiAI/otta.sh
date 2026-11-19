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
	/**
	 * The session whose current `handoffTokenHash`, or one of whose
	 * `redeemedHandoffs`, equals `tokenHash`, or null. Found WHATEVER the
	 * session's status, expiry or use: redemption tells a used, canceled or
	 * expired link apart from an unknown one by what this returns.
	 */
	findByHandoffTokenHash(tokenHash: string): Promise<AgentCheckoutSession | null>;
	/** The most recently created session that last quoted on `cartId`, or null. */
	findByCartId(cartId: string): Promise<AgentCheckoutSession | null>;
	/** The create record for (`networkKey`, `key`), or null. Keys are caller-scoped. */
	getIdempotency(networkKey: string, key: string): Promise<AgentCreateIdempotencyRecord | null>;
	/**
	 * Insert-if-absent on (`networkKey`, `key`). Exactly one of any number of
	 * racing puts for one pair is stored; every other answers the record that was.
	 */
	putIdempotency(
		record: AgentCreateIdempotencyRecord,
	): Promise<{ stored: true } | { stored: false; existing: AgentCreateIdempotencyRecord }>;
	/**
	 * Atomically mark the session's current hand-off link used, guarded on: the
	 * session exists, its current token hash is `tokenHash`, it is open (not
	 * canceled or completed), the link is not already used, `expiresAt` is after
	 * `now`, and it has at least one line (`incomplete` otherwise: a replace that
	 * emptied the session after the caller's lookup must not burn the link). The
	 * mark stamps `handoffUsedAt = now` and bumps the revision. Exactly one of any
	 * number of racing calls wins.
	 */
	markHandoffUsed(
		id: AgentSessionId,
		tokenHash: string,
		now: string,
	): Promise<
		| { ok: true; session: AgentCheckoutSession }
		| {
				ok: false;
				reason:
					| "not_found"
					| "token_mismatch"
					| "canceled"
					| "completed"
					| "expired"
					| "already_used"
					| "incomplete";
		  }
	>;
	/**
	 * Move the create record for (`networkKey`, `key`) to purge no earlier than
	 * `purgeAt`: it sets the record's `purgeAt` to the later of the two, never
	 * earlier. A missing record is a no-op. Used when an orphaned create is
	 * finished late, so its record outlives the session it now points at.
	 */
	extendIdempotencyPurge(networkKey: string, key: string, purgeAt: string): Promise<void>;
	/** Sessions that are open and whose `expiresAt` is after `now`. */
	countLive(now: string): Promise<number>;
	/** Sessions created by `networkKey` at or after `since`. */
	countCreatedSince(networkKey: string, since: string): Promise<number>;
	/** Ids of sessions whose `purgeAt` is at or before `now`, at most `limit` of them. */
	listPurgeDue(now: string, limit: number): Promise<AgentSessionId[]>;
	/**
	 * Delete the session, and its create records, if its `purgeAt` is at or
	 * before `now`. Answers whether it deleted; idempotent.
	 */
	purge(id: AgentSessionId, now: string): Promise<boolean>;
	/**
	 * Delete up to `limit` create records whose `purgeAt` is at or before `now`,
	 * whether or not their session exists (a create that crashed before its
	 * session was written leaves an orphan record). Answers how many it deleted.
	 */
	purgeIdempotencyDue(now: string, limit: number): Promise<number>;
}

/** Maps a caller's create `Idempotency-Key` to the session it created. */
export interface AgentCreateIdempotencyRecord {
	/** The creating caller's network key; part of the record's identity. */
	networkKey: string;
	key: string;
	fingerprint: string;
	sessionId: AgentSessionId;
	createdAt: string;
	/** createdAt + 30 d, as the session's own `purgeAt`; never earlier than it
	 *  (a create finished late extends it, {@link AgentSessionStore.extendIdempotencyPurge}). */
	purgeAt: string;
}
