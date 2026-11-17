/**
 * A real plugin context for driving MCP tool routes: the plugin's declared
 * commerce collections over in-memory SQLite, built by the adapter package's own
 * dialect harness (the host's migrations, so the revision triggers a guarded
 * write compares against exist). Real databases, never mocks.
 *
 * `ctx.http` REJECTS and COUNTS: an admin tool that reached for egress without a
 * gateway configured must fail its case rather than quietly work.
 */
import {
	COMMERCE_STORAGE_COLLECTIONS,
	type KvAccess,
	type PluginContext,
} from "@urumi.ai/otta-plugin";
import { makeSqliteStorage, type StorageLayout } from "@urumi.ai/otta-store-emdash/testing";

export interface AdminHarness {
	readonly ctx: PluginContext;
	egressAttempts(): number;
	/** Empty the rows, keep the schema (and its triggers). */
	reset(): Promise<void>;
	close(): Promise<void>;
}

function copy(index: string | readonly string[]): string | string[] {
	return typeof index === "string" ? index : [...index];
}

/** The plugin's declared collections, in the shape the dialect harness takes. */
function storageLayout(): StorageLayout {
	return Object.fromEntries(
		Object.entries(COMMERCE_STORAGE_COLLECTIONS).map(([name, declaration]) => [
			name,
			{
				indexes: (declaration.indexes ?? []).map(copy),
				uniqueIndexes: (declaration.uniqueIndexes ?? []).map(copy),
			},
		]),
	);
}

function makeKv(): KvAccess {
	const store = new Map<string, unknown>();
	return {
		async get<T>(key: string): Promise<T | null> {
			return store.has(key) ? (store.get(key) as T) : null;
		},
		async set(key: string, value: unknown): Promise<void> {
			store.set(key, value);
		},
		async delete(key: string): Promise<boolean> {
			return store.delete(key);
		},
		async list(prefix?: string): Promise<Array<{ key: string; value: unknown }>> {
			return [...store]
				.filter(([key]) => prefix === undefined || key.startsWith(prefix))
				.map(([key, value]) => ({ key, value }));
		},
	};
}

export async function makeAdminHarness(): Promise<AdminHarness> {
	const db = await makeSqliteStorage(storageLayout());
	let egress = 0;
	const ctx: PluginContext = {
		http: {
			fetch(): Promise<Response> {
				egress += 1;
				return Promise.reject(new Error("no HTTP request is expected; nothing may call ctx.http"));
			},
		},
		kv: makeKv(),
		storage: db.storage,
	};
	return {
		ctx,
		egressAttempts: () => egress,
		reset: () => db.reset(),
		close: () => db.close(),
	};
}
