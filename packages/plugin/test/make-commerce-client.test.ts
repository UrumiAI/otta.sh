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
import { NotImplementedError } from "../src/commerce/in-process-commerce-client.js";
import { makeCommerceClient, makeCommerceClientFor } from "../src/commerce/make-commerce-client.js";
import { COMMERCE_SERVICE_BASE_URL, SERVICE_TOKEN_KEY } from "../src/manifest.js";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import type { PluginContext } from "../src/types.js";

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

describe("makeCommerceClient — in-process mode (stub until a later increment)", () => {
	test("returns the in-process stub, and reads NO service token", async () => {
		const { ctx, kvReads } = makeCtx({ [SERVICE_TOKEN_KEY]: "SVC-write-gate" });
		const client = await makeCommerceClientFor(ctx, "in-process");
		expect(client).not.toBeInstanceOf(HttpCommerceClient);
		// There is no service to authenticate to, so the kv read must not happen.
		expect(kvReads).toEqual([]);
	});

	test("EVERY method throws NotImplementedError", async () => {
		const { ctx } = makeCtx();
		const client = await makeCommerceClientFor(ctx, "in-process");
		const methods = [...Object.getOwnPropertyNames(Object.getPrototypeOf(client))].filter(
			(name) => name !== "constructor",
		);

		// The stub must cover the whole port — if the interface grows and the
		// stub does not, `typecheck` fails first, but assert the count here too
		// so a silently-dropped method cannot pass as "all methods throw".
		expect(methods.length).toBe(25);

		for (const name of methods) {
			const fn = (client as unknown as Record<string, () => unknown>)[name];
			expect(typeof fn, name).toBe("function");
			// Sync throw or rejected promise — either is acceptable; assert the
			// typed error either way.
			let thrown: unknown;
			try {
				await (fn as (...args: unknown[]) => unknown).call(client);
			} catch (err) {
				thrown = err;
			}
			expect(thrown, name).toBeInstanceOf(NotImplementedError);
			expect((thrown as Error).message, name).toBe(
				"in-process commerce client lands in a later increment",
			);
		}
	});
});
