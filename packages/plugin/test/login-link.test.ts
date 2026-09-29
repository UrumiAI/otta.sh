/**
 * Where the emailed magic link points (issue #306) — `storefront/login-link.ts`.
 *
 * The link is the operator's CONFIGURED sign-in page (`settings:loginLinkUrl`)
 * and nothing else: there is no fallback to the request origin, which a host
 * that does not pin `Host` would let an attacker spoof. Unset or invalid ⇒ no
 * link at all. (Setting and validation adapted from #325 by @stephanedemotte.)
 */
import { describe, expect, test } from "vitest";
import {
	isValidLoginLinkUrl,
	LOGIN_LINK_URL_KEY,
	loginLinkUrl,
	resolveLoginLinkUrl,
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

describe("isValidLoginLinkUrl", () => {
	test.each([
		"https://shop.example/account/verify",
		"http://localhost:4321/account/verify",
		"https://brand.example/shop/account/verify?src=mail",
	])("accepts %s", (url) => {
		expect(isValidLoginLinkUrl(url)).toBe(true);
	});

	test.each([
		["a relative path", "/account/verify"],
		["a javascript: URL", "javascript:alert(1)"],
		["a non-http scheme", "ftp://files.example/verify"],
		["a username and password", "https://user:pw@shop.example/verify"],
		["a username alone", "https://user@shop.example/verify"],
		["garbage", "not a url"],
		["empty", ""],
	])("refuses %s", (_what, url) => {
		expect(isValidLoginLinkUrl(url)).toBe(false);
	});
});

describe("resolveLoginLinkUrl", () => {
	test("is the configured sign-in page", async () => {
		const ctx = ctxWithKv({ [LOGIN_LINK_URL_KEY]: "https://www.brand.example/account/verify" });
		expect(await resolveLoginLinkUrl(ctx)).toBe("https://www.brand.example/account/verify");
	});

	test("is undefined when nothing is configured — there is NO request-origin fallback", async () => {
		expect(await resolveLoginLinkUrl(ctxWithKv({}))).toBeUndefined();
	});

	test("is undefined for a stored value that fails validation", async () => {
		for (const bad of ["/account/verify", "https://u:p@shop.example/v", "javascript:alert(1)"]) {
			expect(await resolveLoginLinkUrl(ctxWithKv({ [LOGIN_LINK_URL_KEY]: bad }))).toBeUndefined();
		}
	});

	test("a kv outage is undefined rather than a throw", async () => {
		expect(await resolveLoginLinkUrl(ctxWithKv({}, { failing: true }))).toBeUndefined();
	});
});

describe("loginLinkUrl", () => {
	test("appends the challenge and the token, URL-encoded", () => {
		const url = new URL(loginLinkUrl("https://shop.example.test/account/verify", "ch 1", "t+k/=="));
		expect(`${url.origin}${url.pathname}`).toBe("https://shop.example.test/account/verify");
		expect(url.searchParams.get("challenge")).toBe("ch 1");
		expect(url.searchParams.get("token")).toBe("t+k/==");
	});

	test("keeps parameters already on the configured page", () => {
		expect(loginLinkUrl("https://brand.example/v?src=mail", "c", "t")).toBe(
			"https://brand.example/v?src=mail&challenge=c&token=t",
		);
	});
});
