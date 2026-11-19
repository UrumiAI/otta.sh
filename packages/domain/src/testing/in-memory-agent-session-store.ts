import { isOpenStatus, type AgentCheckoutSession, type AgentSessionId } from "../agentic/model.js";
import type {
	AgentCreateIdempotencyRecord,
	AgentSessionStore,
} from "../ports/agent-session-store.js";

/**
 * IO-free `AgentSessionStore` fake — the first adapter to pass
 * `agentSessionStoreContract`. Every read and write copies, so a caller can never
 * mutate stored state through a returned object. Single-threaded JavaScript makes
 * each method atomic, which is what the compare-and-set and the single-winner
 * `markHandoffUsed` require.
 */
export class InMemoryAgentSessionStore implements AgentSessionStore {
	#sessions = new Map<AgentSessionId, AgentCheckoutSession>();
	#idempotency = new Map<string, AgentCreateIdempotencyRecord>();

	async get(id: AgentSessionId): Promise<AgentCheckoutSession | null> {
		const s = this.#sessions.get(id);
		return s === undefined ? null : structuredClone(s);
	}

	async write(
		session: AgentCheckoutSession,
		expectedRevision: number | null,
	): Promise<
		| { ok: true; session: AgentCheckoutSession }
		| { ok: false; current: AgentCheckoutSession | null }
	> {
		const current = this.#sessions.get(session.id);
		const wins =
			expectedRevision === null
				? current === undefined
				: current !== undefined && current.revision === expectedRevision;
		if (!wins)
			return { ok: false, current: current === undefined ? null : structuredClone(current) };
		const stored = structuredClone({ ...session, revision: (expectedRevision ?? 0) + 1 });
		this.#sessions.set(session.id, stored);
		return { ok: true, session: structuredClone(stored) };
	}

	async findByHandoffTokenHash(tokenHash: string): Promise<AgentCheckoutSession | null> {
		for (const s of this.#sessions.values()) {
			if (s.handoffTokenHash === tokenHash) return structuredClone(s);
		}
		return null;
	}

	async findByCartId(cartId: string): Promise<AgentCheckoutSession | null> {
		let found: AgentCheckoutSession | null = null;
		for (const s of this.#sessions.values()) {
			if (s.cartId !== cartId) continue;
			if (found === null || s.createdAt > found.createdAt) found = s;
		}
		return found === null ? null : structuredClone(found);
	}

	async getIdempotency(key: string): Promise<AgentCreateIdempotencyRecord | null> {
		const r = this.#idempotency.get(key);
		return r === undefined ? null : { ...r };
	}

	async putIdempotency(
		record: AgentCreateIdempotencyRecord,
	): Promise<{ stored: true } | { stored: false; existing: AgentCreateIdempotencyRecord }> {
		const existing = this.#idempotency.get(record.key);
		if (existing !== undefined) return { stored: false, existing: { ...existing } };
		this.#idempotency.set(record.key, { ...record });
		return { stored: true };
	}

	async markHandoffUsed(
		id: AgentSessionId,
		tokenHash: string,
		usedAt: string,
	): Promise<
		| { ok: true; session: AgentCheckoutSession }
		| { ok: false; reason: "not_found" | "token_mismatch" | "closed" | "already_used" }
	> {
		const s = this.#sessions.get(id);
		if (s === undefined) return { ok: false, reason: "not_found" };
		if (s.handoffTokenHash !== tokenHash) return { ok: false, reason: "token_mismatch" };
		if (!isOpenStatus(s.status)) return { ok: false, reason: "closed" };
		if (s.handoffUsedAt !== undefined) return { ok: false, reason: "already_used" };
		const stored: AgentCheckoutSession = { ...s, handoffUsedAt: usedAt, revision: s.revision + 1 };
		this.#sessions.set(id, stored);
		return { ok: true, session: structuredClone(stored) };
	}

	async countLive(now: string): Promise<number> {
		let n = 0;
		for (const s of this.#sessions.values()) {
			if (isOpenStatus(s.status) && s.expiresAt > now) n++;
		}
		return n;
	}

	async countCreatedSince(networkKey: string, since: string): Promise<number> {
		let n = 0;
		for (const s of this.#sessions.values()) {
			if (s.networkKey === networkKey && s.createdAt >= since) n++;
		}
		return n;
	}

	async listPurgeDue(now: string, limit: number): Promise<AgentSessionId[]> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError("listPurgeDue limit must be a positive integer");
		}
		const due: AgentSessionId[] = [];
		for (const s of this.#sessions.values()) {
			if (due.length >= limit) break;
			if (s.purgeAt <= now) due.push(s.id);
		}
		return due;
	}

	async purge(id: AgentSessionId, now: string): Promise<boolean> {
		const s = this.#sessions.get(id);
		if (s === undefined || s.purgeAt > now) return false;
		this.#sessions.delete(id);
		for (const [key, r] of this.#idempotency) {
			if (r.sessionId === id) this.#idempotency.delete(key);
		}
		return true;
	}
}
