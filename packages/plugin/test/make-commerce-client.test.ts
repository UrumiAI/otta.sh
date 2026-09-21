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
import {
	EMAIL_API_KEY_KEY,
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	X402_FACILITATOR_API_KEY_KEY,
} from "../src/payment-secrets.js";
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

/**
 * A RECORDING kv, not a null-returning stub.
 *
 * `ctx.kv` is a live CREDENTIAL store (`payment-secrets.ts`: the Stripe secret
 * key, the Stripe webhook secret, the email API key and the x402 facilitator
 * credential all live there under `settings:*`). A stub that simply answered
 * `null` would let an eager read at construction pass unnoticed — so every key
 * read is recorded, which keeps "building a client reads no credential" an
 * assertion rather than an assumption.
 */
function makeCtx(seed: Record<string, string> = {}): {
	ctx: PluginContext;
	kvReads: string[];
} {
	const store = new Map<string, unknown>(Object.entries(seed));
	const kvReads: string[] = [];
	const ctx: PluginContext = {
		storage: makeUnusedStorage(),
		http: {
			async fetch(): Promise<Response> {
				throw new Error("this suite asserts client selection, never egress");
			},
		},
		kv: {
			async get<T>(key: string): Promise<T | null> {
				kvReads.push(key);
				return store.has(key) ? (store.get(key) as T) : null;
			},
			async set(key: string, value: unknown): Promise<void> {
				store.set(key, value);
			},
			async delete(key: string): Promise<boolean> {
				return store.delete(key);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...store].map(([key, value]) => ({ key, value }));
			},
		},
	};
	return { ctx, kvReads };
}

describe("makeCommerceClient", () => {
	test("returns the in-process client, and reads NO credential from kv", async () => {
		// SEEDED, so a read would be a read of something real: if the composition
		// root ever starts reaching for a payment credential merely to build a
		// client, the recorded key names it.
		const { ctx, kvReads } = makeCtx({
			[STRIPE_SECRET_KEY_KEY]: "sk_test_NEVER_READ",
			[STRIPE_WEBHOOK_SECRET_KEY]: "whsec_NEVER_READ",
			[EMAIL_API_KEY_KEY]: "email_NEVER_READ",
			[X402_FACILITATOR_API_KEY_KEY]: "x402_NEVER_READ",
		});
		const client = await makeCommerceClient(ctx);
		expect(client).toBeInstanceOf(InProcessCommerceClient);
		// There is no service left to authenticate to, and the x402 wiring
		// short-circuits on an unconfigured facilitator URL BEFORE it touches kv —
		// so construction is credential-free, and an eager read fails here.
		expect(kvReads).toEqual([]);
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
