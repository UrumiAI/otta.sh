/**
 * `GET|HEAD /orders/<orderId>/download/<sku>` — the site streams a paid file
 * from its private `DOWNLOADS` bucket (issue #376, increment 3).
 *
 * WHAT IS PROVEN HERE, AND WHAT IS NOT. The plugin's `entitlements/download`
 * route is the delivery gate — active grant, deliverable order, digital product,
 * a file bound to this product — and its own suites prove it against a real
 * store, in-process and in the workerd sandbox (36 + 37 contract cases). This
 * suite proves the SITE half, against the gate's observable contract:
 *  - the endpoint asks the gate with exactly `{orderId, sku}` and reads ONLY
 *    the key the gate answers — never one from the request;
 *  - every refusal is the same 404 and touches no object;
 *  - BUSY is a 503 with Retry-After; a missing object is a 404 (logged);
 *  - the exact response headers, Range (206 / 416) and HEAD.
 * The fake bucket records every key it is asked for, which is what turns "a
 * `../` sku never reaches R2" from a claim into an assertion. The browser pass
 * recorded on the PR drives the real gate: buy, download, refund, 404.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { APIContext } from "astro";
import {
	ENTITLEMENT_DOWNLOAD_ROUTE,
	type DownloadAssetWire,
	type EntitlementDownloadResult,
} from "@otta-sh/plugin";
import { env as virtualEnv } from "./helpers/virtual-emdash-env.js";
// Astro's own URL normalization (not exported; imported by file, as the dev
// server and the Worker run it on every request — fetch-state.js).
import { normalizeUrl } from "../node_modules/astro/dist/core/util/normalized-url.js";
import { BUSY_RETRY_AFTER_SECONDS } from "../src/lib/otta-api.js";
import {
	contentDisposition,
	DOWNLOAD_CACHE_CONTROL,
	DOWNLOAD_NOT_FOUND_TITLE,
	downloadHref,
	parseByteRange,
	parseDownloadPath,
	rangeRequest,
} from "../src/lib/download-delivery.js";
import { DOWNLOADS_BINDING } from "../src/lib/downloads-bucket.js";
import { GET, HEAD } from "../src/pages/orders/[orderId]/download/[sku].js";

const SITE = "http://localhost:4321";
const ORDER = "0b6f3c1e-6f7a-4d55-9f1e-2c3d4e5f6a7b";
const SKU = "EBOOK-01";
const KEY = "dl/prod_1/01JABCDEFGHJKMNPQRSTVWXYZ0";
const BYTES = new TextEncoder().encode("0123456789abcdefghijklmnopqrstuvwxyz");

const ASSET: DownloadAssetWire = {
	key: KEY,
	filename: "Field Guide.pdf",
	contentType: "application/pdf",
	size: BYTES.length,
	sha256: createHash("sha256").update(BYTES).digest("hex"),
};

// ── the fake bucket ──────────────────────────────────────────────────────────

interface BucketCall {
	op: "head" | "get";
	key: string;
	range?: unknown;
	onlyIf?: unknown;
}

type FakeRange = { offset: number; length?: number } | { suffix: number };

/** R2's observable `get`/`head`: a range starting past the end REJECTS (as R2
 *  does), a longer one is clamped, and a failed `onlyIf` answers metadata with
 *  no `body`. Every call is recorded. */
