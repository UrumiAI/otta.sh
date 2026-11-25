import type { AgentCheckoutSession, AgentSessionId } from "../agentic/model.js";

/**
 * The `AgentSessionStore` port (ADR-0047). Holds agent checkout sessions, one
 * document each (ADR-0019), written by compare-and-set on `revision`, plus the
 * create-time idempotency index (a session cannot hold the record of its own
 * create before it exists). Writes to an existing session keep their
 * idempotency records on the session itself, inside the same compare-and-set.
 *
 * Every guarantee here must be implementable with PER-DOCUMENT compare-and-set
 * alone (ADR-0019: EmDash storage has no transactions; D1, Postgres and EmDash
 * all qualify). Adapters are REQUIRED to keep the caps race-safe, and the
 * contract suite proves it by running its racing tests against interleaving
 * callers; the EmDash adapter must pass it. The reference design (the in-memory
 * fake) uses lease SLOTS: a cap of N is N slot documents (`<pool>:<index>`,
 * index below the cap); an insert compare-and-sets a free slot in each pool,
 * writes the session (not yet visible to reads), then compare-and-sets a
 * `landed` mark onto each slot and makes the session visible. A slot is free
 * when absent or expired, or ABANDONED: never landed, taken more than 60 s ago,
 * AND its session document absent. Probes read a session only for such an old
 * unlanded slot; landed ones skip the read. So a slot whose session was written
 * is never retaken, however long its insert stalled or if it crashed; a later
 * insert of the same id, an adoption of its create record, or
 * {@link purgeSlotsDue} lands its marks. An insert whose slot was taken before
 * its session was written drops that never-visible session and answers
 * `capacity`.
 *
 * Storage bounds the store itself enforces:
 *  - {@link insert} admits a session only while it can hold a live slot in the
 *    store-wide pool (`maxLive`) and in its network's pool
 *    (`maxLivePerNetwork`). A slot is held until the session's `expiresAt`,
 *    unless it is completed (a {@link write} to `completed`, i.e. an order),
 *    which frees its slots at once. A hand-off and a cancel free nothing, so
 *    neither a create-cancel nor a create-redeem loop can outrun the cap.
 *  - Slot documents are deleted by version when their session is purged
 *    ({@link purge}), freed, or by {@link purgeSlotsDue} once expired or
 *    abandoned, so they never accumulate as network keys rotate.
 *  - Lowering a cap: only slots below the new size are probed, so the new cap
 *    is exact for inserts once the older slots expire (within 24 h); until then
 *    {@link occupiedSlots} still counts them, which the early refusal uses.
 *  - {@link insert}, {@link write}, {@link claimHandoff} and
 *    {@link finalizeHandoff} refuse a document heavier than
 *    `AGENT_SESSION_MAX_DOCUMENT_BYTES` (`agentSessionDocumentBytes`), `too_large`.
 *
 * Every method answers what it stores; none throws for an expected outcome.
 */
