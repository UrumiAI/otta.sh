/**
 * Fault injection over a **real** storage collection.
 *
 * Every wrapper here delegates to the repository it was given and does exactly
 * one extra thing: it **parks** a chosen call until a test releases it, or it
 * **fails** a chosen call by throwing. Nothing is faked — no result is invented,
 * no write is swallowed unless the test asked for precisely that — because the
 * whole point of these suites is that the document that lands is the one the real
 * host would have written.
 *
 * That buys the two seams a crash tier needs:
 *
 * - **A window.** `parkCall` holds one call open while a peer (or the test
 *   itself) observes the intermediate state. This is the deterministic,
 *   real-storage way to prove an ORDERING: park the second of two writes and
 *   assert the first has landed and the effect of the second has not.
 * - **A crash.** `failCall` in `"after"` mode performs the real call and *then*
 *   throws, so "the process died between write A and write B" is emulated by
 *   letting A land and making B throw. In `"instead"` mode the call never
 *   happens. A test must read the document back before replaying, so the
 *   "durably landed" half of the seam is asserted rather than assumed.
 *
 * Both wrappers are built from {@link delegatingCollection}, which is also the
 * honest way to write a one-method decorator: the other eight methods pass
 * straight through, so a wrapper cannot accidentally become a fake by forgetting
 * one.
 *
 * **What they intercept, and the limit that implies.** `parkCall` and `failCall`
 * hook the four WRITE methods the adapters use — `compareAndSet`, `put`,
 * `compareAndDelete` and `updateIf`. Everything else passes straight through
 * unparked and unfailed, and a read is never intercepted at all.
 *
 * `updateIf` was added when the coupon adapter put the first GUARDED writes in the
 * package on it (the redemption counter's `+1` and the release floor's `-1`): a
 * crash seam around a guarded delta cannot be injected by wrapping
 * `compareAndSet`, because no `compareAndSet` is involved. The warning the earlier
 * note carried still stands and is worth keeping: **if an adapter moves a write
 * onto a method this helper does not intercept, it must be extended, or the seam
 * tests will silently stop covering that write** — they would pass while injecting
 * nothing. `test/coupon-crash-seams.dialects.test.ts` pins the `updateIf` half of
 * that from the other side, by asserting that a PARKED guarded update really does
 * hold the counter still.
 */
import type { StorageAccess, StorageCollection } from "../../src/index.js";

/** Any method of Otta's storage port; the unit a fault is matched against. */
export type StorageMethodName = keyof StorageCollection;

/**
 * One observed call: the method, the document id, and — for `compareAndSet` — the
 * revision it was guarded on, which is what separates a create-if-absent claim
 * from a read-modify-write update.
 */
export interface StorageCall {
	readonly method: StorageMethodName;
	/** The document id — an EMPTY string for `query` and `count`, which name no document
	 *  and have one synthesized so a matcher can still read the field unconditionally. */
	readonly id: string;
	/** `null` for a create-if-absent; a string for an update; absent otherwise. */
	readonly expectedRevision?: string | null;
}

/** Chooses which call a fault applies to. */
export type CallMatcher = (call: StorageCall) => boolean;

/** The GUARDED updates — `updateIf(id, { where, set, delta })`. */
export const isGuardedUpdate: CallMatcher = (call) => call.method === "updateIf";

/** The create-if-absent claim writes — `compareAndSet(id, null, …)`. */
export const isClaimWrite: CallMatcher = (call) =>
	call.method === "compareAndSet" && call.expectedRevision === null;

/**
 * The read-modify-write updates — `compareAndSet(id, revision, …)`. These are the
 * writes a crash seam usually targets: the aggregate decrement, the terminal
 * record, the prune, the "mark applied".
 */
export const isUpdateWrite: CallMatcher = (call) =>
	call.method === "compareAndSet" &&
	call.expectedRevision !== null &&
	call.expectedRevision !== undefined;

/**
 * Narrow a matcher to the Nth matching call (1-based), so a seam can target the
 * SECOND write of a kind on one document.
 *
 * Stateful, and therefore single-use: build a fresh one per injector. It exists
 * because a matcher sees the method, the id and the guarded revision but never the
 * DATA, so two writes that differ only in what they store — a state machine's
 * successive transitions on one document — can be told apart only by counting.
 */
