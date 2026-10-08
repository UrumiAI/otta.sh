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
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	ATTACH_DOWNLOAD_ACTION_ID,
	CONSOLE_ACT_INTERACTION,
	DOWNLOAD_KEY_RANDOM_BYTES,
	DOWNLOAD_NOT_ATTACHED_TITLE,
	mintDownloadAssetKey,
} from "@otta-sh/plugin";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

// The stub `virtual:emdash/env` resolves to in tests (vitest.config.ts) — the
// same object the middleware reads, typed as always present.
import { env } from "./helpers/virtual-emdash-env.js";
import {
	attachDownloadRefusal,
	gatesMethod,
	isPluginRoutePath,
	readAttachDownload,
} from "../src/lib/download-attach-guard.js";
import { onRequest } from "../src/middleware.js";

const SITE = "http://localhost:4321";
const ADMIN_ROUTE = "/_emdash/api/plugins/otta/admin";
const PRODUCT = "prod_1";
/** A key exactly as the upload endpoint mints it for {@link PRODUCT}. */
const KEY = mintDownloadAssetKey(
	PRODUCT as Parameters<typeof mintDownloadAssetKey>[0],
	Date.UTC(2026, 9, 6),
	new Uint8Array(DOWNLOAD_KEY_RANDOM_BYTES).fill(7),
);
const ADMIN = { id: "user-admin", role: 50 };

