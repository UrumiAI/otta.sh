import type { AgentCheckoutSession, AgentSessionId } from "../agentic/model.js";

/**
 * The `AgentSessionStore` port (ADR-0047). Holds agent checkout sessions, one
 * document each (ADR-0019), written by compare-and-set on `revision`, plus the
 * create-time idempotency index (a session cannot hold the record of its own
 * create before it exists). Writes to an existing session keep their
 * idempotency records on the session itself, inside the same compare-and-set.
 *
 * Storage is bounded BY THE STORE, not only by the use-cases' checks:
 *  - {@link insert} admits a session only while the live and stored counts are
 *    under the caller's caps, atomically with the insert, so racing creates can
 *    never overshoot either cap;
 *  - {@link insert} and {@link write} refuse a document heavier than
 *    `AGENT_SESSION_MAX_DOCUMENT_BYTES` as measured by
 *    `agentSessionDocumentBytes` (`too_large`).
 *
 * "Live" everywhere means: status open (`incomplete` or `requires_escalation`)
 * and `expiresAt` strictly after `now`. "Stored" means every session not yet
 * purged, whatever its status or age.
 *
 * Every method answers what it stores; none throws for an expected outcome.
 */
export interface AgentSessionStore {
	/** The session, or null. */
	get(id: AgentSessionId): Promise<AgentCheckoutSession | null>;
	/**
	 * Insert-if-absent, under the capacity caps. Checked in this order, all in one
	 * atomic step: a session with that id exists → `exists` with it (a racing
	 * create's replay wins over every cap); the document is over the byte cap →
	 * `too_large`; live sessions at `capacity.now` ≥ `maxLive`, or stored sessions
	 * ≥ `maxStored` → `capacity`. The winner is stored at `revision` 1 and
	 * returned. Of any number of racing inserts, the store never ends up holding
	 * more than the caps admit. The passed `revision` is ignored.
	 */
	insert(
		session: AgentCheckoutSession,
		capacity: AgentSessionCapacity,
	): Promise<
		| { ok: true; session: AgentCheckoutSession }
		| { ok: false; reason: "exists"; current: AgentCheckoutSession }
		| { ok: false; reason: "too_large" }
		| { ok: false; reason: "capacity" }
	>;
	/**
	 * Compare-and-set on an existing session: wins only when the stored revision
	 * equals `expectedRevision` and the document is within the byte cap. The
	 * winner is stored with `revision` = expected + 1 and returned; a stale or
	 * missing session answers `conflict` with the current document (null if
	 * none); an over-weight one `too_large`, storing nothing. The passed
	 * `revision` is ignored.
	 */
	write(
		session: AgentCheckoutSession,
		expectedRevision: number,
	): Promise<
		| { ok: true; session: AgentCheckoutSession }
		| { ok: false; reason: "conflict"; current: AgentCheckoutSession | null }
		| { ok: false; reason: "too_large" }
	>;
	/**
	 * The session whose current `handoffTokenHash`, or one of whose
	 * `redeemedHandoffs`, equals `tokenHash`, or null. Found WHATEVER the
	 * session's status, expiry, claim or use: redemption tells a used, canceled
	 * or expired link apart from an unknown one by what this returns.
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
	 * Delete the create record for (`networkKey`, `key`) if, atomically, it still
	 * points at `sessionId` AND no session `sessionId` is stored: a create the
	 * insert refused leaves no record behind, so its key is free again. Answers
	 * whether it deleted.
	 */
	releaseIdempotency(networkKey: string, key: string, sessionId: AgentSessionId): Promise<boolean>;
	/**
	 * Claim the session's current hand-off link for a redeem, as a lease. One
	 * atomic step guarded on, in this order: the session exists (`not_found`),
	 * `tokenHash` is its current link (`token_mismatch`), it is not canceled
	 * (`canceled`) or completed (`completed`), the link was not finalized
	 * (`already_used`), `expiresAt` is after `now` (`expired`), it has a line
	 * (`incomplete`), and no OTHER claim's lease is still running
	 * (`claimed`, with that claim's `leaseUntil`). A lapsed claim is replaced. The
	 * winner sets `handoffClaim` = {tokenHash, claimId, claimedAt: now,
	 * leaseUntil}, bumps the revision and answers the session. Exactly one of any
	 * number of racing claims wins.
	 */
	claimHandoff(
		id: AgentSessionId,
		claim: { tokenHash: string; claimId: string; now: string; leaseUntil: string },
	): Promise<
		| { ok: true; session: AgentCheckoutSession }
		| { ok: false; reason: "claimed"; leaseUntil: string }
		| {
				ok: false;
				reason:
					| "not_found"
					| "token_mismatch"
					| "canceled"
					| "completed"
					| "already_used"
					| "expired"
					| "incomplete";
		  }
	>;
	/**
	 * Finalize a claimed hand-off: in one atomic step, guarded on the session
	 * existing (`not_found`), its `handoffClaim.claimId` being `claimId`
	 * (`claim_lost`; a lapsed claim nobody replaced still finalizes), and it not
	 * being canceled (`canceled`) or completed (`completed`), stamp
	 * `handoffUsedAt = now` and `cartId`, keep the claim, bump the revision. The
	 * same claim finalizing again with the same cart answers `replayed: true` and
	 * writes nothing; with another cart, `already_used`. Exactly one of any number
	 * of racing finalizes of one claim writes.
	 */
	finalizeHandoff(
		id: AgentSessionId,
		finalize: { claimId: string; cartId: string; now: string },
	): Promise<
		| { ok: true; replayed: boolean; session: AgentCheckoutSession }
		| {
				ok: false;
				reason: "not_found" | "claim_lost" | "canceled" | "completed" | "already_used";
		  }
	>;
	/**
	 * Drop an unfinalized claim early (the redeem failed, e.g. no line could be
	 * added), so the link may be claimed again at once instead of after the lease.
	 * Only the claim `claimId` names, and only before it finalized; bumps the
	 * revision. Answers whether it released.
	 */
	releaseHandoffClaim(id: AgentSessionId, claimId: string): Promise<boolean>;
	/**
	 * Move the create record for (`networkKey`, `key`) to purge no earlier than
	 * `purgeAt`: it sets the record's `purgeAt` to the later of the two, never
	 * earlier. A missing record is a no-op. Used when an orphaned create is
	 * finished late, so its record outlives the session it now points at.
	 */
	extendIdempotencyPurge(networkKey: string, key: string, purgeAt: string): Promise<void>;
	/** Live sessions at `now` (open, and `expiresAt` strictly after `now`). */
	countLive(now: string): Promise<number>;
	/** Sessions created by `networkKey` at or after `since`, whatever their status. */
	countCreatedSince(networkKey: string, since: string): Promise<number>;
	/** Ids of sessions whose `purgeAt` is at or before `now`, at most `limit` of them. */
	listPurgeDue(now: string, limit: number): Promise<AgentSessionId[]>;
	/**
	 * Delete the session, its create records and its hand-off lookups, if its
	 * `purgeAt` is at or before `now`. Answers whether it deleted; idempotent.
	 */
	purge(id: AgentSessionId, now: string): Promise<boolean>;
	/**
	 * Delete up to `limit` create records whose `purgeAt` is at or before `now`,
	 * whether or not their session exists (a create that crashed before its
	 * session was written leaves an orphan record). Answers how many it deleted.
	 */
	purgeIdempotencyDue(now: string, limit: number): Promise<number>;
}

/** The caps {@link AgentSessionStore.insert} enforces atomically. */
export interface AgentSessionCapacity {
	/** The instant "live" is judged at. */
	now: string;
	/** Admit only while fewer than this many sessions are live. */
	maxLive: number;
	/** Admit only while fewer than this many sessions are stored. */
	maxStored: number;
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
	 *  (a create finished late extends it, {@link AgentSessionStore.extendIdempotencyPurge}).
	 *  A record at or past it answers no replay, even before the sweep deletes it. */
	purgeAt: string;
}
