/**
 * The agent checkout session's documents (ADR-0047), one collection per fact.
 *
 *  - `agent_sessions`: one document per session (ADR-0019), keyed by the session
 *    id and written by compare-and-set. The document is the domain's
 *    `AgentCheckoutSession` plus two adapter-private fields: `admission`
 *    (`hidden` while its insert is landing its slots, `admitted` after) and
 *    `slots` (the slot documents its insert took). A hidden document answers no
 *    read: every index lookup filters on `admission: "admitted"`, and a direct
 *    read drops it. Only `listPurgeDue` and `purge` see hidden documents, so a
 *    stranded one is still swept.
 *  - `agent_session_slots`: the live-cap slots. A cap of N in a pool is the N
 *    documents `<pool>:<index>` (index below the cap); an insert takes a free one
 *    by compare-and-set, so the cap holds however many inserts race. A slot is
 *    `taken` until its session document is written and the insert marks it
 *    `landed`.
 *  - `agent_session_links`: the hashed hand-off token index, keyed by the token
 *    HASH (the raw token is never stored). A pointer is only a HINT: the lookup
 *    re-reads the session and answers it only when the session still names that
 *    hash, so a pointer left behind by a replaced link or a lost write is harmless.
 *  - `agent_session_create_keys`: the create-time idempotency index, keyed by a
 *    digest of (network key, `Idempotency-Key`); insert-if-absent is a
 *    compare-and-set against no document.
 *
 * A DECLARED INDEX IS A READ CONTRACT: every `where`/`orderBy` field below is
 * declared, and nothing is queried that is not. Lookups by token hash, by create
 * key and by slot are document-id reads, so none needs an index.
 */

import type {
	AgentCheckoutSession,
	AgentCreateIdempotencyRecord,
	AgentSessionId,
} from "@urumi.ai/otta-domain";
import { sha256HexSync } from "./sha256-sync.js";

export const AGENT_SESSIONS_COLLECTION = "agent_sessions";
export const AGENT_SESSION_LINKS_COLLECTION = "agent_session_links";
export const AGENT_SESSION_CREATE_KEYS_COLLECTION = "agent_session_create_keys";
export const AGENT_SESSION_SLOTS_COLLECTION = "agent_session_slots";

/** One collection's declared indexes (the shape every `*_COLLECTIONS` constant uses). */
export interface AgentSessionCollectionIndexDeclaration {
	readonly indexes?: readonly (string | readonly string[])[];
	readonly uniqueIndexes?: readonly (string | readonly string[])[];
}

/**
 * The four collections the agent-session store owns, with every field it
 * queries:
 *  - sessions, always behind `admission`: `status` + `expiresAt` (`countLive`),
 *    `networkKey` + `createdAt` (the per-network create count), `cartId` /
 *    `shopperCartId` + `createdAt` (`findByCartId`); and `purgeAt` alone
 *    (`listPurgeDue`, hidden documents included);
 *  - slots: `pool` (`occupiedSlots`), `sessionId` (a session's slots),
 *    `expiresAt` and `state` + `claimedAt` (`purgeSlotsDue`);
 *  - links and create keys: `sessionId` (purged with their session) and
 *    `purgeAt` (orphans swept on their own).
 */
export const AGENT_SESSION_COLLECTIONS: Readonly<
	Record<string, AgentSessionCollectionIndexDeclaration>
> = {
	[AGENT_SESSIONS_COLLECTION]: {
		indexes: [
			"admission",
			"status",
			"expiresAt",
			"cartId",
			"shopperCartId",
			"networkKey",
			"createdAt",
			"purgeAt",
			["admission", "status", "expiresAt"],
			["admission", "networkKey", "createdAt"],
			["admission", "cartId", "createdAt"],
			["admission", "shopperCartId", "createdAt"],
		],
	},
	[AGENT_SESSION_SLOTS_COLLECTION]: {
		indexes: ["pool", "sessionId", "expiresAt", "state", "claimedAt", ["state", "claimedAt"]],
	},
	[AGENT_SESSION_LINKS_COLLECTION]: { indexes: ["sessionId", "purgeAt"] },
	[AGENT_SESSION_CREATE_KEYS_COLLECTION]: { indexes: ["sessionId", "purgeAt"] },
};

