/**
 * One in-process commerce client over a real document store, shared by every
 * suite that needs one: the client contract's in-process tier, its input-bound
 * cases, and the identity proofs beside it.
 *
 * WHAT IS REAL. The store is real — a per-collection repository on in-memory
 * SQLite, built by the adapter package's own dialect harness, which is where the
 * two rules that make it correct live (the schema comes from the host's
 * migrations, because the revision a guarded write compares is assigned by a
 * trigger only they create; rows are cleared between cases and the table is never
 * dropped, because dropping it would take the trigger with it). Real databases,
 * never mocks: no fake can lose a compare-and-set race.
 *
 * `ctx.http` REJECTS and COUNTS. In-process commerce makes no request, so a
 * method that reached for egress must fail its case rather than quietly work —
 * and a suite can assert on the count, which is what turns "sends no mail" from a
 * claim into a test.
 */
import type { Clock } from "@otta-sh/domain";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { InProcessCommerceClient } from "../../src/commerce/in-process-commerce-client.js";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
} from "../../src/commerce/in-process-commerce-stores.js";
import type { KvAccess, PluginContext } from "../../src/types.js";
import { commerceStorageLayout } from "../sandbox/storage-layout.js";

/** One migrated database and its collections, named off the harness function. */
type DialectStorage = Awaited<ReturnType<typeof makeSqliteStorage>>;

export interface InProcessCommerceHarness {
	readonly client: InProcessCommerceClient;
	/**
	 * A SECOND set of stores over the same document store and the same context, for
	 * a case that must seed or inspect state the port does not expose (a session,
	 * for instance). Not the client's own instances — it builds its own — and it
	 * does not need to be: the stores hold no state beyond the collections, so two
	 * sets over one store see exactly the same documents. Said plainly because the
	 * first version of this comment claimed they were the same objects.
	 */
	readonly stores: InProcessCommerceStores;
	readonly ctx: PluginContext;
	/**
	 * The clock every store in this harness shares — the caller's own instance when
	 * it passed one, so a suite that needs to move time forward moves THIS and both
	 * the client's stores and the harness's see it. Sharing one is not tidiness: a
	 * checkout stamps a hold deadline through one store and compares it through
	 * another, so two clocks would make hold expiry disagree with itself.
	 */
	readonly clock: Clock;
	/** How many times anything reached for egress. Always 0 in this transport. */
	egressAttempts(): number;
	/** Empty the rows, keep the schema (and its triggers). */
	reset(): Promise<void>;
	close(): Promise<void>;
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

export interface MakeInProcessCommerceOptions {
	/** A clock the caller keeps a handle on, for a suite whose subject is an
	 *  elapsed deadline. Omitted ⇒ real time, which is what a deployment gets. */
	clock?: Clock;
}

export async function makeInProcessCommerce(
	options: MakeInProcessCommerceOptions = {},
): Promise<InProcessCommerceHarness> {
	const db: DialectStorage = await makeSqliteStorage(commerceStorageLayout());
	let egress = 0;
	const ctx: PluginContext = {
		http: {
			fetch(): Promise<Response> {
				egress += 1;
				return Promise.reject(
					new Error("in-process commerce makes no HTTP request; nothing may call ctx.http"),
				);
			},
		},
		kv: makeKv(),
		storage: db.storage,
	};
	// ONE options object for both constructions, so the client's own stores and the
	// harness's second set share whatever clock the caller passed.
	const shared = options.clock !== undefined ? { clock: options.clock } : {};
	const stores = createInProcessCommerceStores(ctx, shared);
	return {
		client: new InProcessCommerceClient(ctx, shared),
		stores,
		ctx,
		clock: stores.clock,
		egressAttempts: () => egress,
		reset: () => db.reset(),
		close: () => db.close(),
	};
}
