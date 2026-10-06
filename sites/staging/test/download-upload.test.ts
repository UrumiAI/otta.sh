/**
 * `POST /otta-admin/downloads/<productId>` — the merchant uploads a digital
 * product's file to the private `DOWNLOADS` bucket (issue #376, increment 4;
 * ADR-0029).
 *
 * WHAT IS PROVEN HERE. The endpoint, driven through its real page module with
 * a fake context:
 *  - who may upload: a signed-in EmDash user with the plugins:manage role
 *    (ADMIN), and only with the `X-EmDash-Request: 1` header the console sends;
 *  - which product: one the plugin's own admin read knows, digital, not in the
 *    trash — asked for with the signed-in user as the caller;
 *  - what is stored: the body, under a FRESH `dl/{productId}/{ULID}` key the
 *    server mints (never from the filename, a header or the URL beyond the
 *    resolved product id), with the declared type coerced to the allowlist and
 *    the filename sanitised;
 *  - the 100 MB cap, an empty file and a short body, each with a clear error;
 *  - the answer: the descriptor, which the console then saves through the
 *    plugin's `products:attach-download`. The endpoint itself writes no product.
 * The fake bucket records every key it is asked to write or delete, so "nothing
 * reached R2" is an assertion, not a hope. The ORIGIN check is the site's
 * per-route guard (`rejectCrossOrigin`), run first, as on every other write
 * route of this base.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join as joinPath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { APIContext } from "astro";
import { env as virtualEnv } from "./helpers/virtual-emdash-env.js";
import { DOWNLOADS_BINDING } from "../src/lib/downloads-bucket.js";
import {
	DOWNLOAD_FILENAME_HEADER,
	downloadUploadPath,
	MAX_DOWNLOAD_UPLOAD_BYTES,
	UPLOAD_MIN_ROLE,
} from "../src/lib/download-upload.js";
import { POST } from "../src/pages/otta-admin/downloads/[productId].js";

const SITE = "http://localhost:4321";
const PRODUCT = "01KAPRODUCT0000000000000000";
const BYTES = new TextEncoder().encode("%PDF-1.7 a small but real file body");
const ADMIN = { id: "user-admin", role: 50 };
const EDITOR = { id: "user-editor", role: 40 };

// ── the fake bucket ──────────────────────────────────────────────────────────

interface StoredObject {
	bytes: Uint8Array;
	options: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
}

/** R2's observable `put`/`delete`. `put` drains the stream (as R2 does) and
 *  answers the stored size; `shortBy` stores fewer bytes than were sent, and
 *  `failPut` rejects. Every key is recorded. */
function makeBucket(opts: { shortBy?: number; failPut?: boolean } = {}) {
	const puts: string[] = [];
	const deletes: string[] = [];
	const objects = new Map<string, StoredObject>();
	const bucket = {
		async put(
			key: string,
			body: ReadableStream<Uint8Array> | null,
			options: StoredObject["options"],
		) {
			puts.push(key);
			if (opts.failPut === true) throw new Error("R2 is down");
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());
			const kept = bytes.slice(0, bytes.length - (opts.shortBy ?? 0));
			objects.set(key, { bytes: kept, options });
			return { key, size: kept.length };
		},
		async delete(key: string) {
			deletes.push(key);
			objects.delete(key);
		},
	};
	return { bucket, puts, deletes, objects };
}

// ── the plugin's admin read, faked at the dispatcher ─────────────────────────

interface ReadCall {
	pluginId: string;
	method: string;
	path: string;
	body: unknown;
	user: unknown;
}

type ProductAnswer =
	| { productKind: string; deletedAt?: string | null; productId?: string }
	| { refusal: Record<string, unknown> }
	| { envelope: Record<string, unknown> }
	| { throws: true };

function makeDispatcher(answer: ProductAnswer) {
	const calls: ReadCall[] = [];
	const handlePluginApiRoute = vi.fn(
		async (pluginId: string, method: string, path: string, request: Request, user?: unknown) => {
			calls.push({ pluginId, method, path, body: await request.json(), user });
			if ("throws" in answer) throw new Error("dispatch blew up");
			if ("envelope" in answer) return answer.envelope;
			if ("refusal" in answer) return { success: true, data: answer.refusal };
			return {
				success: true,
				data: {
					ok: true,
					product: {
						productId: answer.productId ?? PRODUCT,
						productKind: answer.productKind,
						deletedAt: answer.deletedAt ?? null,
						updatedAt: "2026-10-06T00:00:00.000Z",
					},
				},
			};
		},
	);
	return { handlePluginApiRoute, calls };
}

