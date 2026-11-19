import {
	isAgentSessionOpen,
	type AgentCheckoutSession,
	type AgentSessionId,
} from "../agentic/model.js";
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
			if (
				s.handoffTokenHash === tokenHash ||
				s.redeemedHandoffs.some((r) => r.tokenHash === tokenHash)
			) {
				return structuredClone(s);
			}
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

	async getIdempotency(
		networkKey: string,
		key: string,
	): Promise<AgentCreateIdempotencyRecord | null> {
		const r = this.#idempotency.get(idempotencyId(networkKey, key));
		return r === undefined ? null : { ...r };
	}

	async putIdempotency(
		record: AgentCreateIdempotencyRecord,
	): Promise<{ stored: true } | { stored: false; existing: AgentCreateIdempotencyRecord }> {
		const id = idempotencyId(record.networkKey, record.key);
		const existing = this.#idempotency.get(id);
		if (existing !== undefined) return { stored: false, existing: { ...existing } };
		this.#idempotency.set(id, { ...record });
		return { stored: true };
	}

	async markHandoffUsed(
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
	> {
		const s = this.#sessions.get(id);
		if (s === undefined) return { ok: false, reason: "not_found" };
		if (s.handoffTokenHash !== tokenHash) return { ok: false, reason: "token_mismatch" };
		if (s.status === "canceled") return { ok: false, reason: "canceled" };
		if (s.status === "completed") return { ok: false, reason: "completed" };
		if (s.handoffUsedAt !== undefined) return { ok: false, reason: "already_used" };
		if (s.expiresAt <= now) return { ok: false, reason: "expired" };
		if (s.lines.length === 0) return { ok: false, reason: "incomplete" };
		const stored: AgentCheckoutSession = { ...s, handoffUsedAt: now, revision: s.revision + 1 };
		this.#sessions.set(id, stored);
		return { ok: true, session: structuredClone(stored) };
	}

	async extendIdempotencyPurge(networkKey: string, key: string, purgeAt: string): Promise<void> {
		const id = idempotencyId(networkKey, key);
		const r = this.#idempotency.get(id);
		if (r !== undefined && r.purgeAt < purgeAt) this.#idempotency.set(id, { ...r, purgeAt });
	}

	async countLive(now: string): Promise<number> {
		let n = 0;
		for (const s of this.#sessions.values()) {
			if (isAgentSessionOpen(s.status) && s.expiresAt > now) n++;
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

	async purgeIdempotencyDue(now: string, limit: number): Promise<number> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError("purgeIdempotencyDue limit must be a positive integer");
		}
		let deleted = 0;
		for (const [id, r] of this.#idempotency) {
			if (deleted >= limit) break;
			if (r.purgeAt <= now) {
				this.#idempotency.delete(id);
				deleted++;
			}
		}
		return deleted;
	}
}

/** The map key of a caller-scoped create record. */
function idempotencyId(networkKey: string, key: string): string {
	return JSON.stringify([networkKey, key]);
}
