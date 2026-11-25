import {
	AGENT_HANDOFF_FINALIZE_GRACE_MS,
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

/** A slot's claim on capacity: held until `expiresAt` (or until shown abandoned). */
interface SlotDoc {
	sessionId: AgentSessionId;
	expiresAt: string;
	claimedAt: string;
}

/** A slot whose session never landed is free this long after it was taken. */
const ABANDONED_SLOT_MS = 60 * 1000;

/** Yield to every other pending caller, so a read and the write after it interleave. */
async function interleave(): Promise<void> {
	for (let i = 0; i < 3; i++) await Promise.resolve();
}

/**
 * A map of documents offering ONLY what ADR-0019 storage offers: a versioned
 * read and a compare-and-set (insert at `null`, delete with `null`). Every call
 * yields first, so concurrent callers interleave between a read and their
 * compare-and-set exactly as they would over a real store.
 */
class CasDocs<T> {
	#docs = new Map<string, { value: T; version: number }>();
	#next = 1;

	async get(id: string): Promise<{ value: T; version: number } | null> {
		await interleave();
		const doc = this.#docs.get(id);
		return doc === undefined ? null : { value: structuredClone(doc.value), version: doc.version };
	}

	async cas(id: string, expected: number | null, value: T | null): Promise<boolean> {
		await interleave();
		const doc = this.#docs.get(id);
		if ((doc?.version ?? null) !== expected) return false;
		if (value === null) this.#docs.delete(id);
		else this.#docs.set(id, { value: structuredClone(value), version: this.#next++ });
		return true;
	}

	/** A snapshot of every document (for scans the port answers loosely). */
	async all(): Promise<[string, T][]> {
		await interleave();
		return [...this.#docs].map(([id, doc]) => [id, structuredClone(doc.value)]);
	}
}

type Step<R> = { done: true; value: R } | { done: false };
const RETRY = { done: false } as const;
function done<R>(value: R): Step<R> {
	return { done: true, value };
}

/**
 * IO-free `AgentSessionStore` fake and the REFERENCE for a CAS-only adapter:
 * sessions, create records and live-cap slots are separate documents over
 * {@link CasDocs}, which offers nothing but a versioned read and a
 * compare-and-set and yields on every call, so the contract's racing tests
 * really interleave. Every read copies.
 */
export class InMemoryAgentSessionStore implements AgentSessionStore {
	#sessions = new CasDocs<AgentCheckoutSession>();
	#records = new CasDocs<AgentCreateIdempotencyRecord>();
	#slots = new CasDocs<SlotDoc>();

	async get(id: AgentSessionId): Promise<AgentCheckoutSession | null> {
		return (await this.#sessions.get(id))?.value ?? null;
	}

	async insert(
		session: AgentCheckoutSession,
		capacity: AgentSessionCapacity,
	): Promise<Result<"insert">> {
		const stored: AgentCheckoutSession = structuredClone({ ...session, revision: 1 });
		for (;;) {
			const current = await this.#sessions.get(session.id);
			if (current !== null) return { ok: false, reason: "exists", current: current.value };
			if (agentSessionDocumentBytes(stored) > AGENT_SESSION_MAX_DOCUMENT_BYTES) {
				return { ok: false, reason: "too_large" };
			}
			const net = await this.#takeSlot(
				`net:${JSON.stringify(session.networkKey)}`,
				capacity.maxLivePerNetwork,
				stored,
				capacity.now,
			);
			if (net === null) return { ok: false, reason: "capacity" };
			const live = await this.#takeSlot("live", capacity.maxLive, stored, capacity.now);
			if (live === null) {
				await this.#slots.cas(net.id, net.version, null);
				return { ok: false, reason: "capacity" };
			}
			if (await this.#sessions.cas(session.id, null, stored)) {
				return { ok: true, session: structuredClone(stored) };
			}
			await this.#slots.cas(live.id, live.version, null);
			await this.#slots.cas(net.id, net.version, null);
		}
	}

	/** Compare-and-set the first free slot of pool `pool` (size `size`), or null if none. */
	async #takeSlot(
		pool: string,
		size: number,
		session: AgentCheckoutSession,
		now: string,
	): Promise<{ id: string; version: number } | null> {
		const start = hashOf(session.id) % Math.max(size, 1);
		for (let i = 0; i < size; i++) {
			const id = `${pool}:${(start + i) % size}`;
			const slot = await this.#slots.get(id);
			if (slot !== null && !(await this.#slotFree(slot.value, now))) continue;
			const value: SlotDoc = {
				sessionId: session.id,
				expiresAt: session.expiresAt,
				claimedAt: now,
			};
			if (await this.#slots.cas(id, slot?.version ?? null, value)) {
				const taken = await this.#slots.get(id);
				if (taken !== null && taken.value.sessionId === session.id) {
					return { id, version: taken.version };
				}
			}
		}
		return null;
	}

	async #slotFree(slot: SlotDoc, now: string): Promise<boolean> {
		if (slot.expiresAt <= now) return true;
		const abandonedAt = new Date(Date.parse(slot.claimedAt) + ABANDONED_SLOT_MS).toISOString();
		return abandonedAt <= now && (await this.#sessions.get(slot.sessionId)) === null;
	}

	async write(session: AgentCheckoutSession, expectedRevision: number): Promise<Result<"write">> {
		return this.#update<Result<"write">>(
			session.id,
			(current) => {
				if (current === null || current.revision !== expectedRevision) {
					return { refuse: { ok: false, reason: "conflict", current } };
				}
				return { next: { ...session, revision: expectedRevision + 1 } };
			},
			(next) => ({ ok: true, session: next }),
		);
	}

	async findByHandoffTokenHash(tokenHash: string): Promise<AgentCheckoutSession | null> {
		for (const [, s] of await this.#sessions.all()) {
			if (
				s.handoffTokenHash === tokenHash ||
				s.redeemedHandoffs.some((r) => r.tokenHash === tokenHash)
			) {
				return s;
			}
		}
		return null;
	}

	async findByCartId(cartId: string): Promise<AgentCheckoutSession | null> {
		let found: AgentCheckoutSession | null = null;
		for (const [, s] of await this.#sessions.all()) {
			if (s.cartId !== cartId && s.shopperCartId !== cartId) continue;
			if (found === null || s.createdAt > found.createdAt) found = s;
		}
		return found;
	}

	async getIdempotency(
		networkKey: string,
		key: string,
	): Promise<AgentCreateIdempotencyRecord | null> {
		return (await this.#records.get(idempotencyId(networkKey, key)))?.value ?? null;
	}

	async putIdempotency(record: AgentCreateIdempotencyRecord): Promise<Result<"putIdempotency">> {
		const id = idempotencyId(record.networkKey, record.key);
		for (;;) {
			if (await this.#records.cas(id, null, record)) return { stored: true };
			const existing = await this.#records.get(id);
			if (existing !== null) return { stored: false, existing: existing.value };
		}
	}

	async adoptIdempotency(
		networkKey: string,
		key: string,
		adopt: { sessionId: AgentSessionId; attemptId: string; purgeAt: string },
	): Promise<boolean> {
		const id = idempotencyId(networkKey, key);
		for (;;) {
			const r = await this.#records.get(id);
			if (r === null || r.value.sessionId !== adopt.sessionId) return false;
			const purgeAt = r.value.purgeAt > adopt.purgeAt ? r.value.purgeAt : adopt.purgeAt;
			if (
				await this.#records.cas(id, r.version, { ...r.value, attemptId: adopt.attemptId, purgeAt })
			) {
				return true;
			}
		}
	}

	async releaseIdempotency(networkKey: string, key: string, attemptId: string): Promise<boolean> {
		const id = idempotencyId(networkKey, key);
		for (;;) {
			const r = await this.#records.get(id);
			if (r === null || r.value.attemptId !== attemptId) return false;
			if (await this.#records.cas(id, r.version, null)) return true;
		}
	}

	async claimHandoff(
		id: AgentSessionId,
		claim: {
			tokenHash: string;
			claimId: string;
			redeemerHash: string;
			now: string;
			leaseUntil: string;
		},
	): Promise<Result<"claimHandoff">> {
		return this.#update<Result<"claimHandoff">>(
			id,
			(s) => {
				if (s === null) return { refuse: { ok: false, reason: "not_found" } };
				if (s.handoffTokenHash !== claim.tokenHash) {
					return { refuse: { ok: false, reason: "token_mismatch" } };
				}
				if (s.status === "canceled") return { refuse: { ok: false, reason: "canceled" } };
				if (s.status === "completed") return { refuse: { ok: false, reason: "completed" } };
				if (s.handoffUsedAt !== undefined) return { refuse: { ok: false, reason: "already_used" } };
				if (s.expiresAt <= claim.now) return { refuse: { ok: false, reason: "expired" } };
				if (s.lines.length === 0) return { refuse: { ok: false, reason: "incomplete" } };
				const held = s.handoffClaim;
				if (held !== undefined && isAgentHandoffClaimLive(s, claim.now)) {
					return { refuse: { ok: false, reason: "claimed", leaseUntil: held.leaseUntil } };
				}
				if (held !== undefined && held.redeemerHash !== claim.redeemerHash) {
					return { refuse: { ok: false, reason: "bound" } };
				}
				return {
					next: {
						...s,
						handoffClaim: {
							tokenHash: claim.tokenHash,
							claimId: claim.claimId,
							redeemerHash: claim.redeemerHash,
							claimedAt: claim.now,
							leaseUntil: claim.leaseUntil,
						},
						revision: s.revision + 1,
					},
				};
			},
			(next) => ({ ok: true, session: next }),
		);
	}

	async finalizeHandoff(
		id: AgentSessionId,
		finalize: { claimId: string; cartId: string; now: string; retainUntil: string },
	): Promise<Result<"finalizeHandoff">> {
		return this.#update<Result<"finalizeHandoff">>(
			id,
			(s) => {
				if (s === null) return { refuse: { ok: false, reason: "not_found" } };
				const claim = s.handoffClaim;
				if (claim?.claimId !== finalize.claimId) {
					return { refuse: { ok: false, reason: "claim_lost" } };
				}
				if (s.status === "canceled") return { refuse: { ok: false, reason: "canceled" } };
				if (s.status === "completed") return { refuse: { ok: false, reason: "completed" } };
				if (s.handoffUsedAt !== undefined) {
					return {
						refuse:
							s.shopperCartId === finalize.cartId
								? { ok: true, replayed: true, session: s }
								: { ok: false, reason: "already_used" },
					};
				}
				if (s.expiresAt <= finalize.now) return { refuse: { ok: false, reason: "expired" } };
				const graceEnd = new Date(
					Date.parse(claim.leaseUntil) + AGENT_HANDOFF_FINALIZE_GRACE_MS,
				).toISOString();
				if (graceEnd <= finalize.now) return { refuse: { ok: false, reason: "lease_lapsed" } };
				return {
					next: {
						...s,
						handoffUsedAt: finalize.now,
						shopperCartId: finalize.cartId,
						purgeAt: finalize.retainUntil,
						revision: s.revision + 1,
					},
				};
			},
			(next) => ({ ok: true, replayed: false, session: next }),
		);
	}

	async releaseHandoffClaim(id: AgentSessionId, claimId: string): Promise<boolean> {
		return (
			(await this.#update<boolean>(
				id,
				(s) => {
					if (s === null || s.handoffUsedAt !== undefined || s.handoffClaim?.claimId !== claimId) {
						return { refuse: false };
					}
					const { handoffClaim: _released, ...rest } = s;
					return { next: { ...rest, revision: s.revision + 1 } };
				},
				() => true,
			)) === true
		);
	}

	async countLive(now: string): Promise<number> {
		let n = 0;
		for (const [, s] of await this.#sessions.all()) {
			if (isAgentSessionOpen(s.status) && s.expiresAt > now) n++;
		}
		return n;
	}

	async countCreatedSince(networkKey: string, since: string): Promise<number> {
		let n = 0;
		for (const [, s] of await this.#sessions.all()) {
			if (s.networkKey === networkKey && s.createdAt >= since) n++;
		}
		return n;
	}

	async listPurgeDue(now: string, limit: number): Promise<AgentSessionId[]> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError("listPurgeDue limit must be a positive integer");
		}
		const due: AgentSessionId[] = [];
		for (const [, s] of await this.#sessions.all()) {
			if (due.length >= limit) break;
			if (s.purgeAt <= now) due.push(s.id);
		}
		return due;
	}

	async purge(id: AgentSessionId, now: string): Promise<boolean> {
		const s = await this.#sessions.get(id);
		if (s === null || s.value.purgeAt > now) return false;
		// Create records first, the session last: a purge cut short stays due.
		for (const [recordId, r] of await this.#records.all()) {
			if (r.sessionId !== id) continue;
			const current = await this.#records.get(recordId);
			if (current !== null && current.value.sessionId === id) {
				await this.#records.cas(recordId, current.version, null);
			}
		}
		return this.#sessions.cas(id, s.version, null);
	}

	async purgeIdempotencyDue(now: string, limit: number): Promise<number> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError("purgeIdempotencyDue limit must be a positive integer");
		}
		let deleted = 0;
		for (const [id] of await this.#records.all()) {
			if (deleted >= limit) break;
			const r = await this.#records.get(id);
			if (r !== null && r.value.purgeAt <= now && (await this.#records.cas(id, r.version, null))) {
				deleted++;
			}
		}
		return deleted;
	}

	/**
	 * Read-decide-compare-and-set on one session, retried while a racer wins in
	 * between. `decide` answers a refusal (returned as is) or the next document,
	 * which must fit the byte cap; `won` builds the answer from what was stored.
	 */
	async #update<R>(
		id: AgentSessionId,
		decide: (
			current: AgentCheckoutSession | null,
		) => { refuse: R } | { next: AgentCheckoutSession },
		won: (stored: AgentCheckoutSession) => R,
	): Promise<R | { ok: false; reason: "too_large" }> {
		for (;;) {
			const current = await this.#sessions.get(id);
			const step: Step<R | { ok: false; reason: "too_large" }> = await (async () => {
				const decided = decide(current?.value ?? null);
				if ("refuse" in decided) return done(decided.refuse);
				if (agentSessionDocumentBytes(decided.next) > AGENT_SESSION_MAX_DOCUMENT_BYTES) {
					return done({ ok: false as const, reason: "too_large" as const });
				}
				const stored = structuredClone(decided.next);
				return (await this.#sessions.cas(id, current?.version ?? null, stored))
					? done(won(stored))
					: RETRY;
			})();
			if (step.done) return step.value;
		}
	}
}

/** The map key of a caller-scoped create record. */
function idempotencyId(networkKey: string, key: string): string {
	return JSON.stringify([networkKey, key]);
}

/** A small deterministic string hash (FNV-1a), to spread slot probes. */
function hashOf(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}