// ── driving the page ─────────────────────────────────────────────────────────

interface Drive {
	user?: { id: string; role: number } | null;
	answer?: ProductAnswer;
	headers?: Record<string, string | null>;
	body?: Uint8Array | null;
	productId?: string;
	bucket?: ReturnType<typeof makeBucket> | null;
	tokenScopes?: string[];
}

async function upload(drive: Drive = {}) {
	const productId = drive.productId ?? PRODUCT;
	const body = drive.body === undefined ? BYTES : drive.body;
	const headers = new Headers();
	const wanted: Record<string, string | null> = {
		"X-EmDash-Request": "1",
		"Content-Type": "application/pdf",
		"Content-Length": body === null ? null : String(body.length),
		[DOWNLOAD_FILENAME_HEADER]: encodeURIComponent("Field Guide.pdf"),
		...drive.headers,
	};
	for (const [name, value] of Object.entries(wanted)) if (value !== null) headers.set(name, value);
	// The declared Content-Length is what a Worker sees; the fetch Request keeps
	// it as given, so a lie (or its absence) reaches the endpoint as sent.
	const request = new Request(new URL(downloadUploadPath(productId), SITE), {
		method: "POST",
		headers,
		body: body as BodyInit | null,
	});
	// `bucket: null` is a deployment with no binding; the recorder still exists,
	// unbound, so every case can assert it was never written.
	const r2 = drive.bucket ?? makeBucket();
	if (drive.bucket === null) delete virtualEnv[DOWNLOADS_BINDING];
	else virtualEnv[DOWNLOADS_BINDING] = r2.bucket;
	const dispatcher = makeDispatcher(drive.answer ?? { productKind: "digital" });
	const cache = { set: vi.fn() };
	const context = {
		request,
		url: new URL(request.url),
		params: { productId },
		locals: {
			user: drive.user === undefined ? ADMIN : (drive.user ?? undefined),
			...(drive.tokenScopes !== undefined ? { tokenScopes: drive.tokenScopes } : {}),
			emdash: { handlePluginApiRoute: dispatcher.handlePluginApiRoute },
		},
		cache,
	} as unknown as APIContext;
	const response = await POST(context);
	// The origin guard's refusal is plain text; every other answer is JSON.
	const text = await response.clone().text();
	const json = (text.startsWith("{") ? JSON.parse(text) : { ok: false }) as {
		ok: boolean;
		asset?: { key: string; filename: string; contentType: string; size: number };
		error?: { code: string; message: string };
	};
	return { response, json, r2, dispatcher, cache };
}

/** A minted key for this product: `dl/{productId}/{canonical ULID}`. */
const KEY_SHAPE = new RegExp(`^dl/${PRODUCT}/[0-7][0-9A-HJKMNP-TV-Z]{25}$`);

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	delete virtualEnv[DOWNLOADS_BINDING];
});