export function nthCall(n: number, match: CallMatcher): CallMatcher {
	let seen = 0;
	return (call) => {
		if (!match(call)) return false;
		seen++;
		return seen === n;
	};
}

/** Narrow a matcher to one document id. */
export function onId(id: string, match: CallMatcher): CallMatcher {
	return (call) => call.id === id && match(call);
}

/** What an injected crash throws. Distinguishable from a real storage failure. */
export class InjectedCrashError extends Error {
	override readonly name = "InjectedCrashError";
	readonly call: StorageCall;

	constructor(call: StorageCall) {
		super(`injected crash on ${call.method}('${call.id}') — the process is pretending to die here`);
		this.call = call;
	}
}

/**
 * A collection that forwards all nine methods to `raw`, with the given methods
 * replaced. Used by every wrapper below so that decorating one method can never
 * silently drop another.
 */
export function delegatingCollection<T>(
	raw: StorageCollection<T>,
	overrides: Partial<StorageCollection<T>>,
): StorageCollection<T> {
	return {
		get: (id) => raw.get(id),
		put: (id, data) => raw.put(id, data),
		delete: (id) => raw.delete(id),
		query: (options) => raw.query(options),
		count: (where) => raw.count(where),
		updateIf: (id, args) => raw.updateIf(id, args),
		getVersioned: (id) => raw.getVersioned(id),
		compareAndSet: (id, expectedRevision, data) => raw.compareAndSet(id, expectedRevision, data),
		compareAndDelete: (id, revision) => raw.compareAndDelete(id, revision),
		...overrides,
	};
}

/** Replace one collection of a `StorageAccess`, leaving the rest untouched. */
export function withCollection(
	storage: StorageAccess,
	name: string,
	collection: StorageCollection,
): StorageAccess {
	return { ...storage, [name]: collection };
}

/** The VERSIONED reads — `getVersioned(id)`. A pin is one of these. */
export const isVersionedRead: CallMatcher = (call) => call.method === "getVersioned";

/** The index reads — `query(options)`. Matched on the method; a query has no id. */
export const isQueryRead: CallMatcher = (call) => call.method === "query";

/** A collection with one call held open, and the handles to observe and free it. */
export interface ParkedCollection<T> {
	readonly collection: StorageCollection<T>;
	/** Resolves once a matching call has arrived and is parked. */
	readonly arrived: Promise<void>;
	/** Let the parked call proceed. Safe to call before anything has arrived. */
	release(): void;
	/** How many calls have been parked so far. */
	parked(): number;
}

/**
 * Park the first matching call — the call is **not** performed until `release()`,
 * and then it is performed for real.
 *
 * This is how an ordering is pinned without a sleep and without a mock: park the
 * write that is supposed to come SECOND, await `arrived`, and assert that the
 * first write has landed while the second's effect has not.
 */
export function parkCall<T>(
	raw: StorageCollection<T>,
	match: CallMatcher,
	options: { once?: boolean } = {},
): ParkedCollection<T> {
	const once = options.once ?? true;
	let count = 0;
	let releaseGate: (() => void) | undefined;
	let announceArrival: (() => void) | undefined;
	const arrived = new Promise<void>((resolve) => {
		announceArrival = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});

	const park = async (call: StorageCall): Promise<boolean> => {
		if (!match(call) || (once && count > 0)) return false;
		count++;
		announceArrival?.();
		await gate;
		return true;
	};

	return {
		collection: delegatingCollection(raw, {
			async compareAndSet(id, expectedRevision, data) {
				await park({ method: "compareAndSet", id, expectedRevision });
				return raw.compareAndSet(id, expectedRevision, data);
			},
			async put(id, data) {
				await park({ method: "put", id });
				return raw.put(id, data);
			},
			async compareAndDelete(id, revision) {
				await park({ method: "compareAndDelete", id });
				return raw.compareAndDelete(id, revision);
			},
			async updateIf(id, args) {
				await park({ method: "updateIf", id });
				return raw.updateIf(id, args);
			},
		}),
		arrived,
		release() {
			releaseGate?.();
		},
		parked: () => count,
	};
}