/** Whether a stored session may be seen by reads. */
export type AgentSessionAdmission = "hidden" | "admitted";

/** The stored session: the domain aggregate plus the adapter's admission state. */
export type AgentSessionDoc = AgentCheckoutSession & {
	/** `hidden` from the insert's write until both slots landed; reads skip it. */
	admission: AgentSessionAdmission;
	/** The slot document ids the insert took (network pool, then store-wide). */
	slots: string[];
};

/** A live-cap slot. Its document id is `<pool>:<index>`. */
export interface AgentSessionSlotDoc {
	readonly pool: string;
	readonly sessionId: AgentSessionId;
	/** The session's `expiresAt`: the slot frees itself then. */
	readonly expiresAt: string;
	readonly claimedAt: string;
	/** `taken` until the session document is written and the insert lands it. */
	readonly state: "taken" | "landed";
}

/** A token-hash pointer. Its document id is the hash. */
export interface AgentSessionLinkDoc {
	readonly tokenHash: string;
	readonly sessionId: string;
	/** The owning session's `purgeAt`, so an orphan pointer is swept on its own. */
	readonly purgeAt: string;
}

/** The stored create record: the port's record itself. */
export type AgentSessionCreateKeyDoc = AgentCreateIdempotencyRecord;

/** The store-wide slot pool. */
export const AGENT_SESSION_LIVE_POOL = "live";

/** A network's slot pool: a digest of its key, so a caller string never becomes an
 *  id. Synchronous (see `sha256-sync.ts`): no hop before the first storage call. */
export function agentSessionNetworkPool(networkKey: string): string {
	return `net:${sha256HexSync(`agent-pool\u0000${networkKey}`)}`;
}

/** The slot document id for `index` in `pool`. */
export function agentSessionSlotId(pool: string, index: number): string {
	return `${pool}:${String(index)}`;
}

/**
 * The plain-data form of a session for storage: absent optional fields are
 * dropped rather than stored as `undefined` (absent stays absent on read).
 */
export function toAgentSessionDoc(
	session: AgentCheckoutSession,
	admission: AgentSessionAdmission,
	slots: readonly string[],
): AgentSessionDoc {
	const { admission: _a, slots: _s, ...plain } = session as AgentCheckoutSession &
		Partial<Pick<AgentSessionDoc, "admission" | "slots">>;
	return JSON.parse(JSON.stringify({ ...plain, admission, slots })) as AgentSessionDoc;
}

/** The domain session a stored document holds: the adapter's fields dropped. */
export function normalizeAgentSessionDoc(doc: AgentSessionDoc): AgentCheckoutSession {
	const { admission: _admission, slots: _slots, ...session } = doc;
	return {
		...session,
		lines: session.lines ?? [],
		redeemedHandoffs: session.redeemedHandoffs ?? [],
		writes: session.writes ?? [],
		retiredWriteKeys: session.retiredWriteKeys ?? [],
	};
}

/** Every token hash the session answers for: its current link and the redeemed ones. */
export function agentSessionTokenHashes(session: AgentCheckoutSession): string[] {
	const hashes = session.redeemedHandoffs.map((r) => r.tokenHash);
	if (session.handoffTokenHash !== undefined) hashes.push(session.handoffTokenHash);
	return hashes;
}

/** The create-key document id for (`networkKey`, `key`): a SHA-256 digest, so
 *  neither caller-supplied string ever becomes a storage id verbatim. Synchronous
 *  (see `sha256-sync.ts`), and the same hex `hashToken` would answer. */
export function agentSessionCreateKeyId(networkKey: string, key: string): string {
	return sha256HexSync(`agent-create\u0000${networkKey}\u0000${key}`);
}
