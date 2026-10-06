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
 *   U+FFFD) and log the collection, a short hash of the id, and the path (keys
 *   that may be shopper text appear as `(key #n)`). Repair, NOT refusal, at this
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
 * THREE MORE RULES (review rounds 1 and 2):
 *
 * - **AN ILL-FORMED ID CAN NEVER CREATE A ROW.** `put` and a create-if-absent
 *   `compareAndSet` (null revision) refuse it with {@link IllFormedIdError}.
 *   Repairing it would BE the bug: on Postgres the driver already rewrites a lone
 *   surrogate to U+FFFD, so `"x\uD800"` and `"x\uDC00"` name one row and the
 *   second write silently overwrites the first. A method that addresses an
 *   EXISTING row — `get`, `getVersioned`, `delete`, `compareAndDelete`, a
 *   `compareAndSet` with a revision, the update-only `updateIf` — passes the id
 *   through unchanged, as before this guard: an id built from a LEGACY document's
 *   stored text (a reservation's sku, a buyer's email) must still reach its row,
 *   or a hold whose sku was stored ill-formed could never be released (review
 *   round 2, A R2-A1). A NUL in such an id answers "absent" on Postgres, which
 *   refuses it as a parameter and so can hold no such row.
 * - **`where` OPERANDS MATCH BOTH SPELLINGS.** An ill-formed string operand
 *   matches its repaired text (how this guard stores it) AND its raw text (how a
 *   legacy SQLite or D1 row still holds it — nothing heals there), as an `in`.
 *   A raw spelling holding NUL is left out: Postgres refuses it (22021), and its
 *   driver folds a lone surrogate anyway. A range or prefix operand has one
 *   value, so it matches the repaired text only.
 * - **KEYS NEVER MERGE.** Two object keys that repair to the same text keep one
 *   entry (see `repairIllFormedText`) and the drop is logged as an error. The key
 *   that was already well formed wins; that assumes it was written after the
 *   boundary existed, which holds for every map a shopper can add to (their keys
 *   are token-checked ASCII), so a shopper cannot plant a winning U+FFFD key next
 *   to a legacy one (review B I1).
 *
 * THE HEAL'S BOOKKEEPING is per DATABASE and collection name, at module scope —
 * not per collection object, because EmDash builds a fresh `ctx.storage` for every
 * route call and hook, so object identity is per request. The database is the
 * host collection's own handle (`PluginStorageRepository#db`, read structurally);
 * a collection without one (the sandbox bridge, which only ever runs on D1, where
 * the heal never fires) falls back to the name alone, i.e. one store per process,
 * which is how Otta deploys.
 *
 * - concurrent callers of one collection share one walk, across requests; a
 *   caller whose query failed before a walk finished retries at once, without
 *   walking again (review round 2, A R2-A2);
 * - a walk that reaches its page budget remembers its cursor, and the next
 *   failing call RESUMES there, so a bad row past the budget is reached on a
 *   later call instead of never;
 * - a walk that started at the BEGINNING and reached the end having seen no
 *   unreadable row cannot help a retry, so for {@link HEAL_COOL_DOWN_MS} a failing
 *   call rethrows at once instead of re-walking the collection every time. A
 *   resumed walk never saw the rows before its cursor, so it arms nothing (review
 *   B L7).
 *
 * Across requests on workerd, a shared walk promise could outlive a cancelled
 * request; that does not arise today (the heal fires only on Postgres, and Otta on
 * Workers uses D1). If Postgres over Hyperdrive is ever supported, bound that wait
 * (review round 2, A R2-A5). The walk runs UNMETERED when the collection offers
 * {@link UNMETERED_COLLECTION} (the sweep's query-budget proxy does): the budget
 * exists for D1's per-invocation query cap, and the heal only ever fires on a
 * Postgres error, where no such cap applies; the walk is bounded by its own page
 * budget instead.
 */
import {
	findIllFormedText,
	isWellFormedText,
	repairIllFormedText,
	toWellFormedText,
} from "@otta-sh/domain";
import { CAS_MAX_ATTEMPTS } from "./cas-retry.js";
import type { QueryOptions, StorageCollection, WhereClause, WhereValue } from "./storage-access.js";

/** The heal walk's page budget PER CALL: 1000 pages of 100 documents. A walk that
 *  reaches it resumes on the next failing call (see the module doc). */
export const HEAL_MAX_PAGES = 1000;

/** How long a collection whose walk repaired nothing fails fast instead of walking. */
export const HEAL_COOL_DOWN_MS = 60_000;

const HEAL_PAGE_SIZE = 100;

/**
 * The property a metering proxy (the sweep's query budget) exposes to hand the
 * guard the collection it wraps, so the heal walk is not charged to the tick.
 * `Symbol.for`, so the plugin and this package agree without importing each
 * other's instances.
 */
export const UNMETERED_COLLECTION: unique symbol = Symbol.for("otta.storage.unmetered-collection");

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

/**
 * Postgres refusing U+0000 in a bound text parameter (22021, "invalid byte
 * sequence for encoding UTF8: 0x00"). For an id it means "no such row": no
 * Postgres row can hold that id.
 */
function isNulParameterError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	if ((err as { code?: unknown }).code === "22021") return true;
	return /invalid byte sequence for encoding "UTF8": 0x00/i.test(
		String((err as { message?: unknown }).message ?? ""),
	);
}

