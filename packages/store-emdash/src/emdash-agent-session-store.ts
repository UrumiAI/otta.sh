/**
 * `AgentSessionStore` over the plugin's document store (ADR-0047, ADR-0019).
 *
 * One document per session, written by compare-and-set on the HOST revision and
 * guarded on the domain `revision` the caller expected, so two writers that both
 * read revision `n` cannot both win. The single-use hand-off mark is the same
 * compare-and-set with its guards re-checked on the document it replaces, which
 * is what makes exactly one of any number of racing redeems win.
 *
 * Token-hash pointers are written BEFORE the session they point at: a session is
 * never stored with a link the lookup cannot find, and a pointer whose session
 * write lost is ignored by the lookup (it re-checks the session).
 *
 * Purge order is pointers and create records first, the session last, so a
 * purge cut short leaves the session due and listed for the next run.
 */

import type {
	AgentCheckoutSession,
	AgentCreateIdempotencyRecord,
	AgentSessionId,
	AgentSessionStore,
} from "@urumi.ai/otta-domain";
import {
	AGENT_SESSION_CREATE_KEYS_COLLECTION,
	AGENT_SESSION_LINKS_COLLECTION,
	AGENT_SESSIONS_COLLECTION,
	agentSessionCreateKeyId,
	agentSessionTokenHashes,
	normalizeAgentSessionDoc,
	toAgentSessionDoc,
	type AgentSessionCreateKeyDoc,
	type AgentSessionDoc,
	type AgentSessionLinkDoc,
} from "./agent-session-documents.js";
import {
	CAS_RETRY,
	casDone,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import type { StorageAccess, StorageCollection, WhereClause } from "./storage-access.js";

/** The page size a purge walks its pointers and create records in. */
const PURGE_PAGE_SIZE = 100;
/** A purge never walks more pages than this for one session (a session holds
 *  at most a handful of pointers and one create record per network key). */
const MAX_PURGE_PAGES = 20;

const OPEN_STATUSES = ["incomplete", "requires_escalation"];

export interface EmdashAgentSessionStoreOptions {
	storage: StorageAccess;
	maxCasAttempts?: number;
	onCasAttempts?: (operation: string, attempts: number) => void;
	sleep?: CasRetryOptions["sleep"];
	random?: CasRetryOptions["random"];
}

type WriteResult =
	| { ok: true; session: AgentCheckoutSession }
	| { ok: false; current: AgentCheckoutSession | null };

type PutResult = { stored: true } | { stored: false; existing: AgentCreateIdempotencyRecord };

type MarkResult = Awaited<ReturnType<AgentSessionStore["markHandoffUsed"]>>;

export class EmdashAgentSessionStore implements AgentSessionStore {
	readonly #sessions: StorageCollection<AgentSessionDoc>;
	readonly #links: StorageCollection<AgentSessionLinkDoc>;
	readonly #createKeys: StorageCollection<AgentSessionCreateKeyDoc>;
	readonly #retry: CasRetryOptions;

	constructor(options: EmdashAgentSessionStoreOptions) {
		this.#sessions = collectionOf<AgentSessionDoc>(options.storage, AGENT_SESSIONS_COLLECTION);
		this.#links = collectionOf<AgentSessionLinkDoc>(
			options.storage,
			AGENT_SESSION_LINKS_COLLECTION,
		);
		this.#createKeys = collectionOf<AgentSessionCreateKeyDoc>(
			options.storage,
			AGENT_SESSION_CREATE_KEYS_COLLECTION,
		);
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
	}

	async get(id: AgentSessionId): Promise<AgentCheckoutSession | null> {
		const doc = await this.#sessions.get(id);
		return doc === null ? null : normalizeAgentSessionDoc(doc);
	}

	async write(
		session: AgentCheckoutSession,
		expectedRevision: number | null,
	): Promise<WriteResult> {
		const doc = toAgentSessionDoc({
			...session,
			revision: expectedRevision === null ? 1 : expectedRevision + 1,
		});
		await this.#pointLinks(doc);
		if (expectedRevision === null) {
			const inserted = await this.#sessions.compareAndSet(doc.id, null, doc);
			if (inserted.applied) return { ok: true, session: normalizeAgentSessionDoc(doc) };
			return { ok: false, current: await this.get(doc.id) };
		}
		return this.#cas<WriteResult>("writeAgentSession", async () => {
			const current = await this.#sessions.getVersioned(doc.id);
			if (current === null) return casDone({ ok: false, current: null });
			if (current.value.revision !== expectedRevision) {
				return casDone({ ok: false, current: normalizeAgentSessionDoc(current.value) });
			}
			const written = await this.#sessions.compareAndSet(doc.id, current.revision, doc);
			return written.applied
				? casDone({ ok: true, session: normalizeAgentSessionDoc(doc) })
				: CAS_RETRY;
		});
	}

	async findByHandoffTokenHash(tokenHash: string): Promise<AgentCheckoutSession | null> {
		const link = await this.#links.get(tokenHash);
		if (link === null) return null;
		const session = await this.get(link.sessionId as AgentSessionId);
		if (session === null) return null;
		return agentSessionTokenHashes(session).includes(tokenHash) ? session : null;
	}

	async findByCartId(cartId: string): Promise<AgentCheckoutSession | null> {
		const result = await this.#sessions.query({
			where: { cartId },
			orderBy: { createdAt: "desc" },
			limit: 1,
		});
		const first = result.items[0];
		return first === undefined ? null : normalizeAgentSessionDoc(first.data);
	}

	async getIdempotency(
		networkKey: string,
		key: string,
	): Promise<AgentCreateIdempotencyRecord | null> {
		const doc = await this.#createKeys.get(await agentSessionCreateKeyId(networkKey, key));
		return doc === null ? null : { ...doc };
	}

	async putIdempotency(record: AgentCreateIdempotencyRecord): Promise<PutResult> {
		const id = await agentSessionCreateKeyId(record.networkKey, record.key);
		return this.#cas<PutResult>("putAgentSessionCreateKey", async () => {
			const written = await this.#createKeys.compareAndSet(id, null, { ...record });
			if (written.applied) return casDone<PutResult>({ stored: true });
			const existing = await this.#createKeys.get(id);
			// Deleted between the refused insert and this read (a purge): try again.
			return existing === null ? CAS_RETRY : casDone({ stored: false, existing: { ...existing } });
		});
	}

	async markHandoffUsed(id: AgentSessionId, tokenHash: string, now: string): Promise<MarkResult> {
		return this.#cas<MarkResult>("markAgentHandoffUsed", async () => {
			const current = await this.#sessions.getVersioned(id);
			if (current === null) return casDone({ ok: false, reason: "not_found" });
			const session = normalizeAgentSessionDoc(current.value);
			if (session.handoffTokenHash !== tokenHash) {
				return casDone({ ok: false, reason: "token_mismatch" });
			}
			if (session.status === "canceled") return casDone({ ok: false, reason: "canceled" });
			if (session.status === "completed") return casDone({ ok: false, reason: "completed" });
			if (session.handoffUsedAt !== undefined) {
				return casDone({ ok: false, reason: "already_used" });
			}
			if (now >= session.expiresAt) return casDone({ ok: false, reason: "expired" });
			// A replace that emptied the session after the caller's lookup must not burn the link.
			if (session.lines.length === 0) return casDone({ ok: false, reason: "incomplete" });
			const next = toAgentSessionDoc({
				...session,
				handoffUsedAt: now,
				revision: session.revision + 1,
			});
			const written = await this.#sessions.compareAndSet(id, current.revision, next);
			return written.applied
				? casDone({ ok: true, session: normalizeAgentSessionDoc(next) })
				: CAS_RETRY;
		});
	}

	async extendIdempotencyPurge(networkKey: string, key: string, purgeAt: string): Promise<void> {
		const id = await agentSessionCreateKeyId(networkKey, key);
		await this.#cas<undefined>("extendAgentSessionCreateKeyPurge", async () => {
			const current = await this.#createKeys.getVersioned(id);
			if (current === null || current.value.purgeAt >= purgeAt) return casDone(undefined);
			const written = await this.#createKeys.compareAndSet(id, current.revision, {
				...current.value,
				purgeAt,
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	countLive(now: string): Promise<number> {
		return this.#sessions.count({ status: { in: OPEN_STATUSES }, expiresAt: { gt: now } });
	}

	countCreatedSince(networkKey: string, since: string): Promise<number> {
		return this.#sessions.count({ networkKey, createdAt: { gte: since } });
	}

	async listPurgeDue(now: string, limit: number): Promise<AgentSessionId[]> {
		if (limit <= 0) return [];
		const result = await this.#sessions.query({
			where: { purgeAt: { lte: now } },
			orderBy: { purgeAt: "asc" },
			limit,
		});
		return result.items.map((item) => item.data.id);
	}

	async purge(id: AgentSessionId, now: string): Promise<boolean> {
		const session = await this.#sessions.get(id);
		if (session === null || session.purgeAt > now) return false;
		await this.#deleteWhere(this.#links, { sessionId: id });
		await this.#deleteWhere(this.#createKeys, { sessionId: id });
		return this.#sessions.delete(id);
	}

	async purgeIdempotencyDue(now: string, limit: number): Promise<number> {
		if (limit <= 0) return 0;
		const due = await this.#createKeys.query({
			where: { purgeAt: { lte: now } },
			orderBy: { purgeAt: "asc" },
			limit,
		});
		let deleted = 0;
		for (const { id } of due.items) if (await this.#createKeys.delete(id)) deleted++;
		// Orphan pointers (a session write that never landed) ride the same bound;
		// they are not create records, so they are not counted.
		const links = await this.#links.query({
			where: { purgeAt: { lte: now } },
			orderBy: { purgeAt: "asc" },
			limit,
		});
		for (const { id } of links.items) await this.#links.delete(id);
		return deleted;
	}

	/** Write a pointer for every hash the session answers for that has none yet. */
	async #pointLinks(session: AgentCheckoutSession): Promise<void> {
		for (const tokenHash of agentSessionTokenHashes(session)) {
			const existing = await this.#links.get(tokenHash);
			if (existing !== null && existing.sessionId === session.id) continue;
			await this.#links.put(tokenHash, {
				tokenHash,
				sessionId: session.id,
				purgeAt: session.purgeAt,
			});
		}
	}

	async #deleteWhere(collection: StorageCollection, where: WhereClause): Promise<void> {
		for (let page = 0; page < MAX_PURGE_PAGES; page++) {
			const result = await collection.query({ where, limit: PURGE_PAGE_SIZE });
			if (result.items.length === 0) return;
			for (const { id } of result.items) await collection.delete(id);
			if (!result.hasMore) return;
		}
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}