describe("a stored upload", () => {
	test("stores the body under a fresh minted key and answers the descriptor", async () => {
		const { response, json, r2, dispatcher } = await upload();
		expect(response.status).toBe(201);
		expect(json.ok).toBe(true);
		expect(json.asset).toEqual({
			key: expect.stringMatching(KEY_SHAPE),
			filename: "Field Guide.pdf",
			contentType: "application/pdf",
			size: BYTES.length,
		});
		// Exactly one object written, under exactly the answered key, with the bytes.
		expect(r2.puts).toEqual([json.asset!.key]);
		expect(r2.deletes).toEqual([]);
		const stored = r2.objects.get(json.asset!.key)!;
		expect(createHash("sha256").update(stored.bytes).digest("hex")).toBe(
			createHash("sha256").update(BYTES).digest("hex"),
		);
		expect(stored.options.httpMetadata).toEqual({ contentType: "application/pdf" });
		expect(stored.options.customMetadata).toMatchObject({
			productId: PRODUCT,
			uploadedBy: ADMIN.id,
		});
		// The product was resolved through the plugin's admin read, as the user.
		expect(dispatcher.calls).toEqual([
			{
				pluginId: "otta",
				method: "POST",
				path: "/admin",
				body: { type: "otta_console_read", resource: "products.detail", productId: PRODUCT },
				user: ADMIN,
			},
		]);
	});

	test("the answer is private and never stored by a cache", async () => {
		const { response, cache } = await upload();
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(cache.set).toHaveBeenCalledWith(false);
	});

	test("every upload gets its OWN key — a replace never overwrites the file a buyer may be downloading", async () => {
		const r2 = makeBucket();
		const first = await upload({ bucket: r2 });
		const second = await upload({ bucket: r2 });
		expect(first.json.asset!.key).not.toBe(second.json.asset!.key);
		expect(r2.puts).toEqual([first.json.asset!.key, second.json.asset!.key]);
		// Neither upload deletes anything: the old object is left for the
		// descriptor's switch to retire (documented in DEPLOYMENT.md).
		expect(r2.deletes).toEqual([]);
	});

	test("the key comes from the server, never from the filename or any header", async () => {
		const { json, r2 } = await upload({
			headers: {
				[DOWNLOAD_FILENAME_HEADER]: encodeURIComponent(
					"dl/other-product/01KAZZZZZZZZZZZZZZZZZZZZZZ",
				),
				"X-Otta-Key": "dl/other-product/evil",
			},
		});
		expect(json.asset!.key).toMatch(KEY_SHAPE);
		expect(r2.puts).toEqual([json.asset!.key]);
		// The filename is just a name (its directory part dropped).
		expect(json.asset!.filename).toBe("01KAZZZZZZZZZZZZZZZZZZZZZZ");
	});

	test("the key carries the product id the PLUGIN answered, not the URL's spelling of it", async () => {
		const { json } = await upload({ answer: { productKind: "digital", productId: PRODUCT } });
		expect(json.asset!.key.startsWith(`dl/${PRODUCT}/`)).toBe(true);
	});
});

describe("who may upload", () => {
	test("a cross-origin request (any foreign or opaque Origin) → 403 before anything else runs", async () => {
		for (const origin of ["https://evil.example", "null", "http://localhost:9999"]) {
			const { response, r2, dispatcher } = await upload({ headers: { Origin: origin } });
			expect(response.status, origin).toBe(403);
			expect(response.headers.get("Cache-Control")).toBe("private, no-store");
			expect(r2.puts).toEqual([]);
			expect(dispatcher.calls).toEqual([]);
		}
	});

	test("the console's own same-origin request passes the origin guard", async () => {
		const { response } = await upload({ headers: { Origin: SITE } });
		expect(response.status).toBe(201);
	});

	test("no signed-in user → 401, and nothing is read or stored", async () => {
		const { response, json, r2, dispatcher } = await upload({ user: null });
		expect(response.status).toBe(401);
		expect(json.error?.code).toBe("NOT_SIGNED_IN");
		expect(r2.puts).toEqual([]);
		expect(dispatcher.calls).toEqual([]);
	});

	test("a signed-in user below the plugins:manage role → 403, nothing read or stored", async () => {
		const { response, json, r2, dispatcher } = await upload({ user: EDITOR });
		expect(response.status).toBe(403);
		expect(json.error?.code).toBe("FORBIDDEN");
		expect(json.error?.message).toContain("plugins:manage");
		expect(r2.puts).toEqual([]);
		expect(dispatcher.calls).toEqual([]);
	});

	test("a request authenticated by an API token is refused, even with an admin user", async () => {
		const { response, json, r2, dispatcher } = await upload({ tokenScopes: ["admin"] });
		expect(response.status).toBe(403);
		expect(json.error?.code).toBe("TOKEN_NOT_ACCEPTED");
		expect(r2.puts).toEqual([]);
		expect(dispatcher.calls).toEqual([]);
	});

	test("the minimum role is exactly the level the INSTALLED @emdash-cms/auth gives plugins:manage", async () => {
		// The site does not depend on @emdash-cms/auth, so it reaches the copy
		// EmDash itself resolves (pnpm keeps it beside emdash's real path).
		const emdash = realpathSync(fileURLToPath(new URL("../node_modules/emdash", import.meta.url)));
		const auth = (await import(
			pathToFileURL(joinPath(emdash, "..", "@emdash-cms", "auth", "dist", "index.mjs")).href
		)) as { Permissions: Record<string, number> };
		expect(auth.Permissions["plugins:manage"]).toBe(UPLOAD_MIN_ROLE);
		// Just below it is refused; at it, allowed.
		expect((await upload({ user: { id: "u", role: UPLOAD_MIN_ROLE - 1 } })).response.status).toBe(
			403,
		);
		expect((await upload({ user: { id: "u", role: UPLOAD_MIN_ROLE } })).response.status).toBe(201);
	});

	test("without the X-EmDash-Request header → 403: a plain cross-site form cannot send it", async () => {
		for (const value of [null, "0", "true"]) {
			const { response, json, r2 } = await upload({ headers: { "X-EmDash-Request": value } });
			expect(response.status, String(value)).toBe(403);
			expect(json.error?.code).toBe("CSRF_REJECTED");
			expect(r2.puts).toEqual([]);
		}
	});
});

