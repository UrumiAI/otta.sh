/**
 * Attaching a download file checks the object is in the bucket (issue #405,
 * item 5).
 *
 * The console saves an uploaded file's descriptor through the plugin's admin
 * route (`products:attach-download`). The plugin cannot reach R2, so on its own
 * it accepted any well-formed `dl/{productId}/{ULID}` key — and a key with no
 * object behind it would make every buyer's download 404. The site holds the
 * `DOWNLOADS` binding, so the site's middleware `head()`s the key before that
 * write reaches the plugin, and refuses it in the console's own words when the
 * object is missing or is not the size the descriptor claims.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

// The stub `virtual:emdash/env` resolves to in tests (vitest.config.ts) — the
// same object the middleware reads, typed as always present.
import { env } from "./helpers/virtual-emdash-env.js";
import {
	attachDownloadRefusal,
	isPluginRoutePath,
	readAttachDownload,
} from "../src/lib/download-attach-guard.js";
import { onRequest } from "../src/middleware.js";

const SITE = "http://localhost:4321";
const ADMIN_ROUTE = "/_emdash/api/plugins/otta/admin";
const KEY = "dl/prod_1/01JABCDEFGHJKMNPQRSTVWXYZ0";
const ADMIN = { id: "user-admin", role: 50 };

function attachBody(over: Record<string, string> = {}): Record<string, unknown> {
	return {
		type: "otta_console_act",
		action_id: "products:attach-download",
		value: {
			productId: "prod_1",
			expectedUpdatedAt: "2026-10-06T00:00:00.000Z",
			key: KEY,
			filename: "book.pdf",
			contentType: "application/pdf",
			size: "1234",
			...over,
		},
	};
}

/** A `DOWNLOADS` stand-in holding the given objects, recording every head. */
function bucket(objects: Record<string, number>, fail = false) {
	const heads: string[] = [];
	return {
		heads,
		head: (key: string) => {
			heads.push(key);
			if (fail) return Promise.reject(new Error("r2 down"));
			const size = objects[key];
			return Promise.resolve(size === undefined ? null : { size, httpEtag: '"e"' });
		},
	};
}

async function dataOf(response: Response): Promise<Record<string, unknown>> {
	const envelope = (await response.json()) as { data?: Record<string, unknown> };
	return envelope.data ?? {};
}

describe("readAttachDownload — which bodies are an attach", () => {
	test("the console's attach act yields its key and size", () => {
		expect(readAttachDownload(attachBody())).toEqual({ key: KEY, size: "1234" });
	});

	test.each([
		["another action", { ...attachBody(), action_id: "products:save" }],
		["a read", { type: "otta_console_read", resource: "products.detail", productId: "p" }],
		["no value", { type: "otta_console_act", action_id: "products:attach-download" }],
		["a non-string key", attachBody({ key: 7 as unknown as string })],
		["not an object", "products:attach-download"],
		["null", null],
	])("%s is not gated (the plugin answers it)", (_label, body) => {
		expect(readAttachDownload(body)).toBeNull();
	});
});

describe("attachDownloadRefusal — the check itself", () => {
	test("an object of the descriptor's size passes", async () => {
		const b = bucket({ [KEY]: 1234 });
		expect(await attachDownloadRefusal(b, { key: KEY, size: "1234" })).toBeNull();
		expect(b.heads).toEqual([KEY]);
	});

	test("a key with no object is refused as a notice, so the card shows it", async () => {
		const response = await attachDownloadRefusal(bucket({}), { key: KEY, size: "1234" });
		expect(response?.status).toBe(200);
		expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await dataOf(response as Response)).toEqual({
			ok: true,
			notice: {
				variant: "error",
				title: "This file wasn't attached",
				description: expect.stringContaining("Upload the file again") as unknown,
			},
		});
	});

	test("an object of another size is refused the same way", async () => {
		const response = await attachDownloadRefusal(bucket({ [KEY]: 99 }), {
			key: KEY,
			size: "1234",
		});
		expect(await dataOf(response as Response)).toMatchObject({
			ok: true,
			notice: { variant: "error", title: "This file wasn't attached" },
		});
	});

	test("no DOWNLOADS binding: refused, downloads are not set up", async () => {
		const response = await attachDownloadRefusal(undefined, { key: KEY, size: "1234" });
		const data = await dataOf(response as Response);
		expect(data).toMatchObject({ ok: true, notice: { variant: "error" } });
		expect(JSON.stringify(data)).toContain("DOWNLOADS");
	});

	test("a bucket that throws is a retryable failure, not a refusal of the file", async () => {
		const response = await attachDownloadRefusal(bucket({}, true), { key: KEY, size: "1234" });
		expect(await dataOf(response as Response)).toMatchObject({ ok: false, retryable: true });
	});
});