/**
 * Park the first matching READ — `get`, `getVersioned`, `query` or `count` — and perform it
 * for real on release.
 *
 * The write arm above cannot express the ordering that matters for a read-modify-write
 * against a pinned revision: what a recompute does BEFORE its own write decides whether the
 * value it commits is stale. Parking the read that pins a revision holds exactly that
 * window open, so "this value was read before that one" becomes a deterministic assertion
 * rather than a reading of the code.
 *
 * It is a separate function rather than four more methods on {@link parkCall} on purpose:
 * every existing caller of that one passes a matcher that would happily match a read, and
 * silently parking a read for a suite that asked to park a write would change what those
 * suites test.
 */
export function parkRead<T>(
	raw: StorageCollection<T>,
	match: CallMatcher,
	options: { once?: boolean } = {},
): ParkedCollection<T> {
	const once = options.once ?? true;
	let count = 0;
	let releaseGate: (() => void) | undefined;
	let announceArrival: (() => void) | undefined;
	const arrived = new Promise<void>((resolve) => {
		announceArrival = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});

	const park = async (call: StorageCall): Promise<boolean> => {
		if (!match(call) || (once && count > 0)) return false;
		count++;
		announceArrival?.();
		await gate;
		return true;
	};

	return {
		collection: delegatingCollection(raw, {
			async get(id) {
				await park({ method: "get", id });
				return raw.get(id);
			},
			async getVersioned(id) {
				await park({ method: "getVersioned", id });
				return raw.getVersioned(id);
			},
			async query(queryOptions) {
				await park({ method: "query", id: "" });
				return raw.query(queryOptions);
			},
			async count(where) {
				await park({ method: "count", id: "" });
				return raw.count(where);
			},
		}),
		arrived,
		release() {
			releaseGate?.();
		},
		parked: () => count,
	};
}

/** Where the throw goes relative to the real call. */
export type FailMode =
	/** Perform the real call, THEN throw: "the process died after this write". */
	| "after"
	/** Throw without performing it: "the process died before this write". */
	| "instead";

/** A collection with one call made to throw, and a count of how often it did. */
export interface FailingCollection<T> {
	readonly collection: StorageCollection<T>;
	/** How many calls have been failed so far. */
	failed(): number;
}

/**
 * Fail the first matching call by throwing {@link InjectedCrashError}.
 *
 * With `mode: "after"` the real call happens first, so the write DURABLY LANDS
 * and only the continuation is lost — which is the seam that matters: a crash
 * between write A and write B is "let A land, make B throw". With
 * `mode: "instead"` (the default) the write never happens.
 *
 * A test must read the affected documents back before replaying: that read is the
 * proof that the state the replay heals is the state the store really leaves
 * behind.
 */
export function failCall<T>(
	raw: StorageCollection<T>,
	match: CallMatcher,
	options: { mode?: FailMode; once?: boolean } = {},
): FailingCollection<T> {
	const mode = options.mode ?? "instead";
	const once = options.once ?? true;
	let count = 0;

	const shouldFail = (call: StorageCall): boolean => {
		if (!match(call) || (once && count > 0)) return false;
		count++;
		return true;
	};

	return {
		collection: delegatingCollection(raw, {
			async compareAndSet(id, expectedRevision, data) {
				const call: StorageCall = { method: "compareAndSet", id, expectedRevision };
				if (!shouldFail(call)) return raw.compareAndSet(id, expectedRevision, data);
				if (mode === "after") await raw.compareAndSet(id, expectedRevision, data);
				throw new InjectedCrashError(call);
			},
			async put(id, data) {
				const call: StorageCall = { method: "put", id };
				if (!shouldFail(call)) return raw.put(id, data);
				if (mode === "after") await raw.put(id, data);
				throw new InjectedCrashError(call);
			},
			async compareAndDelete(id, revision) {
				const call: StorageCall = { method: "compareAndDelete", id };
				if (!shouldFail(call)) return raw.compareAndDelete(id, revision);
				if (mode === "after") await raw.compareAndDelete(id, revision);
				throw new InjectedCrashError(call);
			},
			async updateIf(id, args) {
				const call: StorageCall = { method: "updateIf", id };
				if (!shouldFail(call)) return raw.updateIf(id, args);
				if (mode === "after") await raw.updateIf(id, args);
				throw new InjectedCrashError(call);
			},
		}),
		failed: () => count,
	};
}

