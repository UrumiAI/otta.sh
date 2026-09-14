/**
 * The in-process tier of `commerceClientContract`.
 *
 * This file binds the transport-agnostic contract to `InProcessCommerceClient`
 * over a REAL document store: the host's own `PluginStorageRepository` on
 * in-memory SQLite, migrated by the host's own migration set. There is no
 * commerce service in this tier, no HTTP server, and no `fetch` — `ctx.http` is
 * bound to a rejecting stub precisely so a method that reached for egress would
 * fail the suite rather than quietly work.
 *
 * WHY THE SAME CASES, UNCHANGED. The contract is the equivalence proof: the
 * cases were lifted out of the HTTP client's own suites so both transports can
 * execute them, and the value of that evaporates the moment a tier narrows,
 * skips or reorders one. A case that fails here is a composition or an adapter
 * defect, never a case to soften.
 *
 * WHAT IS REAL AND WHAT IS NOT. The document store is real — real databases,
 * never mocks, because no fake can lose a compare-and-set race — and it is built
 * by the ADAPTER PACKAGE's own dialect harness rather than by a second copy of
 * that wiring here. That matters for more than duplication: the harness is where
 * the two rules the store depends on are stated and enforced (the schema always
 * comes from the host's migrations, because the revision a guarded write compares
 * is assigned by a trigger only they create; rows are cleared between cases and
 * the table is never dropped, because dropping it would take the trigger with
 * it). Keeping the host, `kysely` and `better-sqlite3` imports inside that
 * package is also what keeps them out of this one, which declares no dependency
 * on the host in any form.
 *
 * Rows ARE cleared per case here, which is what makes `reset()` a real reset in
 * this tier rather than the documented no-op the HTTP tier implements.
 */
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { afterAll, describe } from "vitest";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";
import { InProcessCommerceClient } from "../src/commerce/in-process-commerce-client.js";
import type { CommerceClient } from "../src/product-commerce/commerce-client.js";
import type { KvAccess, PluginContext } from "../src/types.js";
import {
	storefrontCommerceClientContract,
	type CommerceClientTier,
} from "./contracts/commerce-client-contract.js";

/** One migrated database and its collections, as the dialect harness hands them
 *  over — named off the function rather than restated. */
type DialectStorage = Awaited<ReturnType<typeof makeSqliteStorage>>;

/** A kv the plugin never reaches for in this mode — present because `ctx` has one. */
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

/**
 * The in-process tier. `arrange` programs state through the client's own writes,
 * exactly as the HTTP tier does — so the two tiers seed identically and a
 * difference in a case's outcome can only come from the transport under test.
 */
function inProcessTier(): CommerceClientTier {
	let db: DialectStorage | undefined;
	let client: CommerceClient | undefined;

	function clientOrThrow(): CommerceClient {
		if (client === undefined) throw new Error("tier not set up");
		return client;
	}

	return {
		name: "in-process, plugin storage, sqlite",
		async setup() {
			if (db !== undefined) return; // one database per tier, however many slices ask
			const opened = await makeSqliteStorage(commerceStorageLayout());
			db = opened;
			const ctx: PluginContext = {
				http: {
					fetch(): Promise<Response> {
						return Promise.reject(
							new Error("in-process commerce makes no HTTP request; nothing may call ctx.http"),
						);
					},
				},
				kv: makeKv(),
				storage: opened.storage,
			};
			client = new InProcessCommerceClient(ctx);
		},
		async teardown() {
			const open = db;
			db = undefined;
			client = undefined;
			await open?.close();
		},
		async reset() {
			// A REAL reset, unlike the HTTP tier's documented no-op, and the harness's
			// own: it empties the rows and keeps the schema, which is the only form of
			// reset that keeps the revision trigger the guarded writes depend on.
			await db?.reset();
		},
		async makeClient() {
			return clientOrThrow();
		},
		arrange: {
			async product(spec) {
				await clientOrThrow().upsertProductCommerce(
					spec.productId,
					{
						sku: spec.sku,
						...(spec.price !== undefined ? { price: spec.price } : {}),
						...(spec.title !== undefined ? { title: spec.title } : {}),
						...(spec.onHand !== undefined ? { initialOnHand: spec.onHand } : {}),
					},
					spec.idempotencyKey,
				);
				return spec.productId;
			},
			async cart(currency) {
				const { cartId } = await clientOrThrow().createCart(currency);
				return cartId;
			},
		},
	};
}

const storefront = inProcessTier();

describe("commerceClientContract over InProcessCommerceClient", () => {
	afterAll(async () => {
		await storefront.teardown();
	});
	storefrontCommerceClientContract(storefront);
});
