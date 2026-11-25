/**
 * The `AgentSessionStore` contract harness for the EmDash adapter, shared by the
 * Node dialects and D1. Its crash hooks are REAL crashes on REAL storage: the
 * same adapter runs over the same collections, wrapped so one write throws as a
 * dying process would, and the residue it leaves is what the contract then
 * exercises. Nothing is faked and no hook is skipped.
 *
 *  - before the session write: the insert's create-if-absent on its session
 *    document throws instead of running, after both slots were taken;
 *  - before landing: that create-if-absent runs, then the first update on a
 *    slot document (the landing mark) throws instead of running.
 */
import type { AgentCheckoutSession, AgentSessionCapacity } from "@urumi.ai/otta-domain";
import type { AgentSessionStoreHarness } from "@urumi.ai/otta-domain/testing";
import {
	AGENT_SESSION_COLLECTIONS,
	AGENT_SESSION_SLOTS_COLLECTION,
	AGENT_SESSIONS_COLLECTION,
	EmdashAgentSessionStore,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";

/** What an injected crash throws; anything else is a real failure and propagates. */
export class AgentSessionInjectedCrash extends Error {
	override readonly name = "AgentSessionInjectedCrash";
}

function wrap(
	raw: StorageCollection,
	compareAndSet: StorageCollection["compareAndSet"],
): StorageCollection {
	return {
		get: (id) => raw.get(id),
		put: (id, data) => raw.put(id, data),
		delete: (id) => raw.delete(id),
		query: (options) => raw.query(options),
		count: (where) => raw.count(where),
		updateIf: (id, args) => raw.updateIf(id, args),
		getVersioned: (id) => raw.getVersioned(id),
		compareAndSet,
		compareAndDelete: (id, revision) => raw.compareAndDelete(id, revision),
	};
}

async function crashing(run: () => Promise<unknown>): Promise<void> {
	try {
		await run();
	} catch (err) {
		if (err instanceof AgentSessionInjectedCrash) return;
		throw err;
	}
	throw new Error("the injected crash point was never reached");
}

/** An insert of `session` that dies right before its session document is written. */
export function crashBeforeSessionWrite(
	storage: StorageAccess,
): (session: AgentCheckoutSession, capacity: AgentSessionCapacity) => Promise<void> {
	return (session, capacity) => {
		const sessions = storage[AGENT_SESSIONS_COLLECTION];
		if (sessions === undefined) throw new Error("sessions collection missing");
		const wrapped = wrap(sessions, (id, expected, data) => {
			if (id === session.id && expected === null) {
				return Promise.reject(new AgentSessionInjectedCrash("before the session write"));
			}
			return sessions.compareAndSet(id, expected, data);
		});
		const store = new EmdashAgentSessionStore({
			storage: { ...storage, [AGENT_SESSIONS_COLLECTION]: wrapped },
		});
		return crashing(() => store.insert(session, capacity));
	};
}

/** An insert of `session` that dies after writing its (hidden) session document,
 *  before marking any slot landed. */
export function crashBeforeLanding(
	storage: StorageAccess,
): (session: AgentCheckoutSession, capacity: AgentSessionCapacity) => Promise<void> {
	return (session, capacity) => {
		const sessions = storage[AGENT_SESSIONS_COLLECTION];
		const slots = storage[AGENT_SESSION_SLOTS_COLLECTION];
		if (sessions === undefined || slots === undefined) throw new Error("collections missing");
		let written = false;
		const wrappedSessions = wrap(sessions, async (id, expected, data) => {
			const result = await sessions.compareAndSet(id, expected, data);
			if (id === session.id && expected === null && result.applied) written = true;
			return result;
		});
		const wrappedSlots = wrap(slots, (id, expected, data) => {
			if (written && expected !== null) {
				return Promise.reject(new AgentSessionInjectedCrash("before landing"));
			}
			return slots.compareAndSet(id, expected, data);
		});
		const store = new EmdashAgentSessionStore({
			storage: {
				...storage,
				[AGENT_SESSIONS_COLLECTION]: wrappedSessions,
				[AGENT_SESSION_SLOTS_COLLECTION]: wrappedSlots,
			},
		});
		return crashing(() => store.insert(session, capacity));
	};
}

/**
 * Empty every agent-session collection. The contract calls its harness factory
 * several times inside ONE test (its interleaving loops), and the tiers reset
 * storage only per test, so each fresh harness must start from nothing, as the
 * in-memory fake does.
 */
export async function clearAgentSessionStorage(storage: StorageAccess): Promise<void> {
	for (const name of Object.keys(AGENT_SESSION_COLLECTIONS)) {
		const collection = storage[name];
		if (collection === undefined) throw new Error(`collection ${name} missing`);
		for (;;) {
			const page = await collection.query({ limit: 100 });
			for (const { id } of page.items) await collection.delete(id);
			if (page.items.length === 0) break;
		}
	}
}

/** A fresh harness over emptied storage: the store, both crash hooks, and the
 *  hidden-inclusive document count. */
export async function freshEmdashAgentSessionHarness(
	storage: StorageAccess,
): Promise<AgentSessionStoreHarness> {
	await clearAgentSessionStorage(storage);
	return emdashAgentSessionHarness(storage);
}

/** The full harness: the store, both crash hooks, and the hidden-inclusive count. */
export function emdashAgentSessionHarness(storage: StorageAccess): AgentSessionStoreHarness {
	const sessions = storage[AGENT_SESSIONS_COLLECTION];
	if (sessions === undefined) throw new Error("sessions collection missing");
	return {
		store: new EmdashAgentSessionStore({ storage }),
		crashInsertBeforeLanding: crashBeforeLanding(storage),
		crashInsertBeforeSessionWrite: crashBeforeSessionWrite(storage),
		countSessionDocuments: () => sessions.count(),
	};
}