/**
 * Resolve a call to its value OR to the error it threw, so a crowd of racers can
 * be settled and classified instead of the first rejection aborting the lot.
 *
 * Shared by every suite that races a crowd: a contention failure is an expected,
 * typed outcome under the documented budget, so it has to be counted rather than
 * thrown.
 */
export async function settleOne<T>(call: Promise<T>): Promise<T | unknown> {
	try {
		return await call;
	} catch (err: unknown) {
		return err;
	}
}

/**
 * A collection whose read-modify-write `compareAndSet`s always LOSE: before each
 * one, a real competing write lands on the same document, so the caller's
 * revision is genuinely stale and the real repository really rejects it.
 *
 * Not a fault injector in the crash sense — nothing is faked and nothing is
 * skipped — but the same decorator shape, and the only way to drive the retry
 * budget to exhaustion deterministically.
 */
export function alwaysLosingCollection<T>(raw: StorageCollection<T>): StorageCollection<T> {
	return delegatingCollection(raw, {
		async compareAndSet(id, expectedRevision, data) {
			if (expectedRevision !== null) {
				const current = await raw.getVersioned(id);
				if (current !== null) await raw.put(id, current.value);
			}
			return raw.compareAndSet(id, expectedRevision, data);
		},
	});
}

/** A per-method tally of the calls a collection received. */
export interface CallCounts {
	/** How many times `method` was called. */
	of(method: StorageMethodName): number;
	/** The ids `method` was called with, in order. */
	idsFor(method: StorageMethodName): string[];
	/** The largest number of calls that were in flight at once. */
	peakConcurrency(): number;
}

/** A collection that counts what it was asked, and a handle to read the tally. */
export interface CountingCollection<T> {
	readonly collection: StorageCollection<T>;
	readonly counts: CallCounts;
}

/**
 * Count the calls a collection receives, delegating every one of them for real.
 *
 * This is how a query-count invariant is pinned on a document store. The SQL
 * adapters could count ROOT STATEMENTS through a Kysely plugin and assert "exactly
 * one for a batch of N"; here the unit is a storage-port call, and what a batch
 * read must not do is issue one per id. The tally also records PEAK CONCURRENCY,
 * because "no round trip per row" is the property that actually matters and a
 * sequential `for await` loop over N reads would pass a pure count assertion while
 * paying N latencies.
 */
export function countingCollection<T>(raw: StorageCollection<T>): CountingCollection<T> {
	const calls = new Map<StorageMethodName, string[]>();
	let inFlight = 0;
	let peak = 0;
	const record = (method: StorageMethodName, id: string): void => {
		const seen = calls.get(method) ?? [];
		seen.push(id);
		calls.set(method, seen);
	};
	const track = async <R>(method: StorageMethodName, id: string, run: () => Promise<R>) => {
		record(method, id);
		inFlight++;
		peak = Math.max(peak, inFlight);
		try {
			return await run();
		} finally {
			inFlight--;
		}
	};
	return {
		collection: delegatingCollection(raw, {
			get: (id) => track("get", id, () => raw.get(id)),
			getVersioned: (id) => track("getVersioned", id, () => raw.getVersioned(id)),
			query: (options) => track("query", "", () => raw.query(options)),
			count: (where) => track("count", "", () => raw.count(where)),
			put: (id, data) => track("put", id, () => raw.put(id, data)),
			compareAndSet: (id, revision, data) =>
				track("compareAndSet", id, () => raw.compareAndSet(id, revision, data)),
			updateIf: (id, args) => track("updateIf", id, () => raw.updateIf(id, args)),
		}),
		counts: {
			of: (method) => calls.get(method)?.length ?? 0,
			idsFor: (method) => [...(calls.get(method) ?? [])],
			peakConcurrency: () => peak,
		},
	};
}