/**
 * A short, stable tag for a document id — FNV-1a over its UTF-16 code units, 8
 * hex digits — so a log line can be matched to its document without printing the
 * id (some ids are a buyer's email). A correlation tag, not a secret: it hides
 * the id from a casual reader of the log, not from someone who can guess it.
 */
export function idTag(id: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `id#${hash.toString(16).padStart(8, "0")}`;
}

/** An id that holds a lone surrogate or U+0000, refused by every method that can
 *  CREATE a row under it (`put`, and `compareAndSet` with a null revision). */
export class IllFormedIdError extends Error {
	readonly code = "STORAGE_ILL_FORMED_ID";
	readonly collection: string;
	constructor(collection: string, id: string) {
		super(
			`[otta] storage: refused a document id in '${collection}' (${idTag(id)}) that holds a ` +
				"lone surrogate or U+0000 — an id must be well-formed text",
		);
		this.name = "IllFormedIdError";
		this.collection = collection;
	}
}

/** Structural test for {@link IllFormedIdError} — survives the sandbox bridge. */
export function isIllFormedIdError(err: unknown): err is IllFormedIdError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "STORAGE_ILL_FORMED_ID"
	);
}

/** Test seams for the heal's budget and clock. Production passes none. */
export interface WellFormedGuardOptions {
	/** Pages per walk call (default {@link HEAL_MAX_PAGES}). */
	readonly maxPages?: number;
	/** Default {@link HEAL_COOL_DOWN_MS}. */
	readonly coolDownMs?: number;
	readonly now?: () => number;
}

interface HealState {
	/** The walk now running, shared by every caller of this collection. */
	running?: Promise<void>;
	/** Where the last walk stopped at its page budget; the next walk starts here. */
	resumeCursor?: string;
	/** Until when a failing call rethrows without walking. */
	coolUntil?: number;
	/**
	 * Walks FINISHED so far. A caller reads it before its query runs; if it has
	 * moved by the time that query has failed, a walk ran in between and may well
	 * have repaired the row — so the caller retries at once, without walking and
	 * without consulting the cool-down (review round 2, A R2-A2).
	 */
	generation: number;
}

/**
 * The heal state, keyed by STORE then collection name, at module scope (see the
 * module doc for why not per object). The store is the host database handle the
 * host's collection carries (`PluginStorageRepository#db`, one per process, or a
 * preview's own); a collection that exposes none — the workerd sandbox's bridged
 * collections, a test double — falls back to one process-wide map keyed by name
 * alone, which is the one-store-per-process assumption the module doc states.
 */
let healStatesByStore = new WeakMap<object, Map<string, HealState>>();
let healStatesByName = new Map<string, HealState>();

