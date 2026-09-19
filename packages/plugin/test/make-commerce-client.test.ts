/**
 * `makeCommerceClient` — the single composition root every storefront, sync and
 * entitlement route goes through to obtain a `CommerceClient`.
 *
 * INC-D3a retired the http/in-process mode branch outright: `HttpCommerceClient`,
 * `COMMERCE_SERVICE_BASE_URL`, `SERVICE_TOKEN_KEY` and `makeCommerceClientFor`
 * are all gone from `src/`, and `makeCommerceClient` unconditionally builds the
 * in-process client. This suite is therefore about the ONE shape that remains:
 * which class the factory returns, that it spans the whole port, and that a
 * context with no document store fails at construction rather than several
 * frames later inside a storefront route.
 */

import { describe, expect, test } from "vitest";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import { InProcessCommerceClient } from "../src/commerce/in-process-commerce-client.js";
import { MISSING_STORAGE_MESSAGE } from "../src/commerce/in-process-commerce-stores.js";
import { makeCommerceClient } from "../src/commerce/make-commerce-client.js";
import type { PluginContext } from "../src/types.js";
import type { StorageAccess, StorageCollection } from "@otta-sh/store-emdash";

/**
 * A document store that EXISTS and is never used. This file is about which
 * client the factory returns, not about commerce behaviour, which the client
 * contract's in-process tier covers against a real store. So every collection
 * the deployment declares is present (the in-process composition asks for each
 * by name and fails loudly on a missing one) and every method refuses, so a
 * case that quietly started doing commerce here would fail rather than pass.
 */
function refuseStorageCall(): never {
	throw new Error("this suite asserts client selection, never commerce behaviour");
}

function makeUnusedStorage(): StorageAccess {
	const collection = new Proxy({} as StorageCollection, { get: () => refuseStorageCall });
	return Object.fromEntries(
		Object.keys(COMMERCE_STORAGE_COLLECTIONS).map((name) => [name, collection]),
	);
}

function makeCtx(): { ctx: PluginContext } {
	const ctx: PluginContext = {
		storage: makeUnusedStorage(),
		http: {
			async fetch(): Promise<Response> {
				throw new Error("this suite asserts client selection, never egress");
			},
		},
		kv: {
			async get<T>(): Promise<T | null> {
				return null;
			},
			async set(): Promise<void> {
				// no-op
			},
			async delete(): Promise<boolean> {
				return false;
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [];
			},
		},
	};
	return { ctx };
}

describe("makeCommerceClient", () => {
	test("returns the in-process client", async () => {
		const { ctx } = makeCtx();
		const client = await makeCommerceClient(ctx);
		expect(client).toBeInstanceOf(InProcessCommerceClient);
	});

	test("the client spans the whole port — 25 methods, none of them a stub's", async () => {
		const { ctx } = makeCtx();
		const client = await makeCommerceClient(ctx);
		const methods = [...Object.getOwnPropertyNames(Object.getPrototypeOf(client))].filter(
			(name) => name !== "constructor",
		);
		// `typecheck` fails first if the port grows and the client does not, but the
		// count is asserted here too so a silently-dropped method cannot pass.
		expect(methods.length).toBe(25);
		for (const name of methods) {
			expect(typeof (client as unknown as Record<string, unknown>)[name], name).toBe("function");
		}
	});

	test("a context with NO document store fails at construction, naming what is missing", async () => {
		const { ctx } = makeCtx();
		const { storage: _storage, ...withoutStorage } = ctx;
		await expect(makeCommerceClient(withoutStorage)).rejects.toThrow(MISSING_STORAGE_MESSAGE);
	});
});
