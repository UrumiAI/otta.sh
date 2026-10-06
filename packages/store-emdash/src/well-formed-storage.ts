/**
 * The storage half of security review R3-B, X1: text Postgres cannot read.
 *
 * THE FAULT. The host stores a document as `JSON.stringify` text, which spells a
 * lone UTF-16 surrogate `"\ud800"` and U+0000 `"\u0000"`. On Postgres, every
 * `where`, `orderBy`, cursor and `updateIf` the host builds reads the row through
 * `(data)::jsonb`, and `jsonb` refuses both escapes — for every row of the
 * collection in scope, not only the rows the query wanted. So ONE such document
 * (an anonymous guest's ship-to city, say) made `listOrders` and the expiry
 * sweep's `listExpirable` throw for the whole store. SQLite and D1 read both
 * escapes, so the fault was Postgres-only.
 *
 * THE GUARD, two halves, both here so no adapter has to remember either:
 *
 * - **WRITES REPAIR.** `put`, `compareAndSet` and `updateIf`'s `set` pass the
 *   document through `repairIllFormedText` (each offending code unit becomes
 *   U+FFFD) and log the collection, id and path. Repair, NOT refusal, at this
 *   layer, deliberately: a refusal here would make a document that ALREADY holds
 *   such text — written before this guard — unwritable forever, and an order that
 *   can never be expired or paid holds its stock for good, which is the outage
 *   this exists to end. The refusal a person can act on is the boundary's job
 *   (the plugin's `commerce-input.ts` and route parsers); a repair logged here is
 *   a boundary gap to close, not a normal path.
 * - **READS HEAL.** When `query`, `count` or `updateIf` fails with Postgres's
 *   "cannot read this JSON" error, the guard pages the collection with NO `where`
 *   and NO `orderBy` — the one query shape the host never casts — rewrites each
 *   unreadable document by compare-and-set, and runs the failed call ONCE more.
 *   It cannot instead skip the bad row: the cast is inside the host's SQL, before
 *   any row reaches this code, and the query API has no "ignore unreadable rows"
 *   knob. Repair-then-retry is the only resilient read the API allows. A repair
 *   that loses its compare-and-set to a real writer re-reads and retries, so a
 *   racing payment or expiry is never undone; the writer's own write was repaired
 *   on the way in anyway.
 *
 * Healing is a one-time cost per legacy row (the guard keeps new rows clean), so
 * the full-collection page walk runs at most once per broken collection, shared
 * by every concurrent reader of the same host collection.
 */
import { findIllFormedText, repairIllFormedText } from "@otta-sh/domain";
import { CAS_MAX_ATTEMPTS } from "./cas-retry.js";
import type { StorageCollection } from "./storage-access.js";

/** The heal walk's page budget: 1000 pages of 100 documents. Far past any
 *  collection this store holds today; it bounds a runaway cursor, nothing else. */
export const HEAL_MAX_PAGES = 1000;

/**
 * Postgres's "this stored text is not JSON it can read": 22P05 (`\u0000`) or a
 * 22P02 whose message names JSON (a lone surrogate). Matched on the message as
 * well as the SQLSTATE, because an error crossing the sandbox bridge arrives as a
 * plain object that may have lost its `code`.
 */
export function isUnreadableDocumentError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: unknown }).code;
	const message = String((err as { message?: unknown }).message ?? "");
	if (code === "22P05") return true;
	return (
		/invalid input syntax for type json/i.test(message) ||
		/unsupported Unicode escape sequence/i.test(message)
	);
}

/** One heal walk per host collection at a time, shared by concurrent readers. */
const inFlight = new WeakMap<object, Promise<void>>();

function warnRepaired(collection: string, id: string, path: string, why: string): void {
	// The path and the id, never the text: it is a shopper's address or a buyer's
	// email, and this line goes to the worker log.
	console.warn(
		`[otta] storage: ${collection}/${id} held text Postgres cannot store (a lone ` +
			`surrogate or U+0000) at '${path || "(root)"}' — repaired to U+FFFD ${why}`,
	);
}

