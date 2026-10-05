/**
 * Serving a paid digital download (issue #376, increment 3) — the site half of
 * the split the design note settles on: the PLUGIN decides who may download and
 * which file (`entitlements/download`, the delivery gate); the SITE streams the
 * bytes, because a plugin route can neither return a byte stream nor read R2.
 *
 * ── The flow, every request ───────────────────────────────────────────────
 *  1. Dispatch the gate in-process with `{orderId, sku}` from the URL. Nothing is
 *     minted or cached: access is re-checked on every download, so a full refund
 *     (which revokes, and leaves the order undeliverable) closes the URL at once,
 *     and a replaced file serves the new key the gate now answers.
 *  2. Read ONLY the key the gate answered, from the private `DOWNLOADS` bucket.
 *     The request never names a key: the `sku` is a lookup value the gate bounds,
 *     and nothing else from the request reaches R2. So path traversal is not
 *     filtered here — it is impossible by construction.
 *  3. Stream the object with the headers below; a `Range` gets 206 or 416.
 *
 * ── One 404 ───────────────────────────────────────────────────────────────
 * No such order, no grant, a revoked grant, a refunded or cancelled order, a
 * physical product, no file, a malformed id, and an object missing from the
 * bucket all answer the SAME 404 body, so the endpoint cannot be used to learn
 * which orders exist or what state they are in. Two cases are not refusals and
 * do not pretend to be: BUSY (storage contention) is a 503 with Retry-After, and
 * a dispatch that failed outright is a 503 — a 404 there would tell a paying
 * buyer they own nothing.
 *
 * ── Headers (design note §3) ──────────────────────────────────────────────
 * `Content-Type` is the descriptor's stored type (validated at write: no HTML,
 * SVG or script type gets in) or `application/octet-stream`;
 * `Content-Disposition: attachment` with an RFC 5987 `filename*` and an ASCII
 * fallback, so nothing renders inline; `nosniff`; the same sandbox CSP EmDash's
 * own media route sends, so even a type that slipped through cannot script this
 * origin; `private, no-store` plus the route-cache opt-out (`keepPrivate`);
 * `no-referrer`. `Accept-Ranges` and the object's strong `ETag` are what let a
 * browser resume an interrupted download with `If-Range`.
 */
import {
	ENTITLEMENT_DOWNLOAD_ROUTE,
	type DownloadAssetWire,
	type EntitlementDownloadResult,
} from "@otta-sh/plugin";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { DOWNLOADS_BINDING } from "./downloads-bucket.js";
import { PRIVATE_NO_STORE } from "./no-store.js";
import { BUSY_RETRY_AFTER_SECONDS, dispatchOttaRoute } from "./otta-api.js";

/** The one body every refusal answers. */
export const DOWNLOAD_NOT_FOUND_BODY = "Not found";

/** The prefix every download key carries (`dl/{productId}/{ulid}`, minted by
 *  the server). The gate already refuses any other; re-checked here so a key
 *  outside it is never read whatever the gate's future says. */
const DOWNLOAD_KEY_PREFIX = "dl/";

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/** The CSP EmDash's media route sends on user content, without the image and
 *  style allowances a download never needs. */
const DOWNLOAD_CSP = "sandbox; default-src 'none'";

/** The download URL for one order line. Both segments are percent-encoded, so a
 *  sku can never leave its own path segment. */
export function downloadHref(orderId: string, sku: string): string {
	return `/orders/${encodeURIComponent(orderId)}/download/${encodeURIComponent(sku)}`;
}

/**
 * The `{orderId, sku}` a download URL names, read off the RAW pathname and
 * decoded with `decodeURIComponent` — not from Astro's params, which are only
 * `decodeURI`-decoded and would leave a `/`, `?` or `#` in a sku still escaped.
 * `null` for anything else, or a segment that does not decode.
 */
export function parseDownloadPath(pathname: string): { orderId: string; sku: string } | null {
	const match = /\/orders\/([^/]+)\/download\/([^/]+)\/?$/.exec(pathname);
	if (match === null) return null;
	try {
		return { orderId: decodeURIComponent(match[1]!), sku: decodeURIComponent(match[2]!) };
	} catch {
		return null;
	}
}

// ── the bucket, structurally ─────────────────────────────────────────────────

/** What the endpoint reads of an R2 object. */
interface DownloadsObjectMeta {
	size: number;
	httpEtag: string;
}

/** The two R2 binding methods the endpoint uses — structural, so a test can
 *  hand in a fake that records every key it is asked for. */
export interface DownloadsBucket {
	head(key: string): Promise<DownloadsObjectMeta | null>;
	get(
		key: string,
		options?: { range?: { offset: number; length: number } },
	): Promise<(DownloadsObjectMeta & { body: ReadableStream }) | null>;
}