describe("which product", () => {
	test("a PHYSICAL product → 409, nothing stored", async () => {
		const { response, json, r2 } = await upload({ answer: { productKind: "physical" } });
		expect(response.status).toBe(409);
		expect(json.error?.code).toBe("NOT_DIGITAL");
		expect(json.error?.message).toContain("Digital");
		expect(r2.puts).toEqual([]);
	});

	test("a product in the trash → 409, nothing stored", async () => {
		const { response, r2 } = await upload({
			answer: { productKind: "digital", deletedAt: "2026-10-01T00:00:00.000Z" },
		});
		expect(response.status).toBe(409);
		expect(r2.puts).toEqual([]);
	});

	test("a product the plugin does not know → 404 with the plugin's own words, nothing stored", async () => {
		const { response, json, r2 } = await upload({
			answer: {
				refusal: {
					ok: false,
					title: "Product not found",
					description: "No product matches that id.",
				},
			},
		});
		expect(response.status).toBe(404);
		expect(json.error?.message).toContain("No product matches that id.");
		expect(r2.puts).toEqual([]);
	});

	test("a busy store → 503 with Retry-After; a failed read → 503; neither stores", async () => {
		const busy = await upload({
			answer: {
				refusal: { ok: false, title: "The store is busy", description: "…", retryable: true },
			},
		});
		expect(busy.response.status).toBe(503);
		expect(busy.response.headers.get("Retry-After")).toBe("3");
		expect(busy.r2.puts).toEqual([]);
		for (const answer of [
			{ throws: true } as const,
			{ envelope: { success: false, error: { code: "NOT_FOUND" } } },
			{ envelope: { success: true, data: "nonsense" } },
		]) {
			const failed = await upload({ answer });
			expect(failed.response.status, JSON.stringify(answer)).toBe(503);
			expect(failed.r2.puts).toEqual([]);
		}
	});

	test("a product id that is not an id shape → 404 before anything is read", async () => {
		for (const productId of ["..", "a/b", "x y", "", "a".repeat(200)]) {
			const { response, r2, dispatcher } = await upload({ productId });
			expect(response.status, productId).toBe(404);
			expect(dispatcher.calls).toEqual([]);
			expect(r2.puts).toEqual([]);
		}
	});

	test("no DOWNLOADS binding on this deployment → 503 naming the setup step, nothing read", async () => {
		const { response, json, dispatcher, r2 } = await upload({ bucket: null });
		expect(response.status).toBe(503);
		expect(r2.puts).toEqual([]);
		expect(json.error?.code).toBe("DOWNLOADS_NOT_CONFIGURED");
		expect(json.error?.message).toContain("DOWNLOADS");
		expect(dispatcher.calls).toEqual([]);
	});
});