/** Write a repaired copy of one document, if it still needs one. */
async function healDocument(
	inner: StorageCollection<unknown>,
	collection: string,
	id: string,
): Promise<void> {
	for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
		const current = await inner.getVersioned(id);
		if (current === null) return;
		const path = findIllFormedText(current.value);
		if (path === null) return;
		const written = await inner.compareAndSet(
			id,
			current.revision,
			repairIllFormedText(current.value),
		);
		if (written.applied) {
			warnRepaired(collection, id, path, "on read (a query over the collection had failed)");
			return;
		}
		// Lost to a real writer: re-read. Its write went through the write half of
		// this guard, so the next read is most likely already clean.
	}
}

/** Page the whole collection the one way Postgres never casts, healing as it goes. */
async function healCollection(
	inner: StorageCollection<unknown>,
	collection: string,
): Promise<void> {
	let cursor: string | undefined;
	for (let pages = 0; pages < HEAL_MAX_PAGES; pages++) {
		const page = await inner.query({ limit: 100, ...(cursor !== undefined ? { cursor } : {}) });
		for (const item of page.items) {
			if (findIllFormedText(item.data) !== null) await healDocument(inner, collection, item.id);
		}
		if (!page.hasMore || page.cursor === undefined) return;
		cursor = page.cursor;
	}
	console.error(
		`[otta] storage: the repair walk over ${collection} reached its ${String(HEAL_MAX_PAGES)}-page ` +
			"ceiling; rows past it were not checked",
	);
}

function healCollectionOnce(inner: StorageCollection<unknown>, collection: string): Promise<void> {
	const running = inFlight.get(inner);
	if (running !== undefined) return running;
	const walk = healCollection(inner, collection).finally(() => inFlight.delete(inner));
	inFlight.set(inner, walk);
	return walk;
}

/** Run a read; if Postgres could not read a stored row, heal, then run it once more. */
async function readHealing<R>(op: () => Promise<R>, heal: () => Promise<void>): Promise<R> {
	try {
		return await op();
	} catch (err) {
		if (!isUnreadableDocumentError(err)) throw err;
		await heal();
		return op();
	}
}

/** The document with its ill-formed text repaired (the same reference when clean). */
function repairedForWrite<T>(collection: string, id: string, data: T): T {
	const path = findIllFormedText(data);
	if (path === null) return data;
	warnRepaired(collection, id, path, "on write — the caller's boundary should have refused it");
	return repairIllFormedText(data);
}

/**
 * `inner`, guarded: writes repair, reads heal. Every adapter receives its
 * collections through `collectionOf`, which applies this, so the guard covers the
 * whole storage surface by construction.
 */
export function guardWellFormed<T>(
	inner: StorageCollection<T>,
	collection: string,
): StorageCollection<T> {
	const untyped = inner as StorageCollection<unknown>;
	const healAll = (): Promise<void> => healCollectionOnce(untyped, collection);
	return {
		get: (id) => inner.get(id),
		getVersioned: (id) => inner.getVersioned(id),
		delete: (id) => inner.delete(id),
		compareAndDelete: (id, expectedRevision) => inner.compareAndDelete(id, expectedRevision),
		put: (id, data) => inner.put(id, repairedForWrite(collection, id, data)),
		compareAndSet: (id, expectedRevision, data) =>
			inner.compareAndSet(id, expectedRevision, repairedForWrite(collection, id, data)),
		query: (options) => readHealing(() => inner.query(options), healAll),
		count: (where) => readHealing(() => inner.count(where), healAll),
		updateIf: (id, args) => {
			const guarded =
				args.set === undefined
					? args
					: { ...args, set: repairedForWrite(collection, id, args.set) };
			// The row being updated is the likeliest unreadable one, so it is healed
			// first; a second failure means another row in scope, so the walk runs.
			return readHealing(
				() =>
					readHealing(
						() => inner.updateIf(id, guarded),
						() => healDocument(untyped, collection, id),
					),
				healAll,
			);
		},
	};
}