/** The `DOWNLOADS` binding from the Worker's env, or `undefined` when this
 *  deployment has none (downloads are then off). */
export function downloadsBucketFrom(
	env: Record<string, unknown> | undefined,
): DownloadsBucket | undefined {
	const candidate = env?.[DOWNLOADS_BINDING];
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const { head, get } = candidate as Record<string, unknown>;
	return typeof head === "function" && typeof get === "function"
		? (candidate as DownloadsBucket)
		: undefined;
}

// ── Range ────────────────────────────────────────────────────────────────────

export type ByteRange =
	/** No usable Range: serve the whole file (RFC 9110 lets a server ignore a
	 *  malformed or multi-part one). */
	| { kind: "none" }
	/** Inclusive bounds, both inside the object. */
	| { kind: "range"; start: number; end: number }
	/** Well-formed but outside the object: 416. */
	| { kind: "unsatisfiable" };

/** One `bytes=` range against an object of `size` bytes. Multi-part ranges are
 *  ignored (served whole), which RFC 9110 permits and no download client needs. */
export function parseByteRange(header: string | null, size: number): ByteRange {
	if (header === null) return { kind: "none" };
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return { kind: "none" };
	const [, rawStart = "", rawEnd = ""] = match;
	if (rawStart === "" && rawEnd === "") return { kind: "none" };
	const start = rawStart === "" ? undefined : Number(rawStart);
	const end = rawEnd === "" ? undefined : Number(rawEnd);
	if (
		(start !== undefined && !Number.isSafeInteger(start)) ||
		(end !== undefined && !Number.isSafeInteger(end))
	) {
		return { kind: "none" };
	}
	if (start === undefined) {
		// A suffix: the last `end` bytes.
		if (end === 0 || size === 0) return { kind: "unsatisfiable" };
		return { kind: "range", start: Math.max(0, size - end!), end: size - 1 };
	}
	if (end !== undefined && end < start) return { kind: "none" };
	if (start >= size) return { kind: "unsatisfiable" };
	return { kind: "range", start, end: Math.min(end ?? size - 1, size - 1) };
}

// ── Content-Disposition ──────────────────────────────────────────────────────

/** Lone UTF-16 surrogates → U+FFFD, so `encodeURIComponent` cannot throw. The
 *  write path refuses them; the encoder does not rely on that. */
function wellFormed(text: string): string {
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"�",
	);
}

/** The ASCII fallback for `filename=`: accents folded away, then anything but a
 *  conservative set of printable characters (no quote, backslash, `;`, control
 *  character or non-ASCII) becomes `_`. Runs of `_` collapse. */
function asciiFilename(name: string): string {
	const folded = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
	const safe = folded
		.replace(/[^A-Za-z0-9 ._()+,-]+/g, "_")
		.replace(/_+/g, "_")
		.trim();
	return /[A-Za-z0-9]/.test(safe) ? safe : "download";
}

/** RFC 5987 `attr-char` only: `encodeURIComponent` leaves `'()*` bare, which
 *  the grammar does not allow in an ext-value. */
