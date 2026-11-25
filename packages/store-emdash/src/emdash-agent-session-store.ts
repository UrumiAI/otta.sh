/**
 * `AgentSessionStore` over the plugin's document store (ADR-0047, ADR-0019).
 *
 * PER-DOCUMENT COMPARE-AND-SET ONLY: EmDash storage has no transactions, so
 * every guarantee below is built from a versioned read, a compare-and-set
 * (insert-if-absent at `null`) and a compare-and-delete on ONE document. The
 * design is the port's reference design (the domain's in-memory fake), document
 * for document:
 *
 *  - **Live caps are slot documents.** A cap of N in a pool is N slot documents;
 *    an insert compare-and-sets a free one in its network's pool, then one in
 *    the store-wide pool, writes the session HIDDEN (`admission: "hidden"`,
 *    which every read filters out), marks both slots `landed`, and only then
 *    admits the session. However many inserts race, a slot is won by exactly one
 *    compare-and-set, so neither cap is ever overshot.
 *  - **A slot is free** when absent, expired, or ABANDONED: never landed, taken
 *    more than 60 s ago, and its session document absent. A landed slot is
 *    never retaken before its expiry. A slot whose session document exists is
 *    never abandoned either, however long its insert stalled or if it crashed:
 *    a replay of the insert, an adoption of its create record, or
 *    `purgeSlotsDue` lands it. A probe that retakes an unlanded slot deletes the
 *    hidden document that slot named (by version, only while still hidden).
 *  - **Every session write** is a compare-and-set on the host revision, guarded
 *    on the domain `revision` the caller expected (or, for the hand-off claim,
 *    finalize and release, on their own guards re-checked on the document they
 *    replace). A hidden document is never written: it reads as absent.
 *  - **Deletes are by version** (`compareAndDelete`), so a slot or record that
 *    moved since it was read is never deleted by mistake.
 *
 * Token-hash pointers are written BEFORE the session they point at: a session is
 * never stored with a link the lookup cannot find, and a pointer whose session
 * write lost is ignored by the lookup (it re-checks the session).
 *
 * Purge order is pointers, create records and slots first, the session last, so
 * a purge cut short leaves the session due and listed for the next run.
 */

import {
	AGENT_HANDOFF_FINALIZE_GRACE_MS,
	AGENT_SESSION_MAX_DOCUMENT_BYTES,
	agentSessionDocumentBytes,
	isAgentHandoffClaimLive,
	type AgentCheckoutSession,
	type AgentCreateIdempotencyRecord,
	type AgentSessionCapacity,
	type AgentSessionId,
	type AgentSessionStore,
} from "@urumi.ai/otta-domain";
import {
	AGENT_SESSION_CREATE_KEYS_COLLECTION,
	AGENT_SESSION_LINKS_COLLECTION,
	AGENT_SESSION_LIVE_POOL,
	AGENT_SESSION_SLOTS_COLLECTION,
	AGENT_SESSIONS_COLLECTION,
	agentSessionCreateKeyId,
	agentSessionNetworkPool,
	agentSessionSlotId,
	agentSessionTokenHashes,
	normalizeAgentSessionDoc,
	toAgentSessionDoc,
	type AgentSessionCreateKeyDoc,
	type AgentSessionDoc,
	type AgentSessionLinkDoc,
	type AgentSessionSlotDoc,
} from "./agent-session-documents.js";
import {
	CAS_RETRY,
	casDone,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import type { StorageAccess, StorageCollection, Versioned, WhereClause } from "./storage-access.js";

/** The page size every walk below reads in (the host's ceiling). */
const PAGE_SIZE = 100;
/** A walk over one session's pointers, records or slots never reads more pages
 *  than this (a session holds a handful of each). */
const MAX_SESSION_PAGES = 20;
/** A pool walk reads at most this many pages (a pool of 500 slots is 5). */
const MAX_POOL_PAGES = 200;

/** A slot whose session was never written is free this long after it was taken. */
export const AGENT_SESSION_ABANDONED_SLOT_MS = 60 * 1000;

const OPEN_STATUSES = ["incomplete", "requires_escalation"];
const ADMITTED = "admitted";

export interface EmdashAgentSessionStoreOptions {
	storage: StorageAccess;
	maxCasAttempts?: number;
	onCasAttempts?: (operation: string, attempts: number) => void;
	sleep?: CasRetryOptions["sleep"];
	random?: CasRetryOptions["random"];
}

type Result<M extends keyof AgentSessionStore> = Awaited<ReturnType<AgentSessionStore[M]>>;
type TooLarge = { ok: false; reason: "too_large" };

/** Whether `slot` holds capacity at `now` without reading its session, or null
 *  when that depends on whether its session document exists. */
function slotHeldWithoutRead(slot: AgentSessionSlotDoc, now: string): boolean | null {
	if (slot.expiresAt <= now) return false;
	if (
		slot.state === "landed" ||
		Date.parse(slot.claimedAt) + AGENT_SESSION_ABANDONED_SLOT_MS > Date.parse(now)
	) {
		return true;
	}
	return null;
}

function requirePositiveLimit(name: string, limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError(`${name} limit must be a positive integer`);
	}
}