function healStateOf(target: StorageCollection<unknown>, collection: string): HealState {
	const db = (target as { db?: unknown }).db;
	const pluginId = (target as { pluginId?: unknown }).pluginId;
	let states = healStatesByName;
	if (typeof db === "object" && db !== null) {
		states = healStatesByStore.get(db) ?? new Map<string, HealState>();
		healStatesByStore.set(db, states);
	}
	const key = typeof pluginId === "string" ? `${pluginId}/${collection}` : collection;
	let state = states.get(key);
	if (state === undefined) {
		state = { generation: 0 };
		states.set(key, state);
	}
	return state;
}

/** Forget every walk's cursor and cool-down. Suites only: state is per process,
 *  and store-emdash's test setup calls this after every case. */
export function resetHealStateForTests(): void {
	healStatesByStore = new WeakMap();
	healStatesByName = new Map();
}

function warnRepaired(collection: string, id: string, path: string, why: string): void {
	// A hash of the id and a log-safe path, never the text: it is a shopper's
	// address or a buyer's email, and this line goes to the worker log.
	console.warn(
		`[otta] storage: ${collection}/${idTag(id)} held text Postgres cannot store (a lone ` +
			`surrogate or U+0000) at '${path || "(root)"}' — repaired to U+FFFD ${why}`,
	);
}

/** Repair `data`, logging (as an error) any entry dropped by a key collision. */
function repairLogged<T>(collection: string, id: string, data: T): T {
	const dropped: string[] = [];
	const repaired = repairIllFormedText(data, (path) => dropped.push(path));
	if (dropped.length > 0) {
		console.error(
			`[otta] storage: ${collection}/${idTag(id)} had object keys that repair to the same ` +
				`text; kept one entry each and DROPPED ${dropped.join(", ")}`,
		);
	}
	return repaired;
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
			repairLogged(collection, id, current.value),
		);
		if (written.applied) {
			warnRepaired(collection, id, path, "on read (a query over the collection had failed)");
			return;
		}
		// Lost to a real writer: re-read. Its write went through the write half of
		// this guard, so the next read is most likely already clean.
	}
	// Every attempt lost a race. Said once, so a row the cool-down would otherwise
	// hide (review round 2, A R2-A6) leaves a trace; a later failing read retries it.
	console.error(
		`[otta] storage: gave up repairing ${collection}/${idTag(id)} after ` +
			`${String(CAS_MAX_ATTEMPTS)} attempts lost to concurrent writers; a later failing read retries it`,
	);
}

/**
 * Page the collection the one way Postgres never casts, healing as it goes —
 * from where the last budget-capped walk stopped, for at most `maxPages` pages.
 */
async function healCollection(
	inner: StorageCollection<unknown>,
	collection: string,
	state: HealState,
	options: Required<WellFormedGuardOptions>,
): Promise<void> {
	let cursor = state.resumeCursor;
	// Only a walk that began at the start of the collection has seen every row, so
	// only it may conclude "walking cannot help" (review B L7).
	const fromStart = cursor === undefined;
	// Rows this walk SAW unreadable — repaired by it or by a racing healer alike.
	let seen = 0;
	for (let pages = 0; pages < options.maxPages; pages++) {
		const page = await inner.query({
			limit: HEAL_PAGE_SIZE,
			...(cursor !== undefined ? { cursor } : {}),
		});
		for (const item of page.items) {
			if (findIllFormedText(item.data) === null) continue;
			seen++;
			await healDocument(inner, collection, item.id);
		}
		if (!page.hasMore || page.cursor === undefined) {
			state.resumeCursor = undefined;
			// The whole collection walked, and nothing unreadable seen: a retry cannot
			// succeed because of a walk, so stop walking for a while (review B L4). A
			// RESUMED walk never saw the rows before its cursor, so it proves nothing.
			if (fromStart && seen === 0) state.coolUntil = options.now() + options.coolDownMs;
			return;
		}
		cursor = page.cursor;
		// Saved per page, so even a walk cut off mid-way (a thrown error) resumes.
		state.resumeCursor = cursor;
	}
	console.error(
		`[otta] storage: the repair walk over ${collection} reached its ` +
			`${String(options.maxPages)}-page budget; the next failing call resumes past it`,
	);
}