function rfc5987(text: string): string {
	return encodeURIComponent(text).replace(
		/['()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * `attachment; filename="<ascii>"; filename*=UTF-8''<pct-encoded>`. Browsers
 * use `filename*` and fall back to `filename`. Neither part can carry a CR, LF
 * or quote, so no filename can end the header or start another. The filename
 * is validated when it is written (increment 1); this encoder is safe for any
 * string regardless.
 */
export function contentDisposition(filename: string): string {
	const name = wellFormed(filename);
	return `attachment; filename="${asciiFilename(name)}"; filename*=UTF-8''${rfc5987(name)}`;
}

// ── responses ────────────────────────────────────────────────────────────────

/** Headers every answer carries, refusal or file. */
function baseHeaders(): Headers {
	return new Headers({
		"Cache-Control": PRIVATE_NO_STORE,
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	});
}

function notFound(): Response {
	const headers = baseHeaders();
	headers.set("Content-Type", "text/plain; charset=utf-8");
	return new Response(DOWNLOAD_NOT_FOUND_BODY, { status: 404, headers });
}

function unavailable(retryAfter: boolean): Response {
	const headers = baseHeaders();
	headers.set("Content-Type", "text/plain; charset=utf-8");
	if (retryAfter) headers.set("Retry-After", String(BUSY_RETRY_AFTER_SECONDS));
	return new Response("The store is busy. Please try again in a moment.", {
		status: 503,
		headers,
	});
}

function fileHeaders(asset: DownloadAssetWire, object: DownloadsObjectMeta): Headers {
	const headers = baseHeaders();
	headers.set(
		"Content-Type",
		typeof asset.contentType === "string" && asset.contentType.length > 0
			? asset.contentType
			: FALLBACK_CONTENT_TYPE,
	);
	headers.set("Content-Disposition", contentDisposition(asset.filename));
	headers.set("Content-Security-Policy", DOWNLOAD_CSP);
	headers.set("Accept-Ranges", "bytes");
	headers.set("ETag", object.httpEtag);
	return headers;
}

export interface DownloadRequest {
	method: "GET" | "HEAD";
	url: URL;
	headers: Headers;
}

export interface DownloadDeps {
	/** `locals.emdash.handlePublicPluginApiRoute` — the in-process dispatcher. */
	handler: PublicPluginApiRouteHandler | undefined;
	/** The private bucket, or `undefined` when the deployment has none. */
	bucket: DownloadsBucket | undefined;
}

/** Ask the gate. `null` ⇔ the dispatch itself failed. */
async function askGate(
	deps: DownloadDeps,
	orderId: string,
	sku: string,
	baseUrl: URL,
): Promise<EntitlementDownloadResult | null> {
	return dispatchOttaRoute<EntitlementDownloadResult>(
		deps.handler,
		ENTITLEMENT_DOWNLOAD_ROUTE,
		// Exactly these two. A session would be ignored by the gate (ADR-0011
		// amendment), so it is not sent; a key or path never is.
		{ orderId, sku },
		baseUrl,
	);
}

/** Serve one download request end to end. Never throws for a refusal. */
export async function serveDownload(
	deps: DownloadDeps,
	request: DownloadRequest,
): Promise<Response> {
	const named = parseDownloadPath(request.url.pathname);
	if (named === null) return notFound();
	const { bucket } = deps;
	if (bucket === undefined) {
		// Not a buyer's problem to see, and not a reason to ask the gate: nothing
		// could be served. The order pages draw no link without the binding.
		console.error(
			`[site-staging] download refused: no ${DOWNLOADS_BINDING} R2 binding on this deployment`,
		);
		return notFound();
	}

	const result = await askGate(deps, named.orderId, named.sku, request.url);
	if (result === null) return unavailable(false);
	// BUSY is the gate's own refusal shape (`reason`), not the storefront
	// routes' `{ok: false, error: "BUSY"}`, so `dispatchOttaRoute` does not retry
	// it: the buyer's next click is the retry, and Retry-After says when.
	if (!result.authorized && result.reason === "BUSY") return unavailable(true);
	if (!result.authorized) return notFound();

	const { asset } = result;
	if (typeof asset.key !== "string" || !asset.key.startsWith(DOWNLOAD_KEY_PREFIX)) {
		console.error(
			`[site-staging] download refused: gate answered a key outside ${DOWNLOAD_KEY_PREFIX}`,
		);
		return notFound();
	}
	const missing = (): Response => {
		// The descriptor points at bytes that are not there — a merchant's file is
		// unreachable for every buyer until it is re-uploaded.
		console.error(`[site-staging] download object missing from ${DOWNLOADS_BINDING}: ${asset.key}`);
		return notFound();
	};

	const rangeHeader = request.headers.get("Range");
	if (rangeHeader === null) {
		if (request.method === "HEAD") {
			const meta = await bucket.head(asset.key);
			if (meta === null) return missing();
			const headers = fileHeaders(asset, meta);
			headers.set("Content-Length", String(meta.size));
			return new Response(null, { status: 200, headers });
		}
		const object = await bucket.get(asset.key);
		if (object === null) return missing();
		const headers = fileHeaders(asset, object);
		headers.set("Content-Length", String(object.size));
		return new Response(object.body, { status: 200, headers });
	}

	// A Range needs the object's size (and ETag, for If-Range) BEFORE the read.
	const meta = await bucket.head(asset.key);
	if (meta === null) return missing();
	const ifRange = request.headers.get("If-Range");
	const range =
		ifRange !== null && ifRange !== meta.httpEtag
			? ({ kind: "none" } as const)
			: parseByteRange(rangeHeader, meta.size);

	if (range.kind === "unsatisfiable") {
		const headers = baseHeaders();
		headers.set("Content-Range", `bytes */${meta.size}`);
		return new Response(null, { status: 416, headers });
	}
	if (range.kind === "none") {
		const headers = fileHeaders(asset, meta);
		headers.set("Content-Length", String(meta.size));
		if (request.method === "HEAD") return new Response(null, { status: 200, headers });
		const object = await bucket.get(asset.key);
		if (object === null) return missing();
		return new Response(object.body, { status: 200, headers });
	}

	const length = range.end - range.start + 1;
	const headers = fileHeaders(asset, meta);
	headers.set("Content-Range", `bytes ${range.start}-${range.end}/${meta.size}`);
	headers.set("Content-Length", String(length));
	if (request.method === "HEAD") return new Response(null, { status: 206, headers });
	const object = await bucket.get(asset.key, { range: { offset: range.start, length } });
	if (object === null) return missing();
	return new Response(object.body, { status: 206, headers });
}