export class EmdashAgentSessionStore implements AgentSessionStore {
	readonly #sessions: StorageCollection<AgentSessionDoc>;
	readonly #links: StorageCollection<AgentSessionLinkDoc>;
	readonly #createKeys: StorageCollection<AgentSessionCreateKeyDoc>;
	readonly #slots: StorageCollection<AgentSessionSlotDoc>;
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
		this.#slots = collectionOf<AgentSessionSlotDoc>(
			options.storage,
			AGENT_SESSION_SLOTS_COLLECTION,
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
		return doc === null || doc.admission !== ADMITTED ? null : normalizeAgentSessionDoc(doc);
	}

	// ---------------------------------------------------------------- insert

	insert(session: AgentCheckoutSession, capacity: AgentSessionCapacity): Promise<Result<"insert">> {
		return this.#insert(session, capacity);
	}

	async #insert(
		session: AgentCheckoutSession,
		capacity: AgentSessionCapacity,
	): Promise<Result<"insert">> {
		const stored: AgentCheckoutSession = { ...session, revision: 1 };
		const netPool = agentSessionNetworkPool(session.networkKey);
		return this.#cas<Result<"insert">>("insertAgentSession", async () => {
			const current = await this.#sessions.getVersioned(session.id);
			if (current !== null) {
				// A pending document (an insert in flight, or one that stopped before
				// landing) is finished here, or dropped if it lost a slot; then retry.
				if (current.value.admission === ADMITTED || (await this.#complete(session.id))) {
					const now = await this.get(session.id);
					if (now !== null) return casDone({ ok: false, reason: "exists", current: now });
				}
				return CAS_RETRY;
			}
			if (agentSessionDocumentBytes(stored) > AGENT_SESSION_MAX_DOCUMENT_BYTES) {
				return casDone({ ok: false, reason: "too_large" });
			}
			const net = await this.#takeSlot(netPool, capacity.maxLivePerNetwork, stored, capacity.now);
			if (net === null) return casDone({ ok: false, reason: "capacity" });
			const live = await this.#takeSlot(
				AGENT_SESSION_LIVE_POOL,
				capacity.maxLive,
				stored,
				capacity.now,
			);
			if (live === null) {
				await this.#slots.compareAndDelete(net.id, net.revision);
				return casDone({ ok: false, reason: "capacity" });
			}
			await this.#pointLinks(stored);
			const written = await this.#sessions.compareAndSet(
				session.id,
				null,
				toAgentSessionDoc(stored, "hidden", [net.id, live.id]),
			);
			if (!written.applied) {
				await this.#slots.compareAndDelete(live.id, live.revision);
				await this.#slots.compareAndDelete(net.id, net.revision);
				return CAS_RETRY;
			}
			// Land both slots, then admit. Losing a slot is only possible if it was
			// taken as abandoned before the document above existed (a stall past
			// 60 s); the hidden document was never visible, so dropping it is safe.
			return casDone(
				(await this.#complete(session.id))
					? { ok: true, session: normalizeAgentSessionDoc(toAgentSessionDoc(stored, ADMITTED, [])) }
					: { ok: false, reason: "capacity" },
			);
		});
	}

	/**
	 * Finish a hidden session document: mark each of its slots landed (while it
	 * is still that session's), then admit it. If a slot was lost, delete the
	 * hidden document by version and free what it still holds. Idempotent and
	 * safe to race (insert, replay, adoption and the sweep all call it). Answers
	 * whether the session is admitted.
	 */
	#complete(sessionId: AgentSessionId): Promise<boolean> {
		return this.#cas<boolean>("completeAgentSessionInsert", async () => {
			const doc = await this.#sessions.getVersioned(sessionId);
			if (doc === null) return casDone(false);
			if (doc.value.admission === ADMITTED) return casDone(true);
			let lost = false;
			for (const slotId of doc.value.slots) {
				if (!(await this.#landSlot(slotId, sessionId))) lost = true;
			}
			if (lost) {
				const dropped = await this.#sessions.compareAndDelete(sessionId, doc.revision);
				if (!dropped.applied) return CAS_RETRY;
				await this.#freeSlots(sessionId, doc.value.slots);
				return casDone(false);
			}
			const admitted = await this.#sessions.compareAndSet(sessionId, doc.revision, {
				...doc.value,
				admission: ADMITTED,
			});
			return admitted.applied ? casDone(true) : CAS_RETRY;
		});
	}

	/** Delete `sessionId`'s document by version if it is still hidden, and free
	 *  any slot it still holds. */
	async #dropHidden(sessionId: AgentSessionId): Promise<void> {
		const doc = await this.#sessions.getVersioned(sessionId);
		if (doc === null || doc.value.admission === ADMITTED) return;
		const dropped = await this.#sessions.compareAndDelete(sessionId, doc.revision);
		if (dropped.applied) await this.#freeSlots(sessionId, doc.value.slots);
	}

	/** Mark slot `slotId` landed if it is still `sessionId`'s; false if it is not. */
	#landSlot(slotId: string, sessionId: AgentSessionId): Promise<boolean> {
		return this.#cas<boolean>("landAgentSessionSlot", async () => {
			const slot = await this.#slots.getVersioned(slotId);
			if (slot === null || slot.value.sessionId !== sessionId) return casDone(false);
			if (slot.value.state === "landed") return casDone(true);
			const landed = await this.#slots.compareAndSet(slotId, slot.revision, {
				...slot.value,
				state: "landed",
			});
			return landed.applied ? casDone(true) : CAS_RETRY;
		});
	}

	/** Whether `slot` holds capacity at `now`; reads the session only for an
	 *  unlanded slot past the abandon time. */
	async #slotHeld(slot: AgentSessionSlotDoc, now: string): Promise<boolean> {
		const known = slotHeldWithoutRead(slot, now);
		if (known !== null) return known;
		return (await this.#sessions.get(slot.sessionId)) !== null;
	}

	/** Compare-and-set the first free slot of `pool` (size `size`), or null if none. */
	async #takeSlot(
		pool: string,
		size: number,
		session: AgentCheckoutSession,
		now: string,
	): Promise<{ id: string; revision: string } | null> {
		const start = hashOf(session.id) % Math.max(size, 1);
		for (let i = 0; i < size; i++) {
			const id = agentSessionSlotId(pool, (start + i) % size);
			const slot = await this.#slots.getVersioned(id);
			if (slot !== null && (await this.#slotHeld(slot.value, now))) continue;
			const taken = await this.#slots.compareAndSet(id, slot?.revision ?? null, {
				pool,
				sessionId: session.id,
				expiresAt: session.expiresAt,
				claimedAt: now,
				state: "taken",
			});
			if (!taken.applied) continue;
			// Retook an unlanded slot: a session document it still names is stranded
			// (its insert stopped before landing and can never land now), so delete it.
			if (slot !== null && slot.value.state !== "landed") {
				await this.#dropHidden(slot.value.sessionId);
			}
			return { id, revision: taken.revision };
		}
		return null;
	}

	/** Delete, by version, each of `ids` still held for `sessionId`. */
	async #freeSlots(sessionId: AgentSessionId, ids: readonly string[]): Promise<void> {
		for (const id of ids) {
			const slot = await this.#slots.getVersioned(id);
			if (slot !== null && slot.value.sessionId === sessionId) {
				await this.#slots.compareAndDelete(id, slot.revision);
			}
		}
	}

	/** Every slot document naming `sessionId` (a session takes two). */
	async #slotIdsOf(sessionId: AgentSessionId): Promise<string[]> {
		const ids: string[] = [];
		await this.#walk(this.#slots, { sessionId }, MAX_SESSION_PAGES, (id) => {
			ids.push(id);
		});
		return ids;
	}

	/** Whether any slot still holds capacity for `sessionId` at `now`. */
	async #holdsLiveSlot(sessionId: AgentSessionId, now: string): Promise<boolean> {
		for (const id of await this.#slotIdsOf(sessionId)) {
			const slot = await this.#slots.get(id);
			if (slot !== null && slot.sessionId === sessionId && (await this.#slotHeld(slot, now))) {
				return true;
			}
		}
		return false;
	}

	// ---------------------------------------------------------------- writes

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
			await this.#freeSlots(session.id, await this.#slotIdsOf(session.id));
			await this.#retainRecords(session.id, written.session.purgeAt);
		}
		return written;
	}

	async findByHandoffTokenHash(tokenHash: string): Promise<AgentCheckoutSession | null> {
		const link = await this.#links.get(tokenHash);
		if (link === null) return null;
		const session = await this.get(link.sessionId as AgentSessionId);
		if (session === null) return null;
		return agentSessionTokenHashes(session).includes(tokenHash) ? session : null;
	}

	async findByCartId(cartId: string): Promise<AgentCheckoutSession | null> {
		let found: AgentCheckoutSession | null = null;
		for (const field of ["cartId", "shopperCartId"] as const) {
			const result = await this.#sessions.query({
				where: { admission: ADMITTED, [field]: cartId },
				orderBy: { createdAt: "desc" },
				limit: 1,
			});
			const first = result.items[0];
			if (first === undefined) continue;
			const session = normalizeAgentSessionDoc(first.data);
			if (found === null || session.createdAt > found.createdAt) found = session;
		}
		return found;
	}

	async getIdempotency(
		networkKey: string,
		key: string,
	): Promise<AgentCreateIdempotencyRecord | null> {
		const doc = await this.#createKeys.get(agentSessionCreateKeyId(networkKey, key));
		return doc === null ? null : { ...doc };
	}

	async putIdempotency(record: AgentCreateIdempotencyRecord): Promise<Result<"putIdempotency">> {
		const id = agentSessionCreateKeyId(record.networkKey, record.key);
		return this.#cas<Result<"putIdempotency">>("putAgentSessionCreateKey", async () => {
			const written = await this.#createKeys.compareAndSet(id, null, { ...record });
			if (written.applied) return casDone<Result<"putIdempotency">>({ stored: true });
			const existing = await this.#createKeys.get(id);
			// Deleted between the refused insert and this read (a release or purge): try again.
			return existing === null ? CAS_RETRY : casDone({ stored: false, existing: { ...existing } });
		});
	}

	async adoptIdempotency(
		networkKey: string,
		key: string,
		adopt: { sessionId: AgentSessionId; attemptId: string; purgeAt: string; now: string },
	): Promise<"adopted" | "lost" | "busy"> {
		const id = agentSessionCreateKeyId(networkKey, key);
		return this.#cas<"adopted" | "lost" | "busy">("adoptAgentSessionCreateKey", async () => {
			const r = await this.#createKeys.getVersioned(id);
			if (r === null || r.value.sessionId !== adopt.sessionId) return casDone("lost");
			// Its session was written but never admitted (an insert stopped before
			// landing): finish it, and let the caller retry into a replay.
			const pending = await this.#sessions.get(adopt.sessionId);
			if (pending !== null && pending.admission !== ADMITTED) {
				await this.#complete(adopt.sessionId);
				return casDone("busy");
			}
			if (await this.#holdsLiveSlot(adopt.sessionId, adopt.now)) return casDone("busy");
			const purgeAt = r.value.purgeAt > adopt.purgeAt ? r.value.purgeAt : adopt.purgeAt;
			const written = await this.#createKeys.compareAndSet(id, r.revision, {
				...r.value,
				attemptId: adopt.attemptId,
				purgeAt,
			});
			return written.applied ? casDone("adopted") : CAS_RETRY;
		});
	}

	async releaseIdempotency(
		networkKey: string,
		key: string,
		attemptId: string,
		now: string,
	): Promise<"released" | "not_owner" | "busy"> {
		const id = agentSessionCreateKeyId(networkKey, key);
		return this.#cas<"released" | "not_owner" | "busy">(
			"releaseAgentSessionCreateKey",
			async () => {
				const r = await this.#createKeys.getVersioned(id);
				if (r === null || r.value.attemptId !== attemptId) return casDone("not_owner");
				if (await this.#holdsLiveSlot(r.value.sessionId, now)) return casDone("busy");
				const deleted = await this.#createKeys.compareAndDelete(id, r.revision);
				return deleted.applied ? casDone("released") : CAS_RETRY;
			},
		);
	}

	// ---------------------------------------------------------------- hand-off

	claimHandoff(
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
		// Also on a replay, so a crash right after the session write is repaired.
		if (finalized.ok) await this.#retainRecords(id, finalize.retainUntil);
		return finalized;
	}

	async releaseHandoffClaim(id: AgentSessionId, claimId: string): Promise<boolean> {
		const released = await this.#update<boolean>(
			id,
			(s) => {
				if (s === null || s.handoffUsedAt !== undefined || s.handoffClaim?.claimId !== claimId) {
					return { refuse: false };
				}
				const { handoffClaim: _released, ...rest } = s;
				return { next: { ...rest, revision: s.revision + 1 } };
			},
			() => true,
		);
		return released === true;
	}

	/** Move every create record of `sessionId` out to `purgeAt` (never earlier). */
	async #retainRecords(sessionId: AgentSessionId, purgeAt: string): Promise<void> {
		const ids: string[] = [];
		await this.#walk(this.#createKeys, { sessionId }, MAX_SESSION_PAGES, (id) => {
			ids.push(id);
		});
		for (const recordId of ids) {
			await this.#cas<undefined>("retainAgentSessionCreateKey", async () => {
				const r = await this.#createKeys.getVersioned(recordId);
				if (r === null || r.value.sessionId !== sessionId || r.value.purgeAt >= purgeAt) {
					return casDone(undefined);
				}
				const written = await this.#createKeys.compareAndSet(recordId, r.revision, {
					...r.value,
					purgeAt,
				});
				return written.applied ? casDone(undefined) : CAS_RETRY;
			});
		}
	}

	// ---------------------------------------------------------------- counts

	countLive(now: string): Promise<number> {
		return this.#sessions.count({
			admission: ADMITTED,
			status: { in: OPEN_STATUSES },
			expiresAt: { gt: now },
		});
	}

	async occupiedSlots(
		networkKey: string,
		now: string,
	): Promise<{ store: number; network: number }> {
		const store = await this.#heldIn(AGENT_SESSION_LIVE_POOL, now);
		const network = await this.#heldIn(agentSessionNetworkPool(networkKey), now);
		return { store, network };
	}

	async #heldIn(pool: string, now: string): Promise<number> {
		const slots: AgentSessionSlotDoc[] = [];
		await this.#walk(this.#slots, { pool }, MAX_POOL_PAGES, (_id, data) => {
			slots.push(data);
		});
		let held = 0;
		for (const slot of slots) if (await this.#slotHeld(slot, now)) held++;
		return held;
	}

	countSlotDocs(): Promise<number> {
		return this.#slots.count();
	}

	async purgeSlotsDue(now: string, limit: number): Promise<number> {
		requirePositiveLimit("purgeSlotsDue", limit);
		const page = Math.min(limit, PAGE_SIZE);
		const candidates = new Set<string>();
		// Expired slots, and every unlanded one: an abandoned one is deleted, one
		// whose session document is stored (its insert stopped before landing, or
		// is landing right now) is landed instead.
		const wheres: WhereClause[] = [{ expiresAt: { lte: now } }, { state: "taken" }];
		for (const where of wheres) {
			const result = await this.#slots.query({ where, orderBy: { claimedAt: "asc" }, limit: page });
			for (const { id } of result.items) candidates.add(id);
		}
		let deleted = 0;
		for (const id of candidates) {
			if (deleted >= limit) break;
			const slot = await this.#slots.getVersioned(id);
			if (slot === null) continue;
			// An unlanded slot whose session document is stored (an insert that
			// stopped before landing): finish that session instead.
			if (
				slot.value.state !== "landed" &&
				(await this.#sessions.get(slot.value.sessionId)) !== null
			) {
				await this.#complete(slot.value.sessionId);
				continue;
			}
			if (await this.#slotHeld(slot.value, now)) continue;
			if ((await this.#slots.compareAndDelete(id, slot.revision)).applied) deleted++;
		}
		return deleted;
	}

	countCreatedSince(networkKey: string, since: string): Promise<number> {
		return this.#sessions.count({ admission: ADMITTED, networkKey, createdAt: { gte: since } });
	}

	// ---------------------------------------------------------------- retention

	async listPurgeDue(now: string, limit: number): Promise<AgentSessionId[]> {
		requirePositiveLimit("listPurgeDue", limit);
		// Hidden documents too: one stranded by an insert that stopped before
		// landing is purged like any other session once its purgeAt passes.
		const result = await this.#sessions.query({
			where: { purgeAt: { lte: now } },
			orderBy: { purgeAt: "asc" },
			limit: Math.min(limit, PAGE_SIZE),
		});
		return result.items.map((item) => item.data.id);
	}

	async purge(id: AgentSessionId, now: string): Promise<boolean> {
		const doc = await this.#sessions.getVersioned(id);
		if (doc === null || doc.value.purgeAt > now) return false;
		await this.#deleteOwned(this.#links, id);
		await this.#deleteOwned(this.#createKeys, id);
		const slotIds = new Set([...(doc.value.slots ?? []), ...(await this.#slotIdsOf(id))]);
		await this.#freeSlots(id, [...slotIds]);
		return (await this.#sessions.compareAndDelete(id, doc.revision)).applied;
	}

	async purgeIdempotencyDue(now: string, limit: number): Promise<number> {
		requirePositiveLimit("purgeIdempotencyDue", limit);
		const due = await this.#createKeys.query({
			where: { purgeAt: { lte: now } },
			orderBy: { purgeAt: "asc" },
			limit: Math.min(limit, PAGE_SIZE),
		});
		let deleted = 0;
		for (const { id } of due.items) {
			// By version, and only while still due: a hand-off or an order may have
			// moved it out since the query.
			const r = await this.#createKeys.getVersioned(id);
			if (r === null || r.value.purgeAt > now) continue;
			if ((await this.#createKeys.compareAndDelete(id, r.revision)).applied) deleted++;
		}
		// Orphan pointers (a session write that never landed) ride the same bound;
		// they are not create records, so they are not counted.
		const links = await this.#links.query({
			where: { purgeAt: { lte: now } },
			orderBy: { purgeAt: "asc" },
			limit: Math.min(limit, PAGE_SIZE),
		});
		for (const { id } of links.items) await this.#links.delete(id);
		return deleted;
	}

	// ---------------------------------------------------------------- helpers

	/**
	 * Read-decide-compare-and-set on one ADMITTED session, retried while a racer
	 * wins in between. An absent or hidden document reads as null and the
	 * decision must refuse: nothing is ever written against either. The next
	 * document must fit the byte cap; its pointers are written first.
	 */
	async #update<R>(
		id: AgentSessionId,
		decide: (
			current: AgentCheckoutSession | null,
		) => { refuse: R } | { next: AgentCheckoutSession },
		won: (stored: AgentCheckoutSession) => R,
	): Promise<R | TooLarge> {
		return this.#cas<R | TooLarge>("updateAgentSession", async () => {
			const current: Versioned<AgentSessionDoc> | null = await this.#sessions.getVersioned(id);
			if (current === null || current.value.admission !== ADMITTED) {
				const decided = decide(null);
				if ("refuse" in decided) return casDone(decided.refuse);
				throw new Error("an agent-session update never creates a session");
			}
			const decided = decide(normalizeAgentSessionDoc(current.value));
			if ("refuse" in decided) return casDone(decided.refuse);
			if (agentSessionDocumentBytes(decided.next) > AGENT_SESSION_MAX_DOCUMENT_BYTES) {
				return casDone<TooLarge>({ ok: false, reason: "too_large" });
			}
			const doc = toAgentSessionDoc(decided.next, ADMITTED, current.value.slots ?? []);
			await this.#pointLinks(decided.next);
			const written = await this.#sessions.compareAndSet(id, current.revision, doc);
			return written.applied ? casDone(won(normalizeAgentSessionDoc(doc))) : CAS_RETRY;
		});
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

	/** Delete, by version, every document of `collection` still naming `sessionId`. */
	async #deleteOwned<T extends { sessionId: string }>(
		collection: StorageCollection<T>,
		sessionId: AgentSessionId,
	): Promise<void> {
		const ids: string[] = [];
		await this.#walk(collection, { sessionId }, MAX_SESSION_PAGES, (id) => {
			ids.push(id);
		});
		for (const id of ids) {
			const current = await collection.getVersioned(id);
			if (current !== null && current.value.sessionId === sessionId) {
				await collection.compareAndDelete(id, current.revision);
			}
		}
	}

	/** Visit every document matching `where`, page by page, at most `maxPages`. */
	async #walk<T>(
		collection: StorageCollection<T>,
		where: WhereClause,
		maxPages: number,
		visit: (id: string, data: T) => void,
	): Promise<void> {
		let cursor: string | undefined;
		for (let page = 0; page < maxPages; page++) {
			const result = await collection.query({
				where,
				limit: PAGE_SIZE,
				...(cursor === undefined ? {} : { cursor }),
			});
			for (const item of result.items) visit(item.id, item.data);
			if (!result.hasMore || result.cursor === undefined) return;
			cursor = result.cursor;
		}
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
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