/** Run a read; if Postgres could not read a stored row, heal, then run it once more. */
async function retryAfterHeal<R>(op: () => Promise<R>, heal: () => Promise<unknown>): Promise<R> {
	try {
		return await op();
	} catch (err) {
		if (!isUnreadableDocumentError(err)) throw err;
		await heal();
		return op();
	}
}

/**
 * {@link retryAfterHeal} with the collection walk's bookkeeping:
 *
 * - a walk FINISHED since `op` began (the generation moved): retry at once — the
 *   failure may predate the repair, and walking again would be useless and could
 *   set a false cool-down;
 * - a walk is RUNNING: wait for it, then retry;
 * - otherwise, cooling down: rethrow; else walk, then retry.
 */
async function readHealing<R>(
	op: () => Promise<R>,
	state: HealState,
	walk: () => Promise<void>,
	coolingDown: () => boolean,
): Promise<R> {
	const generation = state.generation;
	try {
		return await op();
	} catch (err) {
		if (!isUnreadableDocumentError(err)) throw err;
		if (state.generation === generation) {
			if (state.running === undefined && coolingDown()) throw err;
			await walk();
		}
		return op();
	}
}

/** The document with its ill-formed text repaired (the same reference when clean). */
function repairedForWrite<T>(collection: string, id: string, data: T): T {
	const path = findIllFormedText(data);
	if (path === null) return data;
	warnRepaired(collection, id, path, "on write — the caller's boundary should have refused it");
	return repairLogged(collection, id, data);
}

/**
 * The spellings a string operand must match: the repaired text (how the guard
 * stores it now) and, when that differs, the raw text too — a legacy SQLite or D1
 * row written before the guard still holds it raw (review round 2, A R2-A3). A raw
 * spelling holding U+0000 is left out: Postgres refuses it as a parameter (22021),
 * and no Postgres row can hold it anyway.
 */
function spellingsOf(text: string): string[] {
	const repaired = toWellFormedText(text);
	if (repaired === text || text.includes("\u0000")) return [repaired];
	return [repaired, text];
}

function widenedOperand(value: WhereValue): WhereValue {
	if (typeof value === "string") {
		const spellings = spellingsOf(value);
		return spellings.length === 1 ? (spellings[0] as string) : { in: spellings };
	}
	if (typeof value === "object" && value !== null && "in" in value) {
		const entries: ReadonlyArray<string | number> = value.in;
		const list = entries.flatMap(
			(entry): Array<string | number> => (typeof entry === "string" ? spellingsOf(entry) : [entry]),
		);
		return { in: [...new Set(list)] };
	}
	// A range or a prefix has one operand, so it matches the repaired text only.
	return repairIllFormedText(value);
}

/**
 * A `where` whose string operands also match the text as the guard stores it:
 * each ill-formed operand matches its repaired spelling AND its raw one (see
 * {@link spellingsOf}). Keys repair as stored keys do. The same reference when
 * clean.
 */
function repairedWhere(where: WhereClause | undefined): WhereClause | undefined {
	if (where === undefined || findIllFormedText(where) === null) return where;
	const entries = Object.entries(where);
	// Keys first, by the stored-document rule (one survivor per repaired key),
	// carrying each survivor's original position.
	const keepers = repairIllFormedText(Object.fromEntries(entries.map(([key], i) => [key, i])));
	const out: WhereClause = {};
	for (const [key, position] of Object.entries(keepers)) {
		out[key] = widenedOperand((entries[position] as [string, WhereValue])[1]);
	}
	return out;
}

function repairedQuery(options: QueryOptions | undefined): QueryOptions | undefined {
	if (options?.where === undefined) return options;
	const where = repairedWhere(options.where);
	return where === options.where ? options : { ...options, where };
}

/**
 * `inner`, guarded: creating ids refused, writes and `where` operands repaired,
 * reads healed. Every adapter receives its collections through `collectionOf`, which
 * applies this, so the guard covers the whole storage surface by construction.
 */