function makeBucket(objects: Record<string, Uint8Array> = { [KEY]: BYTES }) {
	const calls: BucketCall[] = [];
	const meta = (key: string) => ({
		key,
		size: objects[key]!.length,
		httpEtag: `"etag-${key.length}"`,
	});
	const bucket = {
		async head(key: string) {
			calls.push({ op: "head", key });
			return key in objects ? meta(key) : null;
		},
		async get(key: string, options?: { range?: FakeRange; onlyIf?: { etagMatches: string } }) {
			calls.push({
				op: "get",
				key,
				...(options?.range !== undefined ? { range: options.range } : {}),
				...(options?.onlyIf !== undefined ? { onlyIf: options.onlyIf } : {}),
			});
			const bytes = objects[key];
			if (bytes === undefined) return null;
			if (
				options?.onlyIf !== undefined &&
				`"${options.onlyIf.etagMatches}"` !== meta(key).httpEtag
			) {
				return meta(key);
			}
			let start = 0;
			let end = bytes.length;
			const range = options?.range;
			if (range !== undefined) {
				if ("suffix" in range) {
					start = Math.max(0, bytes.length - range.suffix);
				} else {
					if (range.offset >= bytes.length)
						throw new Error("get: The requested range is not satisfiable (10039)");
					start = range.offset;
					end =
						range.length === undefined
							? bytes.length
							: Math.min(bytes.length, start + range.length);
				}
			}
			const slice = bytes.slice(start, end);
			return {
				...meta(key),
				...(range !== undefined ? { range } : {}),
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(slice);
						controller.close();
					},
				}),
			};
		},
	};
	return { bucket, calls };
}

// ── the fake gate ────────────────────────────────────────────────────────────

interface GateCall {
	route: string;
	input: Record<string, unknown>;
}

/** The plugin's public dispatcher, answering `answer(input)` in the framework's
 *  `{success: true, data}` envelope (or a raw envelope for a dispatch failure). */