describe("size", () => {
	test("over the 100 MB request limit → 413 with a clear sentence, refused before anything is read", async () => {
		expect(MAX_DOWNLOAD_UPLOAD_BYTES).toBe(100_000_000);
		const { response, json, r2, dispatcher } = await upload({
			headers: { "Content-Length": String(MAX_DOWNLOAD_UPLOAD_BYTES + 1) },
		});
		expect(response.status).toBe(413);
		expect(json.error?.code).toBe("TOO_LARGE");
		expect(json.error?.message).toContain("100 MB");
		expect(r2.puts).toEqual([]);
		expect(dispatcher.calls).toEqual([]);
	});

	test("no Content-Length, or one that is not a whole number → 411, nothing stored", async () => {
		for (const value of [null, "", "abc", "-1", "1.5", "1e3"]) {
			const { response, r2 } = await upload({ headers: { "Content-Length": value } });
			expect(response.status, String(value)).toBe(411);
			expect(r2.puts).toEqual([]);
		}
	});

	test("an empty file → 400, nothing stored", async () => {
		const { response, json, r2 } = await upload({ body: new Uint8Array(0) });
		expect(response.status).toBe(400);
		expect(json.error?.code).toBe("EMPTY_FILE");
		expect(r2.puts).toEqual([]);
	});

	test("a body shorter than declared (a dropped connection) → 400, and the partial object is deleted", async () => {
		const r2 = makeBucket({ shortBy: 3 });
		const { response, json } = await upload({ bucket: r2 });
		expect(response.status).toBe(400);
		expect(json.error?.code).toBe("INCOMPLETE");
		expect(r2.puts).toHaveLength(1);
		expect(r2.deletes).toEqual(r2.puts);
	});

	test("the bucket refusing the write → 503, nothing answered as stored", async () => {
		const { response, json } = await upload({ bucket: makeBucket({ failPut: true }) });
		expect(response.status).toBe(503);
		expect(json.ok).toBe(false);
		expect(json.asset).toBeUndefined();
	});
});

describe("content type: coerced to the allowlist increment 1 validates", () => {
	test.each([
		["application/pdf", "application/pdf"],
		["Application/ZIP", "application/zip"],
		["text/plain; charset=utf-8", "text/plain"],
		["text/csv", "text/csv"],
		["text/html", "application/octet-stream"],
		["text/html; charset=utf-8", "application/octet-stream"],
		["image/svg+xml", "application/octet-stream"],
		["application/xhtml+xml", "application/octet-stream"],
		["text/javascript", "application/octet-stream"],
		["", "application/octet-stream"],
	])("declared %j is stored and answered as %j", async (declared, stored) => {
		const { json, r2 } = await upload({ headers: { "Content-Type": declared } });
		expect(json.asset?.contentType).toBe(stored);
		expect(r2.objects.get(json.asset!.key)?.options.httpMetadata?.contentType).toBe(stored);
	});

	test("no Content-Type at all is application/octet-stream", async () => {
		const { json } = await upload({ headers: { "Content-Type": null } });
		expect(json.asset?.contentType).toBe("application/octet-stream");
	});
});

describe("filename: sanitised, never a path", () => {
	test.each([
		["Field Guide.pdf", "Field Guide.pdf"],
		["Café menu – 2026.pdf", "Café menu – 2026.pdf"],
		["../../etc/passwd", "passwd"],
		["C:\\Users\\me\\book.epub", "book.epub"],
		['a"b\r\nSet-Cookie: x.pdf', "abSet-Cookie: x.pdf"],
		["invoice\u202Efdp.exe", "invoicefdp.exe"],
		["   ", "download"],
	])("the name %j is stored as %j", async (raw, expected) => {
		const { json, r2 } = await upload({
			headers: { [DOWNLOAD_FILENAME_HEADER]: encodeURIComponent(raw) },
		});
		expect(json.asset?.filename).toBe(expected);
		expect(r2.objects.get(json.asset!.key)?.options.customMetadata?.["filename"]).toBe(
			encodeURIComponent(expected),
		);
	});

	test("a missing or undecodable name header is `download`", async () => {
		for (const value of [null, "%E0%A4%A", "%"]) {
			const { json } = await upload({ headers: { [DOWNLOAD_FILENAME_HEADER]: value } });
			expect(json.asset?.filename, String(value)).toBe("download");
		}
	});
});
