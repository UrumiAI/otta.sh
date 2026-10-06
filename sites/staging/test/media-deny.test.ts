/**
 * Defence in depth for the downloads bucket (issue #376, increment 3): EmDash's
 * PUBLIC media route never serves a key under `dl/`.
 *
 * Paid files live in the private `DOWNLOADS` bucket, never in `MEDIA`, and the
 * build refuses a config that makes them the same bucket. This deny covers the
 * remaining mistake: a `dl/…` object put into the media bucket by hand (a
 * `wrangler r2 object put` to the wrong bucket). EmDash's
 * `/_emdash/api/media/file/<key>` would serve it to anyone, unauthenticated,
 * so the site middleware answers 404 before EmDash's route runs. (EmDash's
 * image endpoint cannot read a `dl/…` key at all: its storage path accepts no
 * `/` in a key.)
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import { isPrivateDownloadMediaRequest } from "../src/lib/media-deny.js";
import { onRequest } from "../src/middleware.js";

const SITE = "http://localhost:4321";
const at = (path: string): URL => new URL(path, SITE);

describe("isPrivateDownloadMediaRequest", () => {
	test.each([
		"/_emdash/api/media/file/dl/prod_1/01JABC",
		"/_emdash/api/media/file/dl/",
		"/_emdash/api/media/file//dl/prod_1/x",
		"/_emdash/api/media/file/dl%2Fprod_1%2Fx",
		"/_emdash/api/media/file/%64l/prod_1/x",
		"/_emdash/api/media/file/./dl/prod_1/x",
		"/_emdash/api/media/file/x/../dl/prod_1/x",
		"/_emdash/api/media/file/%2e%2e/file/dl/x",
		// Astro decodeURI-decodes the pathname before routing, so an escaped
		// route segment still reaches EmDash's media route.
		"/_emdash/api/media/%66ile/dl/x",
	])("%s is refused", (path) => {
		expect(isPrivateDownloadMediaRequest(at(path))).toBe(true);
	});

	test.each([
		"/_emdash/api/media/file/01JABCDEFG.jpg",
		"/_emdash/api/media/file/images/dl/x.jpg",
		"/_emdash/api/media/file/dlx/a.jpg",
		"/_emdash/api/media/file/DL/a.jpg",
		"/orders/abc/download/dl",
		"/products/dl/thing",
		"/_emdash/api/media",
	])("%s is left alone", (path) => {
		expect(isPrivateDownloadMediaRequest(at(path))).toBe(false);
	});

	test("a malformed escape in the key does not throw — it is checked raw", () => {
		expect(isPrivateDownloadMediaRequest(at("/_emdash/api/media/file/dl/%E0%A4%A"))).toBe(true);
		expect(isPrivateDownloadMediaRequest(at("/_emdash/api/media/file/%E0%A4%A"))).toBe(false);
	});
});

/** The middleware, called as Astro calls it (the mock above makes
 *  `defineMiddleware` the identity). */
const run = (ctx: unknown, next: () => Promise<Response>): Promise<Response> =>
	(onRequest as unknown as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(
		ctx,
		next,
	);

describe("the middleware applies it before EmDash's route", () => {
	function context(path: string, method = "GET") {
		const url = at(path);
		return {
			request: new Request(url, { method }),
			url,
			cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
			locals: {},
			cache: { set: vi.fn() },
		};
	}

	test.each(["GET", "HEAD"])(
		"%s of a dl/ media key is 404 and never reaches the route",
		async (method) => {
			const next = vi.fn(async () => new Response("SECRET BYTES"));
			const response = await run(context("/_emdash/api/media/file/dl/prod_1/x", method), next);
			expect(response.status).toBe(404);
			expect(next).not.toHaveBeenCalled();
			expect(await response.text()).not.toContain("SECRET");
			expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		},
	);

	test("an ordinary media key passes through untouched", async () => {
		const next = vi.fn(async () => new Response("image"));
		const response = await run(context("/_emdash/api/media/file/01JABC.jpg"), next);
		expect(next).toHaveBeenCalledOnce();
		expect(await response.text()).toBe("image");
	});
});
