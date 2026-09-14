/**
 * `makeCommerceClient` — the single composition root every storefront, sync and
 * entitlement route now goes through to obtain a `CommerceClient`.
 *
 * TRANSITIONAL. The mode branch asserted here, `__OTTA_COMMERCE_MODE__`,
 * `resolveCommerceMode`, `COMMERCE_SERVICE_BASE_URL`, `HttpCommerceClient` and
 * the four admin HTTP clients are ALL DELETED at INC-D3b. The branch exists
 * only so the extracted client contract can be run against both
 * implementations before the HTTP one is removed.
 *
 * The http assertions are deliberately about BEHAVIOUR, not just the
 * constructor: INC-A6 must be behaviour-neutral, so the factory has to produce
 * exactly what the hand-rolled constructions produced — the same base
 * URL, `ctx.http.fetch` as the only egress, and the ADR-0007 write-gate token
 * read from write-only kv (absent kv ⇒ NO header ⇒ byte-identical wire).
 */

import { describe, expect, test } from "vitest";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import { InProcessCommerceClient } from "../src/commerce/in-process-commerce-client.js";
import { MISSING_STORAGE_MESSAGE } from "../src/commerce/in-process-commerce-stores.js";
import { makeCommerceClient, makeCommerceClientFor } from "../src/commerce/make-commerce-client.js";
import { COMMERCE_SERVICE_BASE_URL, SERVICE_TOKEN_KEY } from "../src/manifest.js";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import type { PluginContext } from "../src/types.js";
import type { StorageAccess, StorageCollection } from "@otta-sh/store-emdash";

/**
 * A document store that EXISTS and is never used. This file is about which client
 * the factory returns and which credential it reads on the way — not about
 * commerce behaviour, which the client contract's in-process tier covers against
 * a real store. So every collection the deployment declares is present (the
 * in-process composition asks for each by name and fails loudly on a missing one)
 * and every method refuses, so a case that quietly started doing commerce here
 * would fail rather than pass.
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

interface Recorded {
	url: string;
	init: RequestInit | undefined;
}

function makeCtx(seed: Record<string, string> = {}): {
	ctx: PluginContext;
	requests: Recorded[];
	kvReads: string[];
} {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const requests: Recorded[] = [];
	const kvReads: string[] = [];
	const ctx: PluginContext = {
		storage: makeUnusedStorage(),
		http: {
			async fetch(url: string, init?: RequestInit): Promise<Response> {
				requests.push({ url, init });
				return new Response(JSON.stringify({ ok: true, cartId: "c1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		},
		kv: {
			async get<T>(k: string): Promise<T | null> {
				kvReads.push(k);
				return kv.has(k) ? (kv.get(k) as T) : null;
			},
			async set(k: string, v: unknown): Promise<void> {
				kv.set(k, v);
			},
			async delete(k: string): Promise<boolean> {
				return kv.delete(k);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...kv].map(([key, value]) => ({ key, value }));
			},
		},
	};
	return { ctx, requests, kvReads };
}

describe("makeCommerceClient — http mode (today's only mode)", () => {
	test("returns an HttpCommerceClient", async () => {
		const { ctx } = makeCtx();
		expect(await makeCommerceClientFor(ctx, "http")).toBeInstanceOf(HttpCommerceClient);
	});

	test("the no-arg factory takes the http branch in this un-defined build", async () => {
		// No bundler defines `__OTTA_COMMERCE_MODE__` under vitest, so the
		// default must hold — this is what keeps every pre-existing suite green.
		const { ctx } = makeCtx();
		expect(await makeCommerceClient(ctx)).toBeInstanceOf(HttpCommerceClient);
	});

	test("egress is ctx.http.fetch at COMMERCE_SERVICE_BASE_URL, never the ambient global", async () => {
		const { ctx, requests } = makeCtx();
		const client = await makeCommerceClient(ctx);
		await client.createCart("USD");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url.startsWith(`${COMMERCE_SERVICE_BASE_URL}/`)).toBe(true);
	});

	test("forwards the ADR-0007 write-gate token from write-only kv", async () => {
		const { ctx, requests, kvReads } = makeCtx({ [SERVICE_TOKEN_KEY]: "SVC-write-gate" });
		const client = await makeCommerceClient(ctx);
		await client.createCart("USD");
		expect(kvReads).toContain(SERVICE_TOKEN_KEY);
		const headers = requests[0]?.init?.headers as Record<string, string> | undefined;
		expect(headers?.["X-Service-Token"]).toBe("SVC-write-gate");
	});

	test("an UNSET token attaches no header at all (byte-identical pre-gate wire)", async () => {
		const { ctx, requests } = makeCtx();
		const client = await makeCommerceClient(ctx);
		await client.createCart("USD");
		const headers = (requests[0]?.init?.headers ?? {}) as Record<string, string>;
		expect(Object.keys(headers)).not.toContain("X-Service-Token");
	});
});

describe("makeCommerceClient — in-process mode", () => {
	test("returns the in-process client, and reads NO service token", async () => {
		const { ctx, kvReads } = makeCtx({ [SERVICE_TOKEN_KEY]: "SVC-write-gate" });
		const client = await makeCommerceClientFor(ctx, "in-process");
		expect(client).toBeInstanceOf(InProcessCommerceClient);
		expect(client).not.toBeInstanceOf(HttpCommerceClient);
		// There is no service to authenticate to, so the kv read must not happen.
		expect(kvReads).toEqual([]);
	});

	test("the client spans the whole port — 25 methods, none of them the stub's", async () => {
		const { ctx } = makeCtx();
		const client = await makeCommerceClientFor(ctx, "in-process");
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
		await expect(makeCommerceClientFor(withoutStorage, "in-process")).rejects.toThrow(
			MISSING_STORAGE_MESSAGE,
		);
	});
});