function attachBody(over: Record<string, string> = {}): Record<string, unknown> {
	return {
		type: CONSOLE_ACT_INTERACTION,
		action_id: ATTACH_DOWNLOAD_ACTION_ID,
		value: {
			productId: PRODUCT,
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
		expect(readAttachDownload(attachBody())).toEqual({
			productId: PRODUCT,
			key: KEY,
			size: "1234",
		});
	});

	test.each([
		["another action", { ...attachBody(), action_id: "products:save" }],
		["a read", { type: "otta_console_read", resource: "products.detail", productId: PRODUCT }],
		["no value", { type: CONSOLE_ACT_INTERACTION, action_id: ATTACH_DOWNLOAD_ACTION_ID }],
		["no product id", attachBody({ productId: 7 as unknown as string })],
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
		expect(
			await attachDownloadRefusal(b, { productId: PRODUCT, key: KEY, size: "1234" }),
		).toBeNull();
		expect(b.heads).toEqual([KEY]);
	});

	test("a key with no object is refused as a notice, so the card shows it", async () => {
		const response = await attachDownloadRefusal(bucket({}), {
			productId: PRODUCT,
			key: KEY,
			size: "1234",
		});
		expect(response?.status).toBe(200);
		expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await dataOf(response as Response)).toEqual({
			ok: true,
			notice: {
				variant: "error",
				title: DOWNLOAD_NOT_ATTACHED_TITLE,
				description: expect.stringContaining("Upload the file again") as unknown,
			},
		});
	});

	test("an object of another size is refused the same way", async () => {
		const response = await attachDownloadRefusal(bucket({ [KEY]: 99 }), {
			productId: PRODUCT,
			key: KEY,
			size: "1234",
		});
		expect(await dataOf(response as Response)).toMatchObject({
			ok: true,
			notice: { variant: "error", title: DOWNLOAD_NOT_ATTACHED_TITLE },
		});
	});

	test("no DOWNLOADS binding: refused, downloads are not set up", async () => {
		const response = await attachDownloadRefusal(undefined, {
			productId: PRODUCT,
			key: KEY,
			size: "1234",
		});
		const data = await dataOf(response as Response);
		expect(data).toMatchObject({ ok: true, notice: { variant: "error" } });
		expect(JSON.stringify(data)).toContain("DOWNLOADS");
	});

	test.each([
		["not a download key", "uploads/book.pdf"],
		["another product's key", KEY.replace(`dl/${PRODUCT}/`, "dl/prod_2/")],
		["no ULID", `dl/${PRODUCT}/book.pdf`],
		["a path climb", `dl/${PRODUCT}/../prod_2/${KEY.slice(-26)}`],
	])(
		"%s: never sent to R2 — left to the plugin, which refuses it on the same rule",
		async (_label, key) => {
			const b = bucket({}, true);
			expect(await attachDownloadRefusal(b, { productId: PRODUCT, key, size: "1234" })).toBeNull();
			expect(b.heads).toEqual([]);
		},
	);

	test("a bucket that throws is a retryable failure, not a refusal of the file", async () => {
		const response = await attachDownloadRefusal(bucket({}, true), {
			productId: PRODUCT,
			key: KEY,
			size: "1234",
		});
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

	interface Shape {
		method?: string;
		csrfHeader?: boolean;
		tokenScopes?: readonly string[];
	}

	function context(body: unknown, user: unknown = ADMIN, shape: Shape = {}) {
		const url = new URL(ADMIN_ROUTE, SITE);
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (shape.csrfHeader !== false) headers["X-EmDash-Request"] = "1";
		return {
			request: new Request(url, {
				method: shape.method ?? "POST",
				headers,
				body: JSON.stringify(body),
			}),
			url,
			cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
			locals: {
				user,
				...(shape.tokenScopes !== undefined ? { tokenScopes: shape.tokenScopes } : {}),
			},
			cache: { set: vi.fn() },
		};
	}

	// EmDash's plugin catch-all exports PUT and PATCH to the same handler as POST
	// and parses a JSON body for all three; the plugin never reads the method.
	test.each(["POST", "PUT", "PATCH"])(
		"%s: an attach naming a missing object never reaches the plugin",
		async (method) => {
			const b = bucket({});
			env["DOWNLOADS"] = b;
			const next = vi.fn(async () => new Response("plugin"));
			const response = await run(context(attachBody(), ADMIN, { method }), next);
			expect(next).not.toHaveBeenCalled();
			expect(b.heads).toEqual([KEY]);
			expect(await dataOf(response)).toMatchObject({
				notice: { variant: "error", title: DOWNLOAD_NOT_ATTACHED_TITLE },
			});
		},
	);

	test("a token with the admin scope (no CSRF header needed) is checked too", async () => {
		env["DOWNLOADS"] = bucket({});
		const next = vi.fn(async () => new Response("plugin"));
		await run(context(attachBody(), ADMIN, { csrfHeader: false, tokenScopes: ["admin"] }), next);
		expect(next).not.toHaveBeenCalled();
	});

	test("a truthy tokenScopes that is not a list is checked, never skipped (EmDash's own truthiness)", async () => {
		env["DOWNLOADS"] = bucket({});
		const next = vi.fn(async () => new Response("plugin"));
		await run(
			context(attachBody(), ADMIN, {
				csrfHeader: false,
				tokenScopes: "admin" as unknown as readonly string[],
			}),
			next,
		);
		expect(next).not.toHaveBeenCalled();
	});

	test("an empty-string tokenScopes is a session to EmDash: the CSRF header decides", async () => {
		const b = bucket({});
		env["DOWNLOADS"] = b;
		const next = vi.fn(async () => new Response("refused by emdash", { status: 403 }));
		await run(
			context(attachBody(), ADMIN, {
				csrfHeader: false,
				tokenScopes: "" as unknown as readonly string[],
			}),
			next,
		);
		expect(next).toHaveBeenCalledOnce();
		expect(b.heads).toEqual([]);
	});

	test.each([
		["no X-EmDash-Request header", { csrfHeader: false }],
		["a token without the admin scope", { tokenScopes: ["content:read"] }],
	] as const)(
		"%s: left to EmDash's own refusal — answered by nobody but EmDash",
		async (_label, shape) => {
			const b = bucket({});
			env["DOWNLOADS"] = b;
			const next = vi.fn(async () => new Response("refused by emdash", { status: 403 }));
			const response = await run(context(attachBody(), ADMIN, shape), next);
			expect(response.status).toBe(403);
			expect(b.heads).toEqual([]);
		},
	);

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

describe("the methods the guard covers, against the INSTALLED EmDash", () => {
	test("bodyless methods are the only ones not gated", () => {
		for (const method of ["POST", "PUT", "PATCH", "post", "PROPFIND"]) {
			expect(gatesMethod(method), method).toBe(true);
		}
		for (const method of ["GET", "HEAD", "DELETE", "OPTIONS", "get"]) {
			expect(gatesMethod(method), method).toBe(false);
		}
	});

	test("every method the plugin catch-all serves with a JSON body is gated", () => {
		// The copy EmDash itself loads. If an upgrade adds a method to the
		// catch-all, or a method to the set whose JSON body becomes the route's
		// input, this fails until the guard is looked at again.
		const emdashPackage = realpathSync(
			fileURLToPath(new URL("../node_modules/emdash/package.json", import.meta.url)),
		);
		const dist = new URL("dist/", pathToFileURL(emdashPackage));
		const route = readFileSync(
			new URL("astro/routes/api/plugins/_pluginId_/_...path_.mjs", dist),
			"utf8",
		);
		const exported = /export \{([^}]*)\};/.exec(route)?.[1] ?? "";
		const methods = exported
			.split(",")
			.map((name) => name.trim())
			.filter((name) => /^[A-Z]+$/.test(name));
		// EmDash 1.0.1 added HEAD; it is bodyless, so the guard passes it (below).
		expect(methods.toSorted()).toEqual(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);
		// Since 1.0 the route hands every request to the shared plugin-route
		// dispatcher (`src/plugins/http-route-dispatch.ts`), which reads the CSRF
		// header and token scope exactly as the guard mirrors them (it answers
		// only what EmDash would have dispatched).
		const dispatchImport = /import \{[^}]*\bas dispatchPluginApiRequest \} from "([^"]+)";/.exec(
			route,
		)?.[1];
		expect(dispatchImport).toBeDefined();
		const dispatch = readFileSync(
			new URL(dispatchImport!, new URL("astro/routes/api/plugins/_pluginId_/", dist)),
			"utf8",
		);
		expect(dispatch).toContain('requireScope({ tokenScopes }, "admin")');
		expect(dispatch).toContain(
			'if (!tokenScopes && request.headers.get("X-EmDash-Request") !== "1") return apiError("CSRF_REJECTED"',
		);

		const bodyMethodSets = readdirSync(dist)
			.filter((file) => file.endsWith(".mjs"))
			.flatMap((file) => {
				const text = readFileSync(new URL(file, dist), "utf8");
				const match = /\nconst BODY_METHODS = new Set\(\[([^\]]*)\]\);/.exec(text);
				return match === null ? [] : [match[1]!];
			});
		expect(bodyMethodSets).toHaveLength(1);
		const bodyMethods = [...bodyMethodSets[0]!.matchAll(/"([A-Z]+)"/g)].map((m) => m[1]!);
		expect(bodyMethods.toSorted()).toEqual(["PATCH", "POST", "PUT"]);
		// A method the route serves WITHOUT the guard takes its input from the
		// query string, where `value` is a string and no descriptor can ride.
		for (const method of methods) {
			if (!gatesMethod(method)) expect(bodyMethods, method).not.toContain(method);
		}
		for (const method of bodyMethods) expect(gatesMethod(method), method).toBe(true);
	});
});
