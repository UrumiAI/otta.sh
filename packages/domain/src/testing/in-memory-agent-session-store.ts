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

/** A slot's claim on capacity: held until `expiresAt`, or until shown abandoned. */
interface SlotDoc {
	sessionId: AgentSessionId;
	expiresAt: string;
	claimedAt: string;
	/** Set once the session was written; an unlanded slot may be abandoned. */
	landed: boolean;
}

/**
 * A stored session and the slot documents it took (adapter-private). An insert
 * writes it `admitted: false` (invisible to every read) and admits it only
 * after both slots are marked landed, so a session no caller has seen is the
 * only kind an insert ever deletes again.
 */
interface SessionDoc {
	session: AgentCheckoutSession;
	slots: string[];
	admitted: boolean;
}

/** A slot whose session was never written is free this long after it was taken. */
const ABANDONED_SLOT_MS = 60 * 1000;

/**
 * Whether `slot` holds capacity at `now`, without reading anything else, or
 * null when that depends on its session: an unlanded slot older than
 * {@link ABANDONED_SLOT_MS} is abandoned only if its session document is absent.
 */
function slotHeldWithoutRead(slot: SlotDoc, now: string): boolean | null {
	if (slot.expiresAt <= now) return false;
	if (slot.landed || Date.parse(slot.claimedAt) + ABANDONED_SLOT_MS > Date.parse(now)) return true;
	return null;
}

