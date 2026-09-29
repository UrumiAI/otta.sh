/**
 * Where the emailed magic link points (issue #306) — `storefront/login-link.ts`.
 * The base is the operator's configured storefront URL, else the request's own
 * origin, and NEVER anything a caller supplies.
 */
import { describe, expect, test } from "vitest";
import {
	loginLinkUrl,
	resolveLoginLinkBase,
	STOREFRONT_BASE_URL_KEY,
} from "../src/storefront/login-link.js";
import type { KvAccess, PluginContext } from "../src/types.js";

function ctxWithKv(
	values: Record<string, unknown>,
	opts: { failing?: boolean } = {},
): PluginContext {
	const kv: KvAccess = {
		async get<T>(key: string): Promise<T | null> {
			if (opts.failing === true) throw new Error("kv down");
			return (values[key] as T | undefined) ?? null;
		},
		async set() {},
		async delete() {
			return false;
		},
		async list() {
			return [];
		},
	};
	return {
		http: { fetch: () => Promise.reject(new Error("no egress")) },
		kv,
	};
}

const REQUEST = { url: "https://shop.example.test/_emdash/api/plugins/otta/storefront/x?y=1" };

describe("resolveLoginLinkBase", () => {
	test("defaults to the ORIGIN of the request the route was invoked with", async () => {
		expect(await resolveLoginLinkBase(ctxWithKv({}), REQUEST)).toBe("https://shop.example.test");
	});

	test("a configured storefront URL wins, keeping its path prefix and dropping a trailing slash", async () => {
		const ctx = ctxWithKv({ [STOREFRONT_BASE_URL_KEY]: "https://www.brand.example/shop/" });
		expect(await resolveLoginLinkBase(ctx, REQUEST)).toBe("https://www.brand.example/shop");
	});

	test("a malformed or non-http configured value is ignored, not trusted", async () => {
		for (const bad of ["not a url", "javascript:alert(1)", "ftp://files.example/", ""]) {
			const ctx = ctxWithKv({ [STOREFRONT_BASE_URL_KEY]: bad });
			expect(await resolveLoginLinkBase(ctx, REQUEST)).toBe("https://shop.example.test");
		}
	});

	test("a kv outage falls through to the request origin rather than throwing", async () => {
		expect(await resolveLoginLinkBase(ctxWithKv({}, { failing: true }), REQUEST)).toBe(
			"https://shop.example.test",
		);
	});

	test("no configured value and no absolute request URL ⇒ undefined (nothing is sent)", async () => {
		expect(await resolveLoginLinkBase(ctxWithKv({}), { url: "/route/x" })).toBeUndefined();
		expect(await resolveLoginLinkBase(ctxWithKv({}), undefined)).toBeUndefined();
	});
});

describe("loginLinkUrl", () => {
	test("points at /account/verify with the challenge and the token, URL-encoded", () => {
		const url = new URL(loginLinkUrl("https://shop.example.test", "ch 1", "t+k/=="));
		expect(`${url.origin}${url.pathname}`).toBe("https://shop.example.test/account/verify");
		expect(url.searchParams.get("challenge")).toBe("ch 1");
		expect(url.searchParams.get("token")).toBe("t+k/==");
	});

	test("respects a base with a path prefix", () => {
		expect(loginLinkUrl("https://brand.example/shop", "c", "t")).toBe(
			"https://brand.example/shop/account/verify?challenge=c&token=t",
		);
	});
});