export function guardWellFormed<T>(
	inner: StorageCollection<T>,
	collection: string,
	options: WellFormedGuardOptions = {},
): StorageCollection<T> {
	const settings: Required<WellFormedGuardOptions> = {
		maxPages: options.maxPages ?? HEAL_MAX_PAGES,
		coolDownMs: options.coolDownMs ?? HEAL_COOL_DOWN_MS,
		now: options.now ?? Date.now,
	};
	/** The collection the heal reads and writes: past any metering proxy. */
	const healTarget = (): StorageCollection<unknown> =>
		(inner as { [UNMETERED_COLLECTION]?: StorageCollection<unknown> })[UNMETERED_COLLECTION] ??
		(inner as StorageCollection<unknown>);
	const state = healStateOf(healTarget(), collection);
	const healAll = (): Promise<void> => {
		if (state.running !== undefined) return state.running;
		const walk = healCollection(healTarget(), collection, state, settings).finally(() => {
			state.generation++;
			state.running = undefined;
		});
		state.running = walk;
		return walk;
	};
	const coolingDown = (): boolean =>
		state.coolUntil !== undefined && settings.now() < state.coolUntil;
	/**
	 * Run a CREATING write only for a well-formed id; otherwise reject with the
	 * typed error. A method that addresses an EXISTING row passes its id through
	 * unchanged instead (see the module doc).
	 */
	const creating = <R>(id: string, op: () => Promise<R>): Promise<R> =>
		isWellFormedText(id) ? op() : Promise.reject(new IllFormedIdError(collection, id));
	/**
	 * Run a write or read that addresses an EXISTING row, its id unchanged. A NUL
	 * in the id is the one case Postgres refuses outright (22021) rather than
	 * folding; no row there can hold it, so the answer is `absent`, as on `main`
	 * for every other missing row. SQLite and D1 look the raw id up as before.
	 */
	const addressing = <R>(id: string, op: () => Promise<R>, absent: R): Promise<R> =>
		id.includes("\u0000")
			? op().catch((err: unknown) => {
					if (isNulParameterError(err)) return absent;
					throw err;
				})
			: op();

	return {
		get: (id) => addressing(id, () => inner.get(id), null),
		getVersioned: (id) => addressing(id, () => inner.getVersioned(id), null),
		delete: (id) => addressing(id, () => inner.delete(id), false),
		compareAndDelete: (id, expectedRevision) =>
			addressing(id, () => inner.compareAndDelete(id, expectedRevision), { applied: false }),
		put: (id, data) => creating(id, () => inner.put(id, repairedForWrite(collection, id, data))),
		compareAndSet: (id, expectedRevision, data) => {
			const write = () =>
				inner.compareAndSet(id, expectedRevision, repairedForWrite(collection, id, data));
			// A null revision is create-if-absent; a revision names a row that exists.
			return expectedRevision === null
				? creating(id, write)
				: addressing(id, write, { applied: false });
		},
		query: (queryOptions) => {
			const repaired = repairedQuery(queryOptions);
			return readHealing(() => inner.query(repaired), state, healAll, coolingDown);
		},
		count: (where) => {
			const repaired = repairedWhere(where);
			return readHealing(() => inner.count(repaired), state, healAll, coolingDown);
		},
		// Update-only: it never inserts, so its id addresses an existing row.
		updateIf: (id, args) => {
			const where = repairedWhere(args.where);
			const guarded = {
				...args,
				...(where === undefined ? {} : { where }),
				...(args.set === undefined ? {} : { set: repairedForWrite(collection, id, args.set) }),
			};
			// The row being updated is the likeliest unreadable one, so it is healed
			// first; a second failure means another row in scope, so the walk runs.
			return addressing(
				id,
				() =>
					readHealing(
						() =>
							retryAfterHeal(
								() => inner.updateIf(id, guarded),
								() => healDocument(healTarget(), collection, id),
							),
						state,
						healAll,
						coolingDown,
					),
				{ applied: false },
			);
		},
	};
}
