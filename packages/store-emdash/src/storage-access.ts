/**
 * The structural seam between Otta's commerce adapters and EmDash's
 * plugin-storage primitives.
 *
 * Nothing in this package's `src/` executes host code. The adapters are written
 * against the interfaces below, and the caller supplies the implementation:
 *
 * - **In production** the plugin injects `ctx.storage` — the host's own
 *   per-collection storage bridge, built from the descriptor's declared
 *   collections.
 * - **In tests** `test/describe-each-dialect.ts` injects real
 *   `PluginStorageRepository` instances over better-sqlite3 and Postgres. Real
 *   databases, never mocks: a fake cannot lose a `compareAndSet` race.
 *
 * That seam is what makes swapping the vendored host build for an npm release an
 * *override* edit rather than an adapter rewrite — no adapter names a host
 * runtime symbol, and the depcruise rule `store-emdash-is-sandbox-clean`
 * enforces that rather than trusting it.
 *
 * `StorageCollection` below is Otta's own port: exactly the nine methods the
 * adapters use, so a host method we never call cannot become a dependency by
 * accident. The *data shapes* it is written in terms of are `import type`d from
 * the host (a type import emits no code) rather than hand-mirrored — a second
 * copy of the filter algebra and of the conditional-write result union would be
 * drift surface with no safety to show for it. The two error shapes the host
 * does not export are restated, and say so.
 */
import type {
	ConditionalDeleteResult,
	ConditionalWriteResult,
	NumericDelta,
	StorageCollection as HostStorageCollection,
	UpdateIfArgs,
	UpdateIfResult,
	VersionedValue,
} from "emdash";

export type {
	ConditionalDeleteResult,
	ConditionalWriteResult,
	NumericDelta,
	UpdateIfArgs,
	UpdateIfResult,
};

/**
 * `{ value, revision }` as returned by `getVersioned`. The revision is an opaque
 * string, valid only for the id it was read from.
 */
export type Versioned<T> = VersionedValue<T>;

/**
 * The host's `where` algebra: field → scalar, range, `in` set, or prefix. It is
 * DERIVED from the exported collection interface rather than imported by name,
 * because the host does not export `WhereClause` (and exports an unrelated
 * `WhereValue` for content loaders, which is not this one).
 */
export type WhereClause = NonNullable<Parameters<HostStorageCollection["count"]>[0]>;

/** A single `where` predicate: a scalar, a range, an `in` set, or a prefix. */
export type WhereValue = WhereClause[string];

/** `query`'s options — `where`, `orderBy`, `limit`, `cursor`. Derived, as above. */
export type QueryOptions = NonNullable<Parameters<HostStorageCollection["query"]>[0]>;

/** `query`'s ordering argument — a field-to-direction map. */
export type OrderBy = NonNullable<QueryOptions["orderBy"]>;

/** What `query` resolves to: a page of `{ id, data }` plus its cursor. */
export type QueryResult<T> = Awaited<ReturnType<HostStorageCollection<T>["query"]>>;

/**
 * One document collection. Every method is a single statement against one row
 * or one index — there is no transaction and no `SELECT … FOR UPDATE`, which is
 * why the conditional-write trio is the only atomicity primitive Otta has here.
 */
export interface StorageCollection<T = unknown> {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	delete(id: string): Promise<boolean>;
	/**
	 * A page of documents. `where` and `orderBy` may name only fields the
	 * collection declared as indexes — anything else throws
	 * {@link StorageQueryError}. `limit` is clamped by the host (50 default, 100
	 * ceiling), so a caller that needs more must page with `cursor`.
	 */
	query(options?: QueryOptions): Promise<QueryResult<T>>;
	count(where?: WhereClause): Promise<number>;
	/**
	 * Predicate-guarded atomic update: one guarded `UPDATE … RETURNING`, so N
	 * concurrent guarded decrements serialize correctly. `applied: false` means
	 * the row was absent OR the guard failed — deliberately indistinguishable.
	 * Never inserts, and never clamps: pair a `dec: k` with a `gte: k` guard.
	 * A retryable abort throws {@link StorageSerializationError}.
	 */
	updateIf(id: string, args: UpdateIfArgs<T>): Promise<UpdateIfResult<T>>;
	/** A stored JSON `null` returns `{ value: null }`; only an absent row is `null`. */
	getVersioned(id: string): Promise<Versioned<T> | null>;
	/**
	 * Compare-and-set on the opaque revision. A `null` expected revision is a
	 * DB-level create-if-absent (`INSERT … ON CONFLICT DO NOTHING RETURNING`),
	 * not a read-then-insert, so it is race-safe. Returns the NEW revision on
	 * success, so a bounded retry costs one round trip per attempt.
	 */
	compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: T,
	): Promise<ConditionalWriteResult>;
	compareAndDelete(id: string, expectedRevision: string): Promise<ConditionalDeleteResult>;
}

/**
 * The collections a store adapter was given, keyed by declared collection name.
 * This is the shape of the host's `ctx.storage` and the shape the dialect
 * harness builds out of `PluginStorageRepository` instances — one type, both
 * tiers, which is the whole point of the seam.
 */
export type StorageAccess = Record<string, StorageCollection>;

/**
 * The retryable abort a guarded write can throw: Postgres `40001`
 * (serialization failure) or `40P01` (deadlock). The host throws its own
 * `StorageSerializationError` class; Otta matches it structurally rather than by
 * `instanceof`, because the adapters must not import host code — and because an
 * error crossing the sandbox bridge arrives as a plain object carrying these
 * fields, not as an instance of anything.
 *
 * The no-oversell safety property holds either way: a losing writer never
 * applies its update. It either sees `{ applied: false }` or throws this.
 */
export interface StorageSerializationError extends Error {
	readonly code: "STORAGE_SERIALIZATION_FAILURE";
	readonly retryable: true;
	/** The Postgres SQLSTATE behind the abort, when the host knows it. */
	readonly sqlState?: string;
}

/** Structural test for the retryable abort above — survives the bridge. */
export function isStorageSerializationError(err: unknown): err is StorageSerializationError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "STORAGE_SERIALIZATION_FAILURE"
	);
}

/**
 * What a `where`/`orderBy` on a field the collection never declared as an index
 * throws, and what a malformed filter throws. The host does not export the
 * class, so the shape is restated: `name` is the contract, `field` and
 * `suggestion` are the host's diagnostics.
 *
 * This is a programming error, not a runtime condition — the fix is to declare
 * the index, which is why the declared index lists are part of the read
 * contract rather than a performance knob.
 */
export interface StorageQueryError extends Error {
	readonly name: "StorageQueryError";
	readonly field?: string;
	readonly suggestion?: string;
}

/** Structural test for the non-indexed-field error above. */
export function isStorageQueryError(err: unknown): err is StorageQueryError {
	return err instanceof Error && err.name === "StorageQueryError";
}