const LIVE_POOL = "live";
function networkPool(networkKey: string): string {
	return `net:${JSON.stringify(networkKey)}`;
}

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
		return (await this.put(id, expected, value)) !== null;
	}

	/** {@link cas}, answering the new version (0 for a delete), or null if it lost. */
	async put(id: string, expected: number | null, value: T | null): Promise<number | null> {
		await interleave();
		const doc = this.#docs.get(id);
		if ((doc?.version ?? null) !== expected) return null;
		if (value === null) {
			this.#docs.delete(id);
			return 0;
		}
		const version = this.#next++;
		this.#docs.set(id, { value: structuredClone(value), version });
		return version;
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
	#sessions = new CasDocs<SessionDoc>();
	#records = new CasDocs<AgentCreateIdempotencyRecord>();
	#slots = new CasDocs<SlotDoc>();

	async get(id: AgentSessionId): Promise<AgentCheckoutSession | null> {
		const doc = await this.#sessions.get(id);
		return doc !== null && doc.value.admitted ? doc.value.session : null;
	}

	/** Every admitted session (a scan the port answers loosely). */
	async #allSessions(): Promise<AgentCheckoutSession[]> {
		return (await this.#sessions.all()).flatMap(([, d]) => (d.admitted ? [d.session] : []));
	}

	/**
	 * Test hook: an insert that stops, as a crash would, right after the session
	 * document is written and before its slots are marked landed.
	 */
	async insertCrashingBeforeLanding(
		session: AgentCheckoutSession,
		capacity: AgentSessionCapacity,
	): Promise<void> {
		await this.#insert(session, capacity, "before_landing");
	}

	/** Test hook: an insert that stops after taking its slots, before the session
	 *  document is written (its slots are left unlanded, then abandoned). */
	async insertCrashingBeforeSessionWrite(
		session: AgentCheckoutSession,
		capacity: AgentSessionCapacity,
	): Promise<void> {
		await this.#insert(session, capacity, "before_write");
	}

	async insert(
		session: AgentCheckoutSession,
		capacity: AgentSessionCapacity,
	): Promise<Result<"insert">> {
		return this.#insert(session, capacity, null);
	}

	async #insert(
		session: AgentCheckoutSession,
		capacity: AgentSessionCapacity,
		crash: "before_write" | "before_landing" | null,
	): Promise<Result<"insert">> {
		const stored: AgentCheckoutSession = structuredClone({ ...session, revision: 1 });
		for (;;) {
			const current = await this.#sessions.get(session.id);
			if (current !== null) {
				// A pending document (an insert in flight, or one that crashed before
				// landing) is finished here, or dropped if it lost a slot; then retry.
				if (current.value.admitted || (await this.#complete(session.id))) {
					const now = await this.get(session.id);
					if (now !== null) return { ok: false, reason: "exists", current: now };
				}
				continue;
			}
			if (agentSessionDocumentBytes(stored) > AGENT_SESSION_MAX_DOCUMENT_BYTES) {
				return { ok: false, reason: "too_large" };
			}
			const net = await this.#takeSlot(
				networkPool(session.networkKey),
				capacity.maxLivePerNetwork,
				stored,
				capacity.now,
			);
			if (net === null) return { ok: false, reason: "capacity" };
			const live = await this.#takeSlot(LIVE_POOL, capacity.maxLive, stored, capacity.now);
			if (live === null) {
				await this.#slots.cas(net.id, net.version, null);
				return { ok: false, reason: "capacity" };
			}
			if (crash === "before_write") return { ok: true, session: structuredClone(stored) };
			const written = await this.#sessions.cas(session.id, null, {
				session: stored,
				slots: [net.id, live.id],
				admitted: false,
			});
			if (!written) {
				await this.#slots.cas(live.id, live.version, null);
				await this.#slots.cas(net.id, net.version, null);
				continue;
			}
			if (crash === "before_landing") return { ok: true, session: structuredClone(stored) };
			// Land both slots, then admit. Losing a slot is only possible if it was
			// taken as abandoned before the document above existed (a stall past
			// 60 s); the pending document was never visible, so dropping it is safe.
			if (await this.#complete(session.id)) {
				return { ok: true, session: structuredClone(stored) };
			}
			return { ok: false, reason: "capacity" };
		}
	}

	/**
	 * Finish a pending session document: mark each of its slots landed (while it
	 * is still that session's), then admit it. If a slot was lost, delete the
	 * pending document by version and free what it still holds. Idempotent and
	 * safe to race (insert, replay, adoption and sweep all call it). Answers
	 * whether the session is admitted.
	 */
	async #complete(sessionId: AgentSessionId): Promise<boolean> {
		for (;;) {
			const doc = await this.#sessions.get(sessionId);
			if (doc === null) return false;
			if (doc.value.admitted) return true;
			let lost = false;
			for (const id of doc.value.slots) {
				if (!(await this.#landSlot(id, sessionId))) lost = true;
			}
			if (lost) {
				if (await this.#sessions.cas(sessionId, doc.version, null)) {
					await this.#freeSlots(sessionId, doc.value.slots);
					return false;
				}
				continue;
			}
			if (await this.#sessions.cas(sessionId, doc.version, { ...doc.value, admitted: true })) {
				return true;
			}
		}
	}

	/** Mark slot `id` landed if it is still `sessionId`'s; false if it is not. */
	async #landSlot(id: string, sessionId: AgentSessionId): Promise<boolean> {
		for (;;) {
			const slot = await this.#slots.get(id);
			if (slot === null || slot.value.sessionId !== sessionId) return false;
			if (slot.value.landed) return true;
			if (await this.#slots.cas(id, slot.version, { ...slot.value, landed: true })) return true;
		}
	}

	/** Whether `slot` holds capacity at `now`; reads the session only for an
	 *  unlanded slot past the abandon time. */
	async #slotHeld(slot: SlotDoc, now: string): Promise<boolean> {
		const known = slotHeldWithoutRead(slot, now);
		if (known !== null) return known;
		return (await this.#sessions.get(slot.sessionId)) !== null;
	}

	/** Compare-and-set the first free slot of pool `pool` (size `size`), or null if none. */
	async #takeSlot(
		pool: string,
		size: number,
		session: AgentCheckoutSession,
		now: string,
	): Promise<{ id: string; version: number; value: SlotDoc } | null> {
		const start = hashOf(session.id) % Math.max(size, 1);
		for (let i = 0; i < size; i++) {
			const id = `${pool}:${(start + i) % size}`;
			const slot = await this.#slots.get(id);
			if (slot !== null && (await this.#slotHeld(slot.value, now))) continue;
			const value: SlotDoc = {
				sessionId: session.id,
				expiresAt: session.expiresAt,
				claimedAt: now,
				landed: false,
			};
			const version = await this.#slots.put(id, slot?.version ?? null, value);
			if (version !== null) return { id, version, value };
		}
		return null;
	}

	/** Delete, by version, each of `ids` still held for `sessionId`. */
	async #freeSlots(sessionId: AgentSessionId, ids: readonly string[]): Promise<void> {
		for (const id of ids) {
			const slot = await this.#slots.get(id);
			if (slot !== null && slot.value.sessionId === sessionId) {
				await this.#slots.cas(id, slot.version, null);
			}
		}
	}

	async #freeSlotsOf(sessionId: AgentSessionId): Promise<void> {
		const doc = await this.#sessions.get(sessionId);
		if (doc !== null) await this.#freeSlots(sessionId, doc.value.slots);
	}

	/** Whether any slot still holds capacity for `sessionId` at `now`. */
	async #holdsLiveSlot(sessionId: AgentSessionId, now: string): Promise<boolean> {
		for (const [, slot] of await this.#slots.all()) {
			if (slot.sessionId === sessionId && (await this.#slotHeld(slot, now))) return true;
		}
		return false;
	}

	async write(session: AgentCheckoutSession, expectedRevision: number): Promise<Result<"write">> {
		const written = await this.#update<Result<"write">>(
			session.id,
			(current) => {
				if (current === null || current.revision !== expectedRevision) {
					return { refuse: { ok: false, reason: "conflict", current } };
				}
				return { next: { ...session, revision: expectedRevision + 1 } };
			},
			(next) => ({ ok: true, session: next }),
		);
		if (written.ok && written.session.status === "completed") {
			// An order: the session's slots free at once, and its create records
			// follow it to its (longer) retention.
			await this.#freeSlotsOf(session.id);
			await this.#retainRecords(session.id, written.session.purgeAt);
		}
		return written;
	}

	async findByHandoffTokenHash(tokenHash: string): Promise<AgentCheckoutSession | null> {
		for (const s of await this.#allSessions()) {
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
		for (const s of await this.#allSessions()) {
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
		adopt: { sessionId: AgentSessionId; attemptId: string; purgeAt: string; now: string },
	): Promise<"adopted" | "lost" | "busy"> {
		const id = idempotencyId(networkKey, key);
		for (;;) {
			const r = await this.#records.get(id);
			if (r === null || r.value.sessionId !== adopt.sessionId) return "lost";
			// Its session was written but never admitted (an insert crashed before
			// landing): finish it, and let the caller retry into a replay.
			const pending = await this.#sessions.get(adopt.sessionId);
			if (pending !== null && !pending.value.admitted) {
				await this.#complete(adopt.sessionId);
				return "busy";
			}
			if (await this.#holdsLiveSlot(adopt.sessionId, adopt.now)) return "busy";
			const purgeAt = r.value.purgeAt > adopt.purgeAt ? r.value.purgeAt : adopt.purgeAt;
			const next = { ...r.value, attemptId: adopt.attemptId, purgeAt };
			if (await this.#records.cas(id, r.version, next)) return "adopted";
		}
	}

	async releaseIdempotency(
		networkKey: string,
		key: string,
		attemptId: string,
		now: string,
	): Promise<"released" | "not_owner" | "busy"> {
		const id = idempotencyId(networkKey, key);
		for (;;) {
			const r = await this.#records.get(id);
			if (r === null || r.value.attemptId !== attemptId) return "not_owner";
			if (await this.#holdsLiveSlot(r.value.sessionId, now)) return "busy";
			if (await this.#records.cas(id, r.version, null)) return "released";
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
		const finalized = await this.#update<Result<"finalizeHandoff">>(
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
		if (finalized.ok) {
			// Also on a replay, so a crash right after the session write is repaired.
			await this.#retainRecords(id, finalize.retainUntil);
		}
		return finalized;
	}

	/** Move every create record of `sessionId` out to `purgeAt` (never earlier). */
	async #retainRecords(sessionId: AgentSessionId, purgeAt: string): Promise<void> {
		for (const [recordId, value] of await this.#records.all()) {
			if (value.sessionId !== sessionId) continue;
			for (;;) {
				const r = await this.#records.get(recordId);
				if (r === null || r.value.sessionId !== sessionId || r.value.purgeAt >= purgeAt) break;
				if (await this.#records.cas(recordId, r.version, { ...r.value, purgeAt })) break;
			}
		}
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
		for (const s of await this.#allSessions()) {
			if (isAgentSessionOpen(s.status) && s.expiresAt > now) n++;
		}
		return n;
	}

	async occupiedSlots(
		networkKey: string,
		now: string,
	): Promise<{ store: number; network: number }> {
		const prefix = `${networkPool(networkKey)}:`;
		let store = 0;
		let network = 0;
		for (const [id, slot] of await this.#slots.all()) {
			if (!(await this.#slotHeld(slot, now))) continue;
			if (id.startsWith(`${LIVE_POOL}:`)) store++;
			else if (id.startsWith(prefix)) network++;
		}
		return { store, network };
	}

	async countSlotDocs(): Promise<number> {
		return (await this.#slots.all()).length;
	}

	async purgeSlotsDue(now: string, limit: number): Promise<number> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError("purgeSlotsDue limit must be a positive integer");
		}
		let deleted = 0;
		for (const [id] of await this.#slots.all()) {
			if (deleted >= limit) break;
			const slot = await this.#slots.get(id);
			if (slot === null) continue;
			// An unlanded slot whose session document is stored (an insert that
			// crashed before landing): finish that session instead.
			if (!slot.value.landed && (await this.#sessions.get(slot.value.sessionId)) !== null) {
				await this.#complete(slot.value.sessionId);
				continue;
			}
			if (
				!(await this.#slotHeld(slot.value, now)) &&
				(await this.#slots.cas(id, slot.version, null))
			) {
				deleted++;
			}
		}
		return deleted;
	}

	async countCreatedSince(networkKey: string, since: string): Promise<number> {
		let n = 0;
		for (const s of await this.#allSessions()) {
			if (s.networkKey === networkKey && s.createdAt >= since) n++;
		}
		return n;
	}

	async listPurgeDue(now: string, limit: number): Promise<AgentSessionId[]> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError("listPurgeDue limit must be a positive integer");
		}
		const due: AgentSessionId[] = [];
		for (const s of await this.#allSessions()) {
			if (due.length >= limit) break;
			if (s.purgeAt <= now) due.push(s.id);
		}
		return due;
	}

	async purge(id: AgentSessionId, now: string): Promise<boolean> {
		const s = await this.#sessions.get(id);
		if (s === null || !s.value.admitted || s.value.session.purgeAt > now) return false;
		// Create records and slots first, the session last: a purge cut short stays due.
		for (const [recordId, r] of await this.#records.all()) {
			if (r.sessionId !== id) continue;
			const current = await this.#records.get(recordId);
			if (current !== null && current.value.sessionId === id) {
				await this.#records.cas(recordId, current.version, null);
			}
		}
		await this.#freeSlots(id, s.value.slots);
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
			const read = await this.#sessions.get(id);
			// A pending (not yet admitted) document is no session to its readers.
			const current = read !== null && read.value.admitted ? read : null;
			const step: Step<R | { ok: false; reason: "too_large" }> = await (async () => {
				const decided = decide(current?.value.session ?? null);
				if ("refuse" in decided) return done(decided.refuse);
				if (agentSessionDocumentBytes(decided.next) > AGENT_SESSION_MAX_DOCUMENT_BYTES) {
					return done({ ok: false as const, reason: "too_large" as const });
				}
				const stored = structuredClone(decided.next);
				const doc: SessionDoc = {
					session: stored,
					slots: current?.value.slots ?? [],
					admitted: true,
				};
				return (await this.#sessions.cas(id, current?.version ?? null, doc))
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