describe("isPluginRoutePath", () => {
	test.each([
		ADMIN_ROUTE,
		"/_emdash/api/plugins/otta/admin/",
		"//_emdash/api/plugins/otta/admin",
		"/_emdash/api/%70lugins/otta/admin",
	])("%s is a plugin route", (path) => {
		// Concatenated, not resolved: `new URL("//x", base)` is protocol-relative.
		expect(isPluginRoutePath(new URL(`${SITE}${path}`))).toBe(true);
	});

	test.each(["/otta-admin/downloads/prod_1", "/_emdash/api/media/file/x", "/cart"])(
		"%s is not",
		(path) => {
			expect(isPluginRoutePath(new URL(path, SITE))).toBe(false);
		},
	);
});

/** The middleware, called as Astro calls it (the mock above makes
 *  `defineMiddleware` the identity). */
const run = (ctx: unknown, next: () => Promise<Response>): Promise<Response> =>
	(onRequest as unknown as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(
		ctx,
		next,
	);

describe("the middleware gates the attach before the plugin's route runs", () => {
	afterEach(() => {
		delete env["DOWNLOADS"];
	});

	function context(body: unknown, user: unknown = ADMIN, path = ADMIN_ROUTE) {
		const url = new URL(path, SITE);
		return {
			request: new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify(body),
			}),
			url,
			cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
			locals: { user },
			cache: { set: vi.fn() },
		};
	}

	test("an attach naming a missing object never reaches the plugin", async () => {
		env["DOWNLOADS"] = bucket({});
		const next = vi.fn(async () => new Response("plugin"));
		const response = await run(context(attachBody()), next);
		expect(next).not.toHaveBeenCalled();
		expect(await dataOf(response)).toMatchObject({ notice: { variant: "error" } });
	});

	test("an attach naming a stored object goes through, its body still readable", async () => {
		env["DOWNLOADS"] = bucket({ [KEY]: 1234 });
		const ctx = context(attachBody());
		const next = vi.fn(async () => new Response(await ctx.request.text()));
		const response = await run(ctx, next);
		expect(next).toHaveBeenCalledOnce();
		expect(JSON.parse(await response.text())).toEqual(attachBody());
	});

	test("any other console write passes through without a bucket read", async () => {
		const b = bucket({});
		env["DOWNLOADS"] = b;
		const next = vi.fn(async () => new Response("plugin"));
		await run(context({ ...attachBody(), action_id: "products:save" }), next);
		expect(next).toHaveBeenCalledOnce();
		expect(b.heads).toEqual([]);
	});

	test.each([
		// `null`, not `undefined`: `undefined` would take `context`'s default user.
		["signed out", null],
		["below plugins:manage", { id: "user-editor", role: 40 }],
	])("%s: left to EmDash's own refusal, the bucket untouched", async (_label, user) => {
		const b = bucket({});
		env["DOWNLOADS"] = b;
		const next = vi.fn(async () => new Response("refused by emdash", { status: 403 }));
		const response = await run(context(attachBody(), user), next);
		expect(response.status).toBe(403);
		expect(b.heads).toEqual([]);
	});
});