export interface AgentSessionStore {
	/** The session, or null. */
	get(id: AgentSessionId): Promise<AgentCheckoutSession | null>;
	/**
	 * Insert-if-absent, under the live caps. Checked in this order: a session with
	 * that id exists → `exists` with it (a racing create's replay wins over every
	 * cap); the document is over the byte cap → `too_large`; no live slot free in
	 * the network's pool or the store-wide pool at `capacity.now` → `capacity`
	 * (any slot taken for a refused or lost insert is given back). The winner is
	 * stored at `revision` 1 and returned. However many inserts race, the store
	 * never holds more slots than either cap. The passed `revision` is ignored.
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
	 * `revision` is ignored. A winning write to `completed` (an order) then frees
	 * the session's live slots and moves its create records to `purgeAt` no
	 * earlier than the session's.
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
	 * session's status, expiry, claim or use.
	 */
	findByHandoffTokenHash(tokenHash: string): Promise<AgentCheckoutSession | null>;
	/** The most recently created session whose agent `cartId` OR `shopperCartId`
	 *  is `cartId`, or null. */
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
	 * Take over a create record to finish its orphaned create (its session was
	 * never stored): compare-and-set it, if it still points at `sessionId`, to
	 * carry `attemptId` and a `purgeAt` no earlier than both its own and the one
	 * given; from then on only `attemptId` can {@link releaseIdempotency} it.
	 * `lost` if it is gone or points elsewhere; `busy` (retryable, the record
	 * unchanged) while its session holds a live slot at `now`: landed, or taken
	 * and not yet abandoned (another attempt's insert is in flight). If that
	 * session was written but its insert stopped before landing, the adoption
	 * lands it first, so the retry replays it.
	 */
	adoptIdempotency(
		networkKey: string,
		key: string,
		adopt: { sessionId: AgentSessionId; attemptId: string; purgeAt: string; now: string },
	): Promise<"adopted" | "lost" | "busy">;
	/**
	 * Delete the create record for (`networkKey`, `key`) by compare-and-set, only
	 * if it still carries `attemptId` (the attempt that put or adopted it, whose
	 * insert was refused; `not_owner` otherwise) and its session holds no live
	 * slot at `now` (`busy`, retryable: another attempt's insert is in flight or landed).
	 */
	releaseIdempotency(
		networkKey: string,
		key: string,
		attemptId: string,
		now: string,
	): Promise<"released" | "not_owner" | "busy">;
	/**
	 * Claim the session's current hand-off link for a redeem, as a lease. One
	 * compare-and-set guarded on, in this order: the session exists
	 * (`not_found`), `tokenHash` is its current link (`token_mismatch`), it is not
	 * canceled (`canceled`) or completed (`completed`), the link was not
	 * finalized (`already_used`), `expiresAt` is after `now` (`expired`), it has a
	 * line (`incomplete`), no unfinalized claim's lease is still running
	 * (`claimed`, with that lease's end — whoever asks), and the document fits
	 * (`too_large`). A lapsed unfinalized claim binds nobody: any redeemer may
	 * claim again.
	 * The winner sets `handoffClaim` = {tokenHash, claimId, redeemerHash,
	 * claimedAt: now, leaseUntil}, bumps the revision and answers the session.
	 * Exactly one of any number of racing claims wins.
	 */
	claimHandoff(
		id: AgentSessionId,
		claim: {
			tokenHash: string;
			claimId: string;
			redeemerHash: string;
			now: string;
			leaseUntil: string;
		},
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
					| "incomplete"
					| "too_large";
		  }
	>;
	/**
	 * Finalize a claimed hand-off. One compare-and-set guarded on, in this order:
	 * the session exists (`not_found`); its `handoffClaim.claimId` is `claimId`
	 * (`claim_lost`); it is not canceled (`canceled`) or completed (`completed`);
	 * if already finalized, the same cart replays (`replayed: true`, nothing
	 * written) and another is `already_used`; otherwise `now` is before
	 * `expiresAt` (`expired`) and before the claim's `leaseUntil` +
	 * `AGENT_HANDOFF_FINALIZE_GRACE_MS` (`lease_lapsed`), and the document fits
	 * (`too_large`). The winner stamps `handoffUsedAt = now`, `shopperCartId =
	 * cartId` and `purgeAt = retainUntil`, keeps the claim, bumps the revision.
	 * Exactly one of any number of racing finalizes of one claim writes. After
	 * the write (and again on a replay, so a crash in between is repaired) it
	 * moves every create record of the session to `purgeAt` no earlier than
	 * `retainUntil`. It frees no slot.
	 */
	finalizeHandoff(
		id: AgentSessionId,
		finalize: { claimId: string; cartId: string; now: string; retainUntil: string },
	): Promise<
		| { ok: true; replayed: boolean; session: AgentCheckoutSession }
		| {
				ok: false;
				reason:
					| "not_found"
					| "claim_lost"
					| "canceled"
					| "completed"
					| "already_used"
					| "expired"
					| "lease_lapsed"
					| "too_large";
		  }
	>;
	/**
	 * Drop an unfinalized claim early (the redeem failed, e.g. no line could be
	 * added), so the link may be claimed again at once instead of after the lease.
	 * Only the claim `claimId` names, and only before it finalized; bumps the
	 * revision. Answers whether it released.
	 */
	releaseHandoffClaim(id: AgentSessionId, claimId: string): Promise<boolean>;
	/** Sessions that are open and whose `expiresAt` is strictly after `now`. */
	countLive(now: string): Promise<number>;
	/** Live slots held at `now`, store-wide and in `networkKey`'s pool, at any
	 *  index (an over-cap slot left by a lowered cap counts). */
	occupiedSlots(networkKey: string, now: string): Promise<{ store: number; network: number }>;
	/** Every slot document stored, held or not (bounded by the sweep). */
	countSlotDocs(): Promise<number>;
	/** Delete up to `limit` slot documents that are expired or abandoned at
	 *  `now`, by version, and land the marks of a written session whose insert
	 *  stopped before landing. Answers how many it deleted. */
	purgeSlotsDue(now: string, limit: number): Promise<number>;
	/** Sessions created by `networkKey` at or after `since`, whatever their status. */
	countCreatedSince(networkKey: string, since: string): Promise<number>;
	/** Ids of sessions whose `purgeAt` is at or before `now`, at most `limit` of them. */
	listPurgeDue(now: string, limit: number): Promise<AgentSessionId[]>;
	/**
	 * Delete the session, its create records, its slot documents and its
	 * hand-off lookups, if its `purgeAt` is at or before `now`. Answers whether
	 * it deleted; idempotent.
	 */
	purge(id: AgentSessionId, now: string): Promise<boolean>;
	/**
	 * Delete up to `limit` create records whose `purgeAt` is at or before `now`,
	 * whether or not their session exists (a create that crashed before its
	 * session was written leaves an orphan record). Answers how many it deleted.
	 */
	purgeIdempotencyDue(now: string, limit: number): Promise<number>;
}

/** The live caps {@link AgentSessionStore.insert} enforces. */
export interface AgentSessionCapacity {
	/** The instant slot expiry is judged at. */
	now: string;
	/** Store-wide live slots. */
	maxLive: number;
	/** Live slots one `networkKey` may hold. */
	maxLivePerNetwork: number;
}

/** Maps a caller's create `Idempotency-Key` to the session it created. */
export interface AgentCreateIdempotencyRecord {
	/** The creating caller's network key; part of the record's identity. */
	networkKey: string;
	key: string;
	fingerprint: string;
	sessionId: AgentSessionId;
	/** The create attempt that put (or last adopted) the record; only it may release it. */
	attemptId: string;
	createdAt: string;
	/** The session's own `purgeAt` at create (never earlier than it). A record at
	 *  or past it answers no replay, even before the sweep deletes it. */
	purgeAt: string;
}
