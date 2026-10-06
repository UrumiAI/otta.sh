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
 * THREE MORE RULES (review round 1):
 *
 * - **IDS ARE REFUSED, not repaired.** An id that is not well formed throws
 *   {@link IllFormedIdError} from every id-taking method. Repairing it would BE the
 *   bug: on Postgres the driver already rewrites a lone surrogate to U+FFFD, so
 *   `"x\uD800"` and `"x\uDC00"` name one row and the second write silently
 *   overwrites the first. No row can already hold such an id there, so refusal
 *   bricks no legacy document.
 * - **`where` OPERANDS ARE REPAIRED** the way stored text is, so a lookup by the
 *   raw value finds the stored, repaired row on every dialect (SQLite kept the
 *   raw code units and missed it; Postgres's driver already folded them) and a
 *   NUL operand is a clean miss rather than Postgres's 22021.
 * - **KEYS NEVER MERGE.** Two object keys that repair to the same text keep one
 *   entry (see `repairIllFormedText`) and the drop is logged as an error.
 *
 * THE HEAL'S BOOKKEEPING is per collection NAME, at module scope — not per
 * collection object, because EmDash builds a fresh `ctx.storage` for every route
 * call and hook, so object identity is per request:
 *
 * - concurrent callers of one collection share one walk, across requests;
 * - a walk that reaches its page budget remembers its cursor, and the next
 *   failing call RESUMES there, so a bad row past the budget is reached on a
 *   later call instead of never;
 * - a walk that reaches the end having seen no unreadable row cannot help a
 *   retry, so for
 *   {@link HEAL_COOL_DOWN_MS} a failing call rethrows at once instead of
 *   re-walking the collection every time.
 *
 * One store per isolate is assumed (the plugin's collections are the store's),
 * which is how Otta deploys. The walk runs UNMETERED when the collection offers
 * {@link UNMETERED_COLLECTION} (the sweep's query-budget proxy does): the budget
 * exists for D1's per-invocation query cap, and the heal only ever fires on a
 * Postgres error, where no such cap applies; the walk is bounded by its own page
 * budget instead.
 */
import { findIllFormedText, isWellFormedText, repairIllFormedText } from "@otta-sh/domain";
import { CAS_MAX_ATTEMPTS } from "./cas-retry.js";
import type { QueryOptions, StorageCollection, WhereClause } from "./storage-access.js";

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

/** An id that holds a lone surrogate or U+0000, refused by every id-taking method. */
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
	/** The walk now running, shared by every caller of this collection name. */
	running?: Promise<void>;
	/** Where the last walk stopped at its page budget; the next walk starts here. */
	resumeCursor?: string;
	/** Until when a failing call rethrows without walking. */
	coolUntil?: number;
}

/** Per collection NAME, module scope: see the module doc for why not per object. */
const healStates = new Map<string, HealState>();

function healStateOf(collection: string): HealState {
	let state = healStates.get(collection);
	if (state === undefined) {
		state = {};
		healStates.set(collection, state);
	}
	return state;
}

/** Forget every walk's cursor and cool-down. Suites only: state is per process. */
export function resetHealStateForTests(): void {
	healStates.clear();
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
			// The end, and nothing unreadable seen: a retry cannot succeed because of
			// a walk, so stop walking for a while (review B L4).
			if (seen === 0) state.coolUntil = options.now() + options.coolDownMs;
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
async function readHealing<R>(
	op: () => Promise<R>,
	heal: () => Promise<unknown>,
	coolingDown: () => boolean = () => false,
): Promise<R> {
	try {
		return await op();
	} catch (err) {
		if (!isUnreadableDocumentError(err) || coolingDown()) throw err;
		await heal();
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

/** A `where` with its string operands repaired as stored text is (same ref when clean). */
function repairedWhere(where: WhereClause | undefined): WhereClause | undefined {
	return where === undefined ? undefined : repairIllFormedText(where);
}

function repairedQuery(options: QueryOptions | undefined): QueryOptions | undefined {
	if (options?.where === undefined) return options;
	const where = repairedWhere(options.where);
	return where === options.where ? options : { ...options, where };
}

/**
 * `inner`, guarded: ids refused, writes and `where` operands repaired, reads
 * healed. Every adapter receives its collections through `collectionOf`, which
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
	const state = healStateOf(collection);
	/** The collection the heal reads and writes: past any metering proxy. */
	const healTarget = (): StorageCollection<unknown> =>
		(inner as { [UNMETERED_COLLECTION]?: StorageCollection<unknown> })[UNMETERED_COLLECTION] ??
		(inner as StorageCollection<unknown>);
	const healAll = (): Promise<void> => {
		if (state.running !== undefined) return state.running;
		const walk = healCollection(healTarget(), collection, state, settings).finally(() => {
			state.running = undefined;
		});
		state.running = walk;
		return walk;
	};
	const coolingDown = (): boolean =>
		state.coolUntil !== undefined && settings.now() < state.coolUntil;
	/** Run `op` only for a well-formed id; otherwise reject with the typed error. */
	const withId = <R>(id: string, op: () => Promise<R>): Promise<R> =>
		isWellFormedText(id) ? op() : Promise.reject(new IllFormedIdError(collection, id));

	return {
		get: (id) => withId(id, () => inner.get(id)),
		getVersioned: (id) => withId(id, () => inner.getVersioned(id)),
		delete: (id) => withId(id, () => inner.delete(id)),
		compareAndDelete: (id, expectedRevision) =>
			withId(id, () => inner.compareAndDelete(id, expectedRevision)),
		put: (id, data) => withId(id, () => inner.put(id, repairedForWrite(collection, id, data))),
		compareAndSet: (id, expectedRevision, data) =>
			withId(id, () =>
				inner.compareAndSet(id, expectedRevision, repairedForWrite(collection, id, data)),
			),
		query: (queryOptions) => {
			const repaired = repairedQuery(queryOptions);
			return readHealing(() => inner.query(repaired), healAll, coolingDown);
		},
		count: (where) => {
			const repaired = repairedWhere(where);
			return readHealing(() => inner.count(repaired), healAll, coolingDown);
		},
		updateIf: (id, args) =>
			withId(id, () => {
				const where = repairedWhere(args.where);
				const guarded = {
					...args,
					...(where === undefined ? {} : { where }),
					...(args.set === undefined ? {} : { set: repairedForWrite(collection, id, args.set) }),
				};
				// The row being updated is the likeliest unreadable one, so it is healed
				// first; a second failure means another row in scope, so the walk runs.
				return readHealing(
					() =>
						readHealing(
							() => inner.updateIf(id, guarded),
							() => healDocument(healTarget(), collection, id),
						),
					healAll,
					coolingDown,
				);
			}),
	};
}
