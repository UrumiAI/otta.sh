import {
	AGENT_SESSION_MAX_DOCUMENT_BYTES,
	agentSessionDocumentBytes,
	isAgentHandoffClaimLive,
	isAgentSessionOpen,
	type AgentCheckoutSession,
	type AgentSessionId,
} from "../agentic/model.js";
import type {
	AgentCreateIdempotencyRecord,
	AgentSessionCapacity,
	AgentSessionStore,
} from "../ports/agent-session-store.js";

type Result<M extends keyof AgentSessionStore> = Awaited<ReturnType<AgentSessionStore[M]>>;

/**
 * IO-free `AgentSessionStore` fake — the first adapter to pass
 * `agentSessionStoreContract`. Every read and write copies, so a caller can never
 * mutate stored state through a returned object. Single-threaded JavaScript makes
 * each method atomic, which is what the compare-and-set, the capped insert and
 * the single-winner claim and finalize require.
 */
export class InMemoryAgentSessionStore implements AgentSessionStore {
	#sessions = new Map<AgentSessionId, AgentCheckoutSession>();
	#idempotency = new Map<string, AgentCreateIdempotencyRecord>();

	async get(id: AgentSessionId): Promise<AgentCheckoutSession | null> {
		const s = this.#sessions.get(id);
		return s === undefined ? null : structuredClone(s);
	}

	async insert(
		session: AgentCheckoutSession,
		capacity: AgentSessionCapacity,
	): Promise<Result<"insert">> {
		const current = this.#sessions.get(session.id);
		if (current !== undefined) {
			return { ok: false, reason: "exists", current: structuredClone(current) };
		}
		const stored = structuredClone({ ...session, revision: 1 });
		if (agentSessionDocumentBytes(stored) > AGENT_SESSION_MAX_DOCUMENT_BYTES) {
			return { ok: false, reason: "too_large" };
		}
		if (
			this.#sessions.size >= capacity.maxStored ||
			this.#countLive(capacity.now) >= capacity.maxLive
		) {
			return { ok: false, reason: "capacity" };
		}
		this.#sessions.set(session.id, stored);
		return { ok: true, session: structuredClone(stored) };
	}

	async write(session: AgentCheckoutSession, expectedRevision: number): Promise<Result<"write">> {
		const current = this.#sessions.get(session.id);
		if (current === undefined || current.revision !== expectedRevision) {
			return {
				ok: false,
				reason: "conflict",
				current: current === undefined ? null : structuredClone(current),
			};
		}
		const stored = structuredClone({ ...session, revision: expectedRevision + 1 });
		if (agentSessionDocumentBytes(stored) > AGENT_SESSION_MAX_DOCUMENT_BYTES) {
			return { ok: false, reason: "too_large" };
		}
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

	async putIdempotency(record: AgentCreateIdempotencyRecord): Promise<Result<"putIdempotency">> {
		const id = idempotencyId(record.networkKey, record.key);
		const existing = this.#idempotency.get(id);
		if (existing !== undefined) return { stored: false, existing: { ...existing } };
		this.#idempotency.set(id, { ...record });
		return { stored: true };
	}

	async releaseIdempotency(
		networkKey: string,
		key: string,
		sessionId: AgentSessionId,
	): Promise<boolean> {
		const id = idempotencyId(networkKey, key);
		const r = this.#idempotency.get(id);
		if (r === undefined || r.sessionId !== sessionId || this.#sessions.has(sessionId)) {
			return false;
		}
		this.#idempotency.delete(id);
		return true;
	}

	async claimHandoff(
		id: AgentSessionId,
		claim: { tokenHash: string; claimId: string; now: string; leaseUntil: string },
	): Promise<Result<"claimHandoff">> {
		const s = this.#sessions.get(id);
		if (s === undefined) return { ok: false, reason: "not_found" };
		if (s.handoffTokenHash !== claim.tokenHash) return { ok: false, reason: "token_mismatch" };
		if (s.status === "canceled") return { ok: false, reason: "canceled" };
		if (s.status === "completed") return { ok: false, reason: "completed" };
		if (s.handoffUsedAt !== undefined) return { ok: false, reason: "already_used" };
		if (s.expiresAt <= claim.now) return { ok: false, reason: "expired" };
		if (s.lines.length === 0) return { ok: false, reason: "incomplete" };
		if (s.handoffClaim !== undefined && isAgentHandoffClaimLive(s, claim.now)) {
			return { ok: false, reason: "claimed", leaseUntil: s.handoffClaim.leaseUntil };
		}
		const stored: AgentCheckoutSession = {
			...structuredClone(s),
			handoffClaim: {
				tokenHash: claim.tokenHash,
				claimId: claim.claimId,
				claimedAt: claim.now,
				leaseUntil: claim.leaseUntil,
			},
			revision: s.revision + 1,
		};
		this.#sessions.set(id, stored);
		return { ok: true, session: structuredClone(stored) };
	}

	async finalizeHandoff(
		id: AgentSessionId,
		finalize: { claimId: string; cartId: string; now: string },
	): Promise<Result<"finalizeHandoff">> {
		const s = this.#sessions.get(id);
		if (s === undefined) return { ok: false, reason: "not_found" };
		if (s.handoffClaim?.claimId !== finalize.claimId) return { ok: false, reason: "claim_lost" };
		if (s.handoffUsedAt !== undefined) {
			return s.cartId === finalize.cartId
				? { ok: true, replayed: true, session: structuredClone(s) }
				: { ok: false, reason: "already_used" };
		}
		if (s.status === "canceled") return { ok: false, reason: "canceled" };
		if (s.status === "completed") return { ok: false, reason: "completed" };
		const stored: AgentCheckoutSession = {
			...structuredClone(s),
			handoffUsedAt: finalize.now,
			cartId: finalize.cartId,
			revision: s.revision + 1,
		};
		this.#sessions.set(id, stored);
		return { ok: true, replayed: false, session: structuredClone(stored) };
	}

	async releaseHandoffClaim(id: AgentSessionId, claimId: string): Promise<boolean> {
		const s = this.#sessions.get(id);
		if (s === undefined || s.handoffUsedAt !== undefined || s.handoffClaim?.claimId !== claimId) {
			return false;
		}
		const { handoffClaim: _released, ...rest } = s;
		this.#sessions.set(id, { ...structuredClone(rest), revision: s.revision + 1 });
		return true;
	}

	async extendIdempotencyPurge(networkKey: string, key: string, purgeAt: string): Promise<void> {
		const id = idempotencyId(networkKey, key);
		const r = this.#idempotency.get(id);
		if (r !== undefined && r.purgeAt < purgeAt) this.#idempotency.set(id, { ...r, purgeAt });
	}

	async countLive(now: string): Promise<number> {
		return this.#countLive(now);
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

	#countLive(now: string): number {
		let n = 0;
		for (const s of this.#sessions.values()) {
			if (isAgentSessionOpen(s.status) && s.expiresAt > now) n++;
		}
		return n;
	}
}

/** The map key of a caller-scoped create record. */
function idempotencyId(networkKey: string, key: string): string {
	return JSON.stringify([networkKey, key]);
}
