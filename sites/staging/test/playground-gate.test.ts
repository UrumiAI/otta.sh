/**
 * The gate on a request that is not a page load: the admin console's own
 * fetch to the Otta plugin route. It must carry on (null) with the session
 * user stamped, or EmDash's dispatch throws on `createdAt` and answers 500.
 */
import type { APIContext } from "astro";
import { afterEach, describe, expect, test, vi } from "vitest";
import { playgroundGate, withPlaygroundBanner } from "../src/lib/playground-gate.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function starsRequest(method: string): APIContext {
	const url = new URL("https://try.otta.sh/_otta/stars");
	return {
		request: new Request(url, { method, headers: { accept: "application/json" } }),
		url,
		locals: { user: { id: "u1", email: "a@b.c", name: null, role: 50 } },
	} as unknown as APIContext;
}

function consoleFetch(user: unknown): APIContext {
	const url = new URL("https://try.otta.sh/_emdash/api/plugins/otta/admin");
	return {
		request: new Request(url, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: "{}",
		}),
		url,
		locals: { user },
	} as unknown as APIContext;
}

describe("playgroundGate on the admin console's fetch", () => {
	test("stamps createdAt on the playground build and carries on", async () => {
		vi.stubGlobal("__OTTA_PLAYGROUND__", true);
		const shared = Object.freeze({
			id: "playground-admin",
			email: "playground@emdashcms.com",
			name: "Playground User",
			role: 50,
		});
		const context = consoleFetch(shared);
		expect(await playgroundGate(context)).toBeNull();
		const user = context.locals.user as unknown as Record<string, unknown>;
		expect(user["createdAt"]).toEqual(expect.any(Date));
		expect(user["id"]).toBe("playground-admin");
		expect(shared).not.toHaveProperty("createdAt");
	});

	test("leaves the storefront build's user untouched", async () => {
		const user = { id: "u1", email: "a@b.c", name: null, role: 50 };
		const context = consoleFetch(user);
		expect(await playgroundGate(context)).toBeNull();
		expect(context.locals.user).toBe(user);
	});
});

const github = () =>
	vi.fn(async () => Response.json({ stargazers_count: 1249 })) as unknown as typeof fetch;

describe("playgroundGate on /_otta/stars", () => {
	test("answers the count on the playground build, GET and HEAD", async () => {
		vi.stubGlobal("__OTTA_PLAYGROUND__", true);
		const fetchImpl = github();
		vi.stubGlobal("fetch", fetchImpl);
		const got = await playgroundGate(starsRequest("GET"));
		expect(got?.status).toBe(200);
		expect(await got?.json()).toEqual({ stars: 1249, label: "1.2k" });
		expect((await playgroundGate(starsRequest("HEAD")))?.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	test("is not there on the storefront build, and never calls GitHub", async () => {
		vi.stubGlobal("__OTTA_PLAYGROUND__", false);
		const fetchImpl = github();
		vi.stubGlobal("fetch", fetchImpl);
		expect(await playgroundGate(starsRequest("GET"))).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("lets other methods fall through", async () => {
		vi.stubGlobal("__OTTA_PLAYGROUND__", true);
		const fetchImpl = github();
		vi.stubGlobal("fetch", fetchImpl);
		for (const method of ["POST", "PUT", "DELETE"]) {
			expect(await playgroundGate(starsRequest(method))).toBeNull();
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

const html = () =>
	new Response("<html><body><p>Hi</p></body></html>", {
		headers: { "content-type": "text/html; charset=utf-8" },
	});

describe("withPlaygroundBanner", () => {
	test("hands the storefront build's response back untouched", async () => {
		vi.stubGlobal("__OTTA_PLAYGROUND__", false);
		const response = html();
		expect(await withPlaygroundBanner(response)).toBe(response);
		const body = await response.text();
		expect(body).toBe("<html><body><p>Hi</p></body></html>");
		expect(body).not.toContain("otta-star");
		expect(body).not.toContain("<script");
	});

	test("adds the note and exactly one script on the playground build", async () => {
		vi.stubGlobal("__OTTA_PLAYGROUND__", true);
		const body = await (await withPlaygroundBanner(html())).text();
		expect(body).toContain("otta-playground-note");
		expect(body.split('src="/scripts/playground-star.js"')).toHaveLength(2);
		expect(body.split("<script")).toHaveLength(2);
	});
});
