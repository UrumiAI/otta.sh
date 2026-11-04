/**
 * ADR-0044 §7 (review round 2 M1, round 3 R3-1): the COD attestation header is
 * the site's own — set only on its in-process dispatch — so the middleware's
 * `onRequest` refuses (400, text/plain) ANY incoming request that carries it,
 * before CSRF, the rate limit or the endpoint runs: the plugin mount in any
 * spelling, the site's own /checkout/place, a GET, a mixed-case header name.
 * Driven through `onRequest` itself, in the style of origin-middleware.test.ts.
 */
import { COD_ATTEST_HEADER, COD_ATTEST_VALUE } from "@urumi.ai/otta-plugin";
import { describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import { onRequest } from "../src/middleware.js";

const SITE = "http://localhost:4321";

type Handler = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
const runMiddleware = onRequest as unknown as Handler;

function context(
	method: string,
	pathname: string,
	routePattern: string,
	headers: Record<string, string>,
) {
	const url = new URL(pathname, SITE);
	return {
		request: new Request(url, { method, headers: { origin: SITE, ...headers } }),
		url,
		routePattern,
		cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
		locals: {},
		cache: { set: vi.fn() },
	};
}

const PLUGIN_PLACE = "/_emdash/api/plugins/otta/storefront/checkout/place";

describe("onRequest refuses an incoming COD attestation", () => {
	test.each([
		["POST", PLUGIN_PLACE, "/_emdash/api/plugins/[pluginId]/[...path]", COD_ATTEST_HEADER],
		[
			"POST",
			"/_emdash/api/plugins/otta/storefront%2Fcheckout%2Fplace",
			"/_emdash/api/plugins/[pluginId]/[...path]",
			COD_ATTEST_HEADER,
		],
		["POST", `${PLUGIN_PLACE}/`, "/_emdash/api/plugins/[pluginId]/[...path]", COD_ATTEST_HEADER],
		["GET", PLUGIN_PLACE, "/_emdash/api/plugins/[pluginId]/[...path]", "X-Otta-COD-Attest"],
		["POST", "/checkout/place", "/checkout/place", COD_ATTEST_HEADER],
	])(
		"%s %s (header %s) → 400 text/plain, the endpoint never runs",
		async (method, path, pattern, name) => {
			const next = vi.fn(() => Promise.resolve(new Response("endpoint ran", { status: 299 })));
			const res = await runMiddleware(
				context(method, path, pattern, { [name]: COD_ATTEST_VALUE }),
				next,
			);
			expect(res.status).toBe(400);
			expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
			expect(next).not.toHaveBeenCalled();
		},
	);

	test("any value is refused, not only the marker", async () => {
		const next = vi.fn(() => Promise.resolve(new Response("endpoint ran", { status: 299 })));
		const res = await runMiddleware(
			context("POST", PLUGIN_PLACE, "/_emdash/api/plugins/[pluginId]/[...path]", {
				[COD_ATTEST_HEADER]: "anything",
			}),
			next,
		);
		expect(res.status).toBe(400);
		expect(next).not.toHaveBeenCalled();
	});

	test("control: the same POST without the header is not refused by this rule", async () => {
		const next = vi.fn(() => Promise.resolve(new Response("endpoint ran", { status: 299 })));
		const res = await runMiddleware(
			context("POST", PLUGIN_PLACE, "/_emdash/api/plugins/[pluginId]/[...path]", {}),
			next,
		);
		expect(res.status).not.toBe(400);
	});
});