function makeGate(
	answer: (input: Record<string, unknown>) => EntitlementDownloadResult | { success: false },
) {
	const calls: GateCall[] = [];
	const handler = async (_pluginId: string, _method: string, path: string, request: Request) => {
		const input = (await request.json()) as Record<string, unknown>;
		calls.push({ route: path.replace(/^\//, ""), input });
		const result = answer(input);
		return "success" in result ? result : { success: true, data: result };
	};
	return { handler, calls };
}

/** The gate for one entitled (order, sku): the asset for exactly that pair, the
 *  one NOT_FOUND for everything else. */
const entitledGate = (asset: DownloadAssetWire = ASSET, sku: string = SKU) =>
	makeGate((input) =>
		input["orderId"] === ORDER && input["sku"] === sku
			? { authorized: true, sku, asset }
			: { authorized: false, reason: "NOT_FOUND" },
	);

const NOT_FOUND_GATE = () => makeGate(() => ({ authorized: false, reason: "NOT_FOUND" }));

// ── the request ──────────────────────────────────────────────────────────────

function makeContext(
	handler: unknown,
	options: {
		method?: "GET" | "HEAD";
		orderId?: string;
		sku?: string;
		headers?: Record<string, string>;
		path?: string;
	} = {},
) {
	const orderId = options.orderId ?? ORDER;
	const sku = options.sku ?? SKU;
	const raw = new URL(
		options.path ?? `/orders/${encodeURIComponent(orderId)}/download/${encodeURIComponent(sku)}`,
		SITE,
	);
	const request = new Request(raw, { method: options.method ?? "GET", headers: options.headers });
	const cache = { set: vi.fn() };
	const context = {
		request,
		// What Astro 7 really hands an endpoint: the request URL put through its
		// own `normalizeUrl` (repeated decodeURI). The endpoint must not read it.
		url: normalizeUrl(new URL(raw)),
		params: { orderId, sku },
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		cache,
	} as unknown as APIContext;
	return { context, cache };
}

async function bodyBytes(response: Response): Promise<Uint8Array> {
	return new Uint8Array(await response.arrayBuffer());
}

let bucketCalls: BucketCall[];
let errorSpy: ReturnType<typeof vi.spyOn>;

function provision(objects?: Record<string, Uint8Array>): void {
	const made = makeBucket(objects);
	virtualEnv[DOWNLOADS_BINDING] = made.bucket;
	bucketCalls = made.calls;
}

beforeEach(() => {
	provision();
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	delete virtualEnv[DOWNLOADS_BINDING];
	vi.restoreAllMocks();
});

// ── the success path ─────────────────────────────────────────────────────────

describe("an entitled download streams the file the gate named", () => {
	test("200 with the exact bytes, read from the gate's key only", async () => {
		const gate = entitledGate();
		const response = await GET(makeContext(gate.handler).context);

		expect(response.status).toBe(200);
		expect(await bodyBytes(response)).toEqual(BYTES);
		expect(gate.calls).toEqual([
			{ route: ENTITLEMENT_DOWNLOAD_ROUTE, input: { orderId: ORDER, sku: SKU } },
		]);
		expect(bucketCalls).toEqual([{ op: "get", key: KEY }]);
	});

	test("the exact response headers", async () => {
		expect(DOWNLOAD_CACHE_CONTROL).toBe("private, no-store, no-transform");
		const response = await GET(makeContext(entitledGate().handler).context);
		const headers = Object.fromEntries(response.headers);

		expect(headers).toEqual({
			"accept-ranges": "bytes",
			"cache-control": DOWNLOAD_CACHE_CONTROL,
			"content-disposition": `attachment; filename="Field Guide.pdf"; filename*=UTF-8''Field%20Guide.pdf`,
			"content-length": String(BYTES.length),
			"content-security-policy": "sandbox; default-src 'none'",
			"content-type": "application/pdf",
			etag: `"etag-${KEY.length}"`,
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		});
	});

	test("the response is kept out of Astro's route cache too (keepPrivate)", async () => {
		const { context, cache } = makeContext(entitledGate().handler);
		await GET(context);
		expect(cache.set).toHaveBeenCalledWith(false);
	});

	test("an empty stored type falls back to application/octet-stream", async () => {
		const response = await GET(
			makeContext(entitledGate({ ...ASSET, contentType: "" }).handler).context,
		);
		expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
	});

	test("a replaced file serves the NEW key the gate answers", async () => {
		const NEW_KEY = "dl/prod_1/01JNEWNEWNEWNEWNEWNEWNEWNE";
		const NEW_BYTES = new TextEncoder().encode("version two");
		provision({ [KEY]: BYTES, [NEW_KEY]: NEW_BYTES });
		const response = await GET(
			makeContext(entitledGate({ ...ASSET, key: NEW_KEY, size: NEW_BYTES.length }).handler).context,
		);
		expect(await bodyBytes(response)).toEqual(NEW_BYTES);
		expect(bucketCalls.map((c) => c.key)).toEqual([NEW_KEY]);
	});

	test("the object's own size wins over a stale descriptor size", async () => {
		const response = await GET(makeContext(entitledGate({ ...ASSET, size: 3 }).handler).context);
		expect(response.headers.get("Content-Length")).toBe(String(BYTES.length));
	});
});

// ── refusals ─────────────────────────────────────────────────────────────────

/** The refusal page for a URL naming `orderId` — captured once from a plain
 *  NOT_FOUND, so every other refusal is compared byte for byte against it. */
async function referenceRefusal(orderId: string = ORDER): Promise<string> {
	// A NOT_FOUND gate never reaches the bucket, so this records no call.
	const response = await GET(makeContext(NOT_FOUND_GATE().handler, { orderId }).context);
	return response.text();
}

/** The one refusal: same status, same body, private, and no file headers. */
async function expectNotFound(response: Response, orderId: string = ORDER): Promise<void> {
	expect(response.status).toBe(404);
	const body = await response.text();
	expect(body).toBe(await referenceRefusal(orderId));
	expect(body).toContain(DOWNLOAD_NOT_FOUND_TITLE);
	expect(body).toContain(`href="/orders/${encodeURIComponent(orderId)}"`);
	expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(response.headers.get("Content-Disposition")).toBeNull();
}

describe("every refusal is the same 404, and no object is touched", () => {
	test("a wrong orderId", async () => {
		const gate = entitledGate();
		await expectNotFound(
			await GET(makeContext(gate.handler, { orderId: "not-my-order" }).context),
			"not-my-order",
		);
		expect(gate.calls[0]?.input).toEqual({ orderId: "not-my-order", sku: SKU });
		expect(bucketCalls).toEqual([]);
	});

	test("a wrong sku", async () => {
		const gate = entitledGate();
		await expectNotFound(await GET(makeContext(gate.handler, { sku: "OTHER-SKU" }).context));
		expect(bucketCalls).toEqual([]);
	});

	// The gate answers these from stored state (its contract suite seeds each
	// one); what the site must do is answer them identically.
	test.each([
		["a revoked grant (full refund)"],
		["a physical product"],
		["a digital product with no file"],
		["an order that is not deliverable"],
	])("%s — the gate's NOT_FOUND", async () => {
		await expectNotFound(await GET(makeContext(NOT_FOUND_GATE().handler).context));
		expect(bucketCalls).toEqual([]);
	});

	test("INVALID_INPUT is the same 404 (nothing says the shape was wrong)", async () => {
		const gate = makeGate(() => ({ authorized: false, reason: "INVALID_INPUT" }));
		await expectNotFound(await GET(makeContext(gate.handler).context));
		expect(bucketCalls).toEqual([]);
	});

	test("an object missing from the bucket is a 404, and is logged", async () => {
		provision({});
		await expectNotFound(await GET(makeContext(entitledGate().handler).context));
		expect(bucketCalls).toEqual([{ op: "get", key: KEY }]);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(KEY));
	});

	test("no DOWNLOADS binding: 404 without asking the gate, and logged", async () => {
		delete virtualEnv[DOWNLOADS_BINDING];
		const gate = entitledGate();
		await expectNotFound(await GET(makeContext(gate.handler).context));
		expect(gate.calls).toEqual([]);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(DOWNLOADS_BINDING));
	});

	test("a key the gate answers outside dl/ is never read (defence in depth)", async () => {
		await expectNotFound(
			await GET(makeContext(entitledGate({ ...ASSET, key: "media/public.jpg" }).handler).context),
		);
		expect(bucketCalls).toEqual([]);
	});
});

describe("the request never names the key", () => {
	test.each([
		["../dl/prod_2/secret"],
		["..%2Fdl%2Fprod_2%2Fsecret"],
		["%2e%2e/%2e%2e/dl/x"],
		["dl/prod_1/01JABCDEFGHJKMNPQRSTVWXYZ0"],
		["EBOOK-01\r\nX-Injected: 1"],
	])("sku %j goes to the gate as a lookup value; R2 sees only the gate's key", async (sku) => {
		const gate = entitledGate();
		const response = await GET(makeContext(gate.handler, { sku }).context);
		expect(response.status).toBe(404);
		expect(gate.calls[0]?.input).toEqual({ orderId: ORDER, sku });
		expect(bucketCalls).toEqual([]);
	});

	test("even when the gate authorizes, a query-string key is ignored", async () => {
		const { context } = makeContext(entitledGate().handler, {
			path: `/orders/${ORDER}/download/${SKU}?key=dl/prod_2/other`,
		});
		await GET(context);
		expect(bucketCalls.map((c) => c.key)).toEqual([KEY]);
	});
});

// ── busy and unavailable ─────────────────────────────────────────────────────

describe("BUSY and a failed dispatch", () => {
	test("BUSY is the site's busy page: 503, Retry-After, and a way back to the order", async () => {
		const gate = makeGate(() => ({ authorized: false, reason: "BUSY", retryable: true }));
		const response = await GET(makeContext(gate.handler).context);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		const html = await response.text();
		expect(html).toContain(`<a href="/orders/${ORDER}">Go back</a>`);
		// The gate's BUSY is not the storefront routes' shape, so no automatic
		// retry: one ask, and the buyer's next click is the retry.
		expect(gate.calls).toHaveLength(1);
		expect(bucketCalls).toEqual([]);
	});

	test("a failed dispatch is 503, not a 404 that would tell a buyer they own nothing", async () => {
		const gate = makeGate(() => ({ success: false }));
		const response = await GET(makeContext(gate.handler).context);
		expect(response.status).toBe(503);
		expect(bucketCalls).toEqual([]);
	});
});

// ── Range ────────────────────────────────────────────────────────────────────

describe("Range", () => {
	test("bytes=10-19 → 206 with exactly those bytes and Content-Range", async () => {
		const response = await GET(
			makeContext(entitledGate().handler, { headers: { Range: "bytes=10-19" } }).context,
		);
		expect(response.status).toBe(206);
		expect(response.headers.get("Content-Range")).toBe(`bytes 10-19/${BYTES.length}`);
		expect(response.headers.get("Content-Length")).toBe("10");
		expect(await bodyBytes(response)).toEqual(BYTES.slice(10, 20));
		// ONE read: the headers come from the object the bytes come from.
		expect(bucketCalls).toEqual([{ op: "get", key: KEY, range: { offset: 10, length: 10 } }]);
		// The security headers ride the partial response too.
		expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
		expect(response.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
	});

	test("an open range (bytes=30-) and a suffix (bytes=-4)", async () => {
		const open = await GET(
			makeContext(entitledGate().handler, { headers: { Range: "bytes=30-" } }).context,
		);
		expect(open.status).toBe(206);
		expect(await bodyBytes(open)).toEqual(BYTES.slice(30));
		const suffix = await GET(
			makeContext(entitledGate().handler, { headers: { Range: "bytes=-4" } }).context,
		);
		expect(suffix.headers.get("Content-Range")).toBe(
			`bytes ${BYTES.length - 4}-${BYTES.length - 1}/${BYTES.length}`,
		);
		expect(await bodyBytes(suffix)).toEqual(BYTES.slice(-4));
		expect(bucketCalls).toEqual([
			{ op: "get", key: KEY, range: { offset: 30 } },
			{ op: "get", key: KEY, range: { suffix: 4 } },
		]);
	});

	test("a range running past the end is clamped (206 to the last byte)", async () => {
		const response = await GET(
			makeContext(entitledGate().handler, { headers: { Range: "bytes=30-999" } }).context,
		);
		expect(response.status).toBe(206);
		expect(response.headers.get("Content-Range")).toBe(
			`bytes 30-${BYTES.length - 1}/${BYTES.length}`,
		);
		expect(response.headers.get("Content-Length")).toBe(String(BYTES.length - 30));
		expect(await bodyBytes(response)).toEqual(BYTES.slice(30));
	});

	test("a range past the end → 416 with bytes */size (R2 rejects the read; head() supplies the size)", async () => {
		const response = await GET(
			makeContext(entitledGate().handler, { headers: { Range: `bytes=${BYTES.length}-` } }).context,
		);
		expect(response.status).toBe(416);
		expect(response.headers.get("Content-Range")).toBe(`bytes */${BYTES.length}`);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(bucketCalls).toEqual([
			{ op: "get", key: KEY, range: { offset: BYTES.length } },
			{ op: "head", key: KEY },
		]);
	});

	test("bytes=-0 is 416 without reading any bytes", async () => {
		const response = await GET(
			makeContext(entitledGate().handler, { headers: { Range: "bytes=-0" } }).context,
		);
		expect(response.status).toBe(416);
		expect(bucketCalls).toEqual([{ op: "head", key: KEY }]);
	});

	test("a refused request never reaches the range logic (404, not 416)", async () => {
		const response = await GET(
			makeContext(NOT_FOUND_GATE().handler, { headers: { Range: "bytes=999-" } }).context,
		);
		expect(response.status).toBe(404);
		expect(bucketCalls).toEqual([]);
	});

	test("a matching If-Range is ONE conditional ranged read → 206", async () => {
		const response = await GET(
			makeContext(entitledGate().handler, {
				headers: { Range: "bytes=0-1", "If-Range": `"etag-${KEY.length}"` },
			}).context,
		);
		expect(response.status).toBe(206);
		expect(await bodyBytes(response)).toEqual(BYTES.slice(0, 2));
		expect(bucketCalls).toEqual([
			{
				op: "get",
				key: KEY,
				range: { offset: 0, length: 2 },
				onlyIf: { etagMatches: `etag-${KEY.length}` },
			},
		]);
	});

	test("an If-Range that does not match the object's ETag gets the whole file", async () => {
		const response = await GET(
			makeContext(entitledGate().handler, {
				headers: { Range: "bytes=0-1", "If-Range": '"stale"' },
			}).context,
		);
		expect(response.status).toBe(200);
		expect(await bodyBytes(response)).toEqual(BYTES);
	});

	test("a weak or date If-Range can never match: the whole file, one plain read", async () => {
		for (const ifRange of [`W/"etag-${KEY.length}"`, "Wed, 21 Oct 2026 07:28:00 GMT"]) {
			provision();
			const response = await GET(
				makeContext(entitledGate().handler, {
					headers: { Range: "bytes=0-1", "If-Range": ifRange },
				}).context,
			);
			expect(response.status, ifRange).toBe(200);
			expect(bucketCalls).toEqual([{ op: "get", key: KEY }]);
		}
	});

	test("a malformed or multi-part Range is ignored (200, the whole file)", async () => {
		for (const range of ["bytes=5-2", "items=0-1", "bytes=0-1,4-5", "bytes=abc"]) {
			provision();
			const response = await GET(
				makeContext(entitledGate().handler, { headers: { Range: range } }).context,
			);
			expect(response.status, range).toBe(200);
			expect(await bodyBytes(response)).toEqual(BYTES);
		}
	});
});

describe("rangeRequest — the Range header as an R2 range, no size needed", () => {
	test.each([
		["bytes=10-19", { kind: "range", range: { offset: 10, length: 10 } }],
		["bytes=30-", { kind: "range", range: { offset: 30 } }],
		["bytes=-4", { kind: "range", range: { suffix: 4 } }],
		["bytes=-0", { kind: "unsatisfiable" }],
		["bytes=5-2", { kind: "none" }],
		["bytes=0-1,2-3", { kind: "none" }],
		["items=0-1", { kind: "none" }],
		[null, { kind: "none" }],
	] as const)("%j → %j", (header, expected) => {
		expect(rangeRequest(header)).toEqual(expected);
	});
});

describe("a sku holding % (or space, or unicode) round-trips from the link to the gate", () => {
	const SKUS = ["100%COTTON", "A%41", "A%2541", "EBOOK 01", "Café-日本", "a+b&c=d", "50%"];

	test.each(SKUS)(
		"%j: the endpoint, behind Astro's URL normalization, asks the gate for it verbatim",
		async (sku) => {
			const gate = entitledGate(ASSET, sku);
			const response = await GET(makeContext(gate.handler, { sku }).context);
			expect(gate.calls[0]?.input).toEqual({ orderId: ORDER, sku });
			expect(response.status).toBe(200);
			expect(await bodyBytes(response)).toEqual(BYTES);
		},
	);

	test.each(SKUS)(
		"%j: downloadHref → raw request path → parseDownloadPath is the identity",
		(sku) => {
			const href = downloadHref(ORDER, sku);
			const raw = new URL(href, SITE);
			expect(parseDownloadPath(raw.pathname)).toEqual({ orderId: ORDER, sku });
		},
	);
});

describe("parseByteRange", () => {
	test.each([
		["bytes=0-0", 10, { kind: "range", start: 0, end: 0 }],
		["bytes=2-", 10, { kind: "range", start: 2, end: 9 }],
		["bytes=2-999", 10, { kind: "range", start: 2, end: 9 }],
		["bytes=-3", 10, { kind: "range", start: 7, end: 9 }],
		["bytes=-30", 10, { kind: "range", start: 0, end: 9 }],
		[" bytes=1-2 ", 10, { kind: "range", start: 1, end: 2 }],
		["bytes=10-", 10, { kind: "unsatisfiable" }],
		["bytes=-0", 10, { kind: "unsatisfiable" }],
		["bytes=0-", 0, { kind: "unsatisfiable" }],
		["bytes=3-1", 10, { kind: "none" }],
		["bytes=-", 10, { kind: "none" }],
		["bytes=0-1,2-3", 10, { kind: "none" }],
		["bytes=99999999999999999999-", 10, { kind: "none" }],
		[null, 10, { kind: "none" }],
	] as const)("%j of %d → %j", (header, size, expected) => {
		expect(parseByteRange(header, size)).toEqual(expected);
	});
});

// ── HEAD ─────────────────────────────────────────────────────────────────────

describe("HEAD", () => {
	test("the same headers as GET, no body, and only a head() of the object", async () => {
		const response = await HEAD(makeContext(entitledGate().handler, { method: "HEAD" }).context);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Length")).toBe(String(BYTES.length));
		expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
		expect(response.body).toBeNull();
		expect(bucketCalls).toEqual([{ op: "head", key: KEY }]);
	});

	test("refused HEAD is the same 404", async () => {
		const response = await HEAD(makeContext(NOT_FOUND_GATE().handler, { method: "HEAD" }).context);
		expect(response.status).toBe(404);
		expect(bucketCalls).toEqual([]);
	});
});

// ── the filename encoder ─────────────────────────────────────────────────────

describe("contentDisposition — no filename can inject a header", () => {
	test("plain ASCII", () => {
		expect(contentDisposition("guide.pdf")).toBe(
			`attachment; filename="guide.pdf"; filename*=UTF-8''guide.pdf`,
		);
	});

	test("CR/LF, quotes, backslashes and semicolons never reach the header raw", () => {
		const value = contentDisposition('evil"\r\nSet-Cookie: a=b;\\x.pdf');
		expect(value).not.toMatch(/[\r\n]/);
		const [, fallback] = /filename="([^"]*)"/.exec(value) ?? [];
		expect(fallback).toBe("evil_Set-Cookie_ a_b_x.pdf");
		expect(value).toContain("filename*=UTF-8''evil%22%0D%0ASet-Cookie%3A%20a%3Db%3B%5Cx.pdf");
		// And the platform accepts it as a header value.
		expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
	});

	test("unicode goes in filename* (RFC 5987) with an ASCII fallback", () => {
		const value = contentDisposition("Café — résumé 日本.pdf");
		expect(value).toContain(
			`filename*=UTF-8''Caf%C3%A9%20%E2%80%94%20r%C3%A9sum%C3%A9%20%E6%97%A5%E6%9C%AC.pdf`,
		);
		expect(value).toContain(`filename="Cafe _ resume _.pdf"`);
	});

	test("RFC 5987 attr-chars only: ' ( ) * are percent-encoded", () => {
		expect(contentDisposition("it's (1)*.txt")).toContain(
			"filename*=UTF-8''it%27s%20%281%29%2A.txt",
		);
	});

	test("a lone surrogate cannot make the encoder throw", () => {
		expect(() => contentDisposition("bad\uD800name.pdf")).not.toThrow();
		expect(contentDisposition("bad\uD800name.pdf")).toContain("%EF%BF%BD");
	});

	test("a name with nothing printable falls back to 'download'", () => {
		expect(contentDisposition("日本")).toContain(`filename="download"`);
		expect(contentDisposition("")).toContain(`filename="download"`);
	});
});

describe("downloadHref", () => {
	test("both segments are encoded, so a sku cannot leave its path segment", () => {
		expect(downloadHref("o-1", "A/B ?#")).toBe("/orders/o-1/download/A%2FB%20%3F%23");
	});
});
