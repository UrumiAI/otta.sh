/**
 * The agent checkout session's documents (ADR-0047), one collection per fact.
 *
 *  - `agent_sessions`: one document per session (ADR-0019), keyed by the session
 *    id and written by compare-and-set. The document IS the domain's
 *    `AgentCheckoutSession` — every field the store queries (`status`,
 *    `expiresAt`, `cartId`, `networkKey`, `createdAt`, `purgeAt`) is a scalar on
 *    it, so no mirror field is owed.
 *  - `agent_session_links`: the hashed hand-off token index, keyed by the token
 *    HASH (the raw token is never stored). A session can answer for several
 *    hashes — its current link and every redeemed earlier one — and the filter
 *    algebra cannot reach into an array, so each hash gets a pointer document.
 *    A pointer is only a HINT: the lookup re-reads the session and answers it
 *    only when the session still names that hash, so a pointer left behind by a
 *    replaced link or a lost write is harmless.
 *  - `agent_session_create_keys`: the create-time idempotency index, keyed by a
 *    digest of (network key, `Idempotency-Key`); insert-if-absent is a
 *    compare-and-set against no document.
 *
 * A DECLARED INDEX IS A READ CONTRACT: every `where`/`orderBy` field below is
 * declared, and nothing is queried that is not. Lookups by token hash and by
 * create key are document-id reads, so neither needs an index.
 */

import type { AgentCheckoutSession, AgentCreateIdempotencyRecord } from "@urumi.ai/otta-domain";
import { hashToken } from "./token-hash.js";

export const AGENT_SESSIONS_COLLECTION = "agent_sessions";
export const AGENT_SESSION_LINKS_COLLECTION = "agent_session_links";
export const AGENT_SESSION_CREATE_KEYS_COLLECTION = "agent_session_create_keys";

/** One collection's declared indexes (the shape every `*_COLLECTIONS` constant uses). */
export interface AgentSessionCollectionIndexDeclaration {
	readonly indexes?: readonly (string | readonly string[])[];
	readonly uniqueIndexes?: readonly (string | readonly string[])[];
}

/**
 * The three collections the agent-session store owns, with every field it
 * queries:
 *  - `status` + `expiresAt` — `countLive` (open, unexpired);
 *  - `networkKey` + `createdAt` — `countCreatedSince` (the per-network cap);
 *  - `cartId` + `createdAt` — `findByCartId` (newest session for a cart);
 *  - `purgeAt` — `listPurgeDue` (the retention sweep);
 *  - links and create keys: `sessionId` (purged with their session) and
 *    `purgeAt` (orphans swept on their own).
 */
export const AGENT_SESSION_COLLECTIONS: Readonly<
	Record<string, AgentSessionCollectionIndexDeclaration>
> = {
	[AGENT_SESSIONS_COLLECTION]: {
		indexes: [
			"status",
			"expiresAt",
			"cartId",
			"networkKey",
			"createdAt",
			"purgeAt",
			["status", "expiresAt"],
			["networkKey", "createdAt"],
			["cartId", "createdAt"],
		],
	},
	[AGENT_SESSION_LINKS_COLLECTION]: { indexes: ["sessionId", "purgeAt"] },
	[AGENT_SESSION_CREATE_KEYS_COLLECTION]: { indexes: ["sessionId", "purgeAt"] },
};

/** The stored session: the domain aggregate itself. */
export type AgentSessionDoc = AgentCheckoutSession;

/** A token-hash pointer. Its document id is the hash. */
export interface AgentSessionLinkDoc {
	readonly tokenHash: string;
	readonly sessionId: string;
	/** The owning session's `purgeAt`, so an orphan pointer is swept on its own. */
	readonly purgeAt: string;
}

/** The stored create record: the port's record itself. */
export type AgentSessionCreateKeyDoc = AgentCreateIdempotencyRecord;

/**
 * The plain-data form of a session for storage: absent optional fields are
 * dropped rather than stored as `undefined` (absent stays absent on read).
 */
export function toAgentSessionDoc(session: AgentCheckoutSession): AgentSessionDoc {
	return JSON.parse(JSON.stringify(session)) as AgentSessionDoc;
}

/** Fill in what an older or partial document may not carry. */
export function normalizeAgentSessionDoc(doc: AgentSessionDoc): AgentCheckoutSession {
	return {
		...doc,
		lines: doc.lines ?? [],
		redeemedHandoffs: doc.redeemedHandoffs ?? [],
		writes: doc.writes ?? [],
		retiredWriteKeys: doc.retiredWriteKeys ?? [],
	};
}

/** Every token hash the session answers for: its current link and the redeemed ones. */
export function agentSessionTokenHashes(session: AgentCheckoutSession): string[] {
	const hashes = session.redeemedHandoffs.map((r) => r.tokenHash);
	if (session.handoffTokenHash !== undefined) hashes.push(session.handoffTokenHash);
	return hashes;
}

/** The create-key document id for (`networkKey`, `key`): a digest, so neither
 *  caller-supplied string ever becomes a storage id verbatim. */
export function agentSessionCreateKeyId(networkKey: string, key: string): Promise<string> {
	return hashToken(`agent-create\u0000${networkKey}\u0000${key}`);
}
