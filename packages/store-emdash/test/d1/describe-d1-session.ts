/**
 * The **D1 session** harness: storage built over a Sessions-API handle, the way
 * EmDash hands one to the plugin on a request under `session: "primary-first"`
 * (`sites/staging/src/emdash-options.ts`).
 *
 * It does not re-implement the wiring. The host's own `createRequestScopedDb` —
 * the function EmDash's request middleware calls once per request — builds the
 * Kysely instance: `binding.withSession("first-primary")`, wrapped in the host's
 * hang guard, behind the `EmDashD1Dialect`. Plugin storage is then constructed
 * over that Kysely exactly as `describe-d1.ts` does over the singleton, so the
 * only thing that differs between the two tiers is the handle the SQL travels on.
 * `commit()` is the host's response-path hook; for an authenticated request it
 * writes the session bookmark into a cookie, which is also how a test can tell the
 * statements really rode a session.
 *
 * WHAT THIS DOES NOT PROVE. Miniflare's D1 supports `withSession()` and mints
 * bookmarks, but it has NO read replicas: every read is served by the one
 * database, so no read can come back stale. This tier shows that the storage
 * paths run correctly over a session handle (the statements the adapters issue
 * are accepted, ordered and applied through it). It cannot show replica lag. A
 * staging check against a real replicated database is still required before read
 * replication is turned on.
 */
import { createRequestScopedDb } from "@emdash-cms/cloudflare/db/d1";
import { PluginStorageRepository } from "emdash";
import type { runMigrations } from "emdash/db";
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { StorageAccess, StorageCollection } from "../../src/index.js";
import { collectionOf } from "../../src/index.js";
import { openD1, type StorageLayout } from "./describe-d1.js";

/** The schema is the host's — name its own database type rather than restate it. */
type HostDb = Parameters<typeof runMigrations>[0];

/** The cookie the host stores the session bookmark in (its default name). */
export const BOOKMARK_COOKIE = "__em_d1_bookmark";

/** The plugin id every harness collection is namespaced under (as `describe-d1.ts`). */
const PLUGIN_ID = "otta";

/** What a request is, to the session middleware. */
export interface RequestShape {
	/** A mutating request: the host pins it to the primary. Default false. */
	isWrite?: boolean;
	/** An authenticated request commits its bookmark to the cookie. Default true. */
	isAuthenticated?: boolean;
	/** The bookmark cookie the browser sent, if any. */
	bookmark?: string;
}

/** One request's storage, all of it behind ONE D1 session. */
export interface D1SessionRequest {
	readonly storage: StorageAccess;
	/** One collection, typed to the document it holds. */
	collection<T>(name: string): StorageCollection<T>;
	/** Run the host's response-path hook; returns the bookmark it stored, if any. */
	commit(): string | undefined;
}

export interface D1SessionStorage {
	/** Open a request-scoped session, as the host middleware does per request. */
	request(shape?: RequestShape): D1SessionRequest;
}

/**
 * The config the staging site declares. Keep in sync with
 * `sites/staging/src/emdash-options.ts`: a change there (`coalesce`, `"auto"`)
 * would otherwise leave this tier testing a different setup than the site runs.
 */
const CONFIG = { binding: "DB", session: "primary-first" } as const;

function openRequest(layout: StorageLayout, shape: RequestShape): D1SessionRequest {
	const cookies = new Map<string, string>();
	if (shape.bookmark !== undefined) cookies.set(BOOKMARK_COOKIE, shape.bookmark);
	const scoped = createRequestScopedDb({
		config: CONFIG,
		isWrite: shape.isWrite ?? false,
		isAuthenticated: shape.isAuthenticated ?? true,
		cookies: {
			get: (name) => {
				const value = cookies.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name, value) => void cookies.set(name, value),
		},
		url: new URL("https://store.example/"),
	});
	// `null` means the binding has no `withSession` or sessions are disabled; a test
	// over the plain binding would pass for the wrong reason, so refuse to run.
	if (scoped === null) throw new Error("the D1 binding did not hand out a session");
	const db = scoped.db as HostDb;
	const storage: StorageAccess = {};
	for (const [name, config] of Object.entries(layout)) {
		// The same composed allow-list `describe-d1.ts` passes: indexes AND unique indexes.
		const indexes = [...(config.indexes ?? []), ...(config.uniqueIndexes ?? [])];
		storage[name] = new PluginStorageRepository(db, PLUGIN_ID, name, indexes);
	}
	return {
		storage,
		collection<T>(name: string): StorageCollection<T> {
			return collectionOf<T>(storage, name);
		},
		commit() {
			scoped.commit();
			return cookies.get(BOOKMARK_COOKIE);
		},
	};
}

/**
 * Call once at the top of a suite file. Migrates the file's database over the
 * plain binding (a session is for requests, not for schema), empties the storage
 * table before each case, and hands out request-scoped sessions on demand.
 */
export function useD1SessionStorage(layout: StorageLayout): D1SessionStorage {
	let open: Awaited<ReturnType<typeof openD1>> | undefined;
	beforeAll(async () => {
		open = await openD1(layout);
	});
	beforeEach(async () => {
		await open?.reset();
	});
	afterAll(async () => {
		const held = open;
		open = undefined;
		await held?.close();
	});
	return {
		request(shape = {}) {
			if (open === undefined) throw new Error("sessions are only available inside a test");
			return openRequest(layout, shape);
		},
	};
}
