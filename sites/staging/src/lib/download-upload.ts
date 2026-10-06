/**
 * The merchant's upload of a digital product's file (issue #376, increment 4;
 * ADR-0029) — the site half, because only the site holds the private
 * `DOWNLOADS` bucket: the plugin can neither read nor write R2, and EmDash's own
 * media bucket is public by design (`downloads-bucket.ts`).
 *
 * ── The flow ─────────────────────────────────────────────────────────────────
 *  1. The console (`@otta-sh/admin-react`, the product editor's Download file
 *     card) POSTs the file's raw bytes here, with the file's name in
 *     {@link DOWNLOAD_FILENAME_HEADER} and its type as `Content-Type`.
 *  2. This endpoint checks who is asking, resolves the product through the
 *     plugin's own admin read (as that user), streams the body into the bucket
 *     under a FRESH server-minted key, and answers the descriptor
 *     `{key, filename, contentType, size}`.
 *  3. The console saves that descriptor through the existing `otta` admin route
 *     (`products:attach-download`), where the domain validates it again. This
 *     endpoint writes NO product: the plugin stays the only writer of commerce
 *     truth, and the descriptor's switch is the one moment the file changes.
 *
 * ── Who may upload ───────────────────────────────────────────────────────────
 * A signed-in EmDash user (`locals.user`, which EmDash's auth middleware sets
 * on storefront paths from the admin session cookie) whose role holds
 * `plugins:manage` — ADMIN, the role the `otta` admin route itself requires. A
 * lower role could only orphan bytes: the save that would attach them is
 * refused. A request authenticated by an API token (`locals.tokenScopes`) is
 * refused outright: this is a console action. The request must also carry `X-EmDash-Request: 1`, the custom header
 * EmDash's own authenticated API demands: a cross-site form cannot set it, so it
 * holds even if the site's origin check (the middleware, default-deny, where
 * this route is in the guarded column) were ever loosened.
 *
 * ── What is stored ───────────────────────────────────────────────────────────
 *  - The KEY is `dl/{productId}/{ULID}` from `mintDownloadAssetKey`: the clock
 *    and 80 bits of `crypto.getRandomValues`, and the product id the PLUGIN
 *    answered — nothing else from the request. A fresh key per upload.
 *  - The TYPE is the declared one through `downloadContentTypeFor`: kept when it
 *    is on the allowlist increment 1 validates, `application/octet-stream`
 *    otherwise (HTML, SVG, script, malformed, missing).
 *  - The FILENAME is the header's, percent-decoded, through
 *    `sanitizeDownloadFilename`: a name, never a path; `download` when nothing
 *    usable is left.
 *  - The body is STREAMED to R2, never buffered: a Worker passes a request body
 *    with a known length straight through.
 *
 * ── Size ─────────────────────────────────────────────────────────────────────
 * Cloudflare refuses request bodies over 100 MB on the Free and Pro plans before
 * the Worker runs, with its own error page. The endpoint refuses anything over
 * {@link MAX_DOWNLOAD_UPLOAD_BYTES} (100,000,000 bytes: under the limit however
 * "MB" is counted) first, from the declared `Content-Length`, with a sentence the
 * console shows — and the console checks the file's size before it sends a byte.
 * Larger files need a presigned multipart upload, out of scope for v1.
 *
 * ── A replaced file ──────────────────────────────────────────────────────────
 * Replacing uploads a NEW object under a new key; the old object is NOT deleted.
 * Deleting it here (or at the save) could cut off a buyer's download already in
 * flight, and an upload whose save never happens (a closed tab) leaves an object
 * nothing points at either. Both are orphans by design in v1: they cost storage,
 * never access — nothing serves a key the descriptor does not name. DEPLOYMENT.md
 * says how to find and remove them.
 */
import {
	CONSOLE_READ_INTERACTION,
	DOWNLOAD_KEY_RANDOM_BYTES,
	downloadContentTypeFor,
	mintDownloadAssetKey,
	sanitizeDownloadFilename,
} from "@otta-sh/plugin";
import { DOWNLOADS_BINDING } from "./downloads-bucket.js";
import { PRIVATE_NO_STORE } from "./no-store.js";
import { BUSY_RETRY_AFTER_SECONDS } from "./otta-api.js";

/** The route's path prefix. Not under `/_`, so the site's origin middleware
 *  guards it (EmDash guards only its own `/_emdash` paths). */
export const DOWNLOAD_UPLOAD_PATH_PREFIX = "/otta-admin/downloads/";

/** The upload URL for one product. */
export function downloadUploadPath(productId: string): string {
	return `${DOWNLOAD_UPLOAD_PATH_PREFIX}${encodeURIComponent(productId)}`;
}

/** The header carrying the file's name, percent-encoded (UTF-8): a header value
 *  cannot carry most non-ASCII names as they are. */
export const DOWNLOAD_FILENAME_HEADER = "X-Otta-Filename";

/** The largest upload accepted, in bytes — below Cloudflare's 100 MB request
 *  limit (Free/Pro) whether that is counted in decimal or binary megabytes. */
export const MAX_DOWNLOAD_UPLOAD_BYTES = 100_000_000;

/** The role level `@emdash-cms/auth`'s permission table gives `plugins:manage`
 *  (ADMIN) — the permission the `otta` admin route, and so the descriptor's
 *  save, requires. A constant because the site does not depend on
 *  `@emdash-cms/auth`; `test/download-upload.test.ts` reads the INSTALLED table
 *  and fails if the two ever disagree. */
export const UPLOAD_MIN_ROLE = 50;

/** A product id the endpoint will look up: the CMS's ids are ULIDs, and this
 *  shape keeps anything else (a slash, a dot segment, a space) out of the key. */
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A `Content-Length` value: a plain non-negative whole number. */
const BYTE_COUNT = /^(0|[1-9][0-9]{0,15})$/;

// ── collaborators, structurally ──────────────────────────────────────────────

/** The signed-in EmDash user, as far as this endpoint reads it. */
export interface UploadUser {
	readonly id: string;
	readonly role: number;
}

/** The two R2 binding methods the endpoint uses — structural, so a test hands
 *  in a fake that records every key. */
export interface UploadBucket {
	put(
		key: string,
		body: ReadableStream<Uint8Array>,
		options: {
			httpMetadata: { contentType: string };
			customMetadata: Record<string, string>;
		},
	): Promise<{ size: number } | null>;
	delete(key: string): Promise<void>;
}

/** The `DOWNLOADS` binding from the Worker's env, or `undefined` when the
 *  deployment has none (or the binding cannot write). */
export function uploadBucketFrom(
	env: Record<string, unknown> | undefined,
): UploadBucket | undefined {
	const candidate = env?.[DOWNLOADS_BINDING];
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const { put, delete: remove } = candidate as Record<string, unknown>;
	return typeof put === "function" && typeof remove === "function"
		? (candidate as UploadBucket)
		: undefined;
}

/** What the plugin's admin read said about the product. */
export type ProductLookup =
	| {
			readonly kind: "found";
			readonly productId: string;
			readonly productKind: string;
			readonly deletedAt: string | null;
	  }
	| { readonly kind: "refused"; readonly message: string }
	| { readonly kind: "busy" }
	| { readonly kind: "failed" };

/** The in-process dispatcher for an authenticated plugin route —
 *  `locals.emdash.handlePluginApiRoute`, the same call EmDash's own
 *  `/_emdash/api/plugins/<id>/<path>` endpoint makes once it has checked the
 *  caller. */
export type PluginRouteDispatcher = (
	pluginId: string,
	method: string,
	path: string,
	request: Request,
	user?: unknown,
) => Promise<unknown>;

/**
 * Resolve a product through the plugin's own admin read (`products.detail` on
 * the `otta` admin route), dispatched in-process with the signed-in user as the
 * caller — the read the console itself makes. Only call it once the user is
 * known to hold `plugins:manage`: EmDash's HTTP endpoint checks that before it
 * dispatches, and this call stands in for that endpoint.
 */
export async function lookupProduct(
	dispatch: PluginRouteDispatcher | undefined,
	productId: string,
	user: UploadUser,
	baseUrl: URL,
): Promise<ProductLookup> {
	if (dispatch === undefined) return { kind: "failed" };
	let envelope: unknown;
	try {
		envelope = await dispatch(
			"otta",
			"POST",
			"/admin",
			new Request(new URL("/_emdash/api/plugins/otta/admin", baseUrl), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: CONSOLE_READ_INTERACTION,
					resource: "products.detail",
					productId,
				}),
			}),
			user,
		);
	} catch (error) {
		console.error("[site-staging] download upload: the product read failed", error);
		return { kind: "failed" };
	}
	const { success, data } = (envelope ?? {}) as { success?: unknown; data?: unknown };
	if (success !== true || typeof data !== "object" || data === null) return { kind: "failed" };
	const answer = data as Record<string, unknown>;
	if (answer["ok"] === false) {
		if (answer["retryable"] === true) return { kind: "busy" };
		// The plugin's own refusal — "Product not found" and its sentence — is
		// passed through: its words are better than any this tier could invent.
		const words = [answer["title"], answer["description"]].filter(
			(part): part is string => typeof part === "string" && part.length > 0,
		);
		return { kind: "refused", message: words.join(". ") || "No product matches that id." };
	}
	const product = answer["product"];
	if (answer["ok"] !== true || typeof product !== "object" || product === null) {
		return { kind: "failed" };
	}
	const row = product as Record<string, unknown>;
	if (typeof row["productId"] !== "string" || typeof row["productKind"] !== "string") {
		return { kind: "failed" };
	}
	return {
		kind: "found",
		productId: row["productId"],
		productKind: row["productKind"],
		deletedAt: typeof row["deletedAt"] === "string" ? row["deletedAt"] : null,
	};
}

// ── answers ──────────────────────────────────────────────────────────────────

/** The descriptor the console saves (the plugin's `DownloadAssetWire`, minus the
 *  optional digest, which this endpoint does not compute). */
export interface UploadedAsset {
	readonly key: string;
	readonly filename: string;
	readonly contentType: string;
	readonly size: number;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": PRIVATE_NO_STORE,
			"X-Content-Type-Options": "nosniff",
			...extra,
		},
	});
}

/** A refusal: `{ok: false, error: {code, message}}`, the code for a program and
 *  the message for the merchant (the console shows it as written). */
function refuse(
	status: number,
	code: string,
	message: string,
	extra: Record<string, string> = {},
): Response {
	return json(status, { ok: false, error: { code, message } }, extra);
}

const MEGABYTES = MAX_DOWNLOAD_UPLOAD_BYTES / 1_000_000;

/** The header's name, percent-decoded once; `null` when absent or undecodable
 *  (the sanitiser then answers `download`). */
function declaredFilename(headers: Headers): string | null {
	const raw = headers.get(DOWNLOAD_FILENAME_HEADER);
	if (raw === null) return null;
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

export interface UploadDeps {
	readonly user: UploadUser | undefined;
	/** The request was authenticated by an API or OAuth token
	 *  (`locals.tokenScopes` set), not by an admin session. Refused: the upload
	 *  is a console action, and a token's scopes say nothing about it. */
	readonly tokenAuthenticated: boolean;
	readonly bucket: UploadBucket | undefined;
	readonly lookup: (productId: string, user: UploadUser) => Promise<ProductLookup>;
	/** Milliseconds since the epoch — the key's ULID timestamp. */
	readonly now: () => number;
	/** `n` cryptographically random bytes. */
	readonly random: (n: number) => Uint8Array;
}

export interface UploadRequest {
	/** The route's `productId` parameter. */
	readonly productId: string;
	readonly headers: Headers;
	readonly body: ReadableStream<Uint8Array> | null;
}

/** Handle one upload end to end. Never throws: every outcome is a response. */
export async function handleDownloadUpload(
	deps: UploadDeps,
	request: UploadRequest,
): Promise<Response> {
	if (request.headers.get("X-EmDash-Request") !== "1") {
		return refuse(403, "CSRF_REJECTED", "Missing required header.");
	}
	if (deps.tokenAuthenticated) {
		return refuse(
			403,
			"TOKEN_NOT_ACCEPTED",
			"Download files are uploaded from the admin, signed in — not with an API token.",
		);
	}
	const { user } = deps;
	if (user === undefined) {
		return refuse(
			401,
			"NOT_SIGNED_IN",
			"You are not signed in to the admin. Reload the page to sign in again, then upload the file.",
		);
	}
	if (!(user.role >= UPLOAD_MIN_ROLE)) {
		return refuse(
			403,
			"FORBIDDEN",
			"Your account can't attach download files. Ask an administrator to grant the plugins:manage permission.",
		);
	}
	if (!PRODUCT_ID.test(request.productId)) {
		return refuse(404, "PRODUCT_NOT_FOUND", "No product matches that id.");
	}
	const { bucket } = deps;
	if (bucket === undefined) {
		return refuse(
			503,
			"DOWNLOADS_NOT_CONFIGURED",
			`Downloads are not set up on this store: it has no private ${DOWNLOADS_BINDING} bucket. Your developer can add one (DEPLOYMENT.md §2.1).`,
		);
	}

	// The size first, from the declared length: a refusal here costs no storage
	// read and no byte of the body.
	const declared = request.headers.get("Content-Length");
	if (declared === null || !BYTE_COUNT.test(declared)) {
		return refuse(
			411,
			"LENGTH_REQUIRED",
			"The upload did not say how large the file is. Try again.",
		);
	}
	const size = Number(declared);
	if (size > MAX_DOWNLOAD_UPLOAD_BYTES) {
		return refuse(
			413,
			"TOO_LARGE",
			`This file is too large. Download files can be at most ${String(MEGABYTES)} MB.`,
		);
	}
	if (size === 0 || request.body === null) {
		return refuse(400, "EMPTY_FILE", "This file is empty. Choose the file buyers should get.");
	}

	const product = await deps.lookup(request.productId, user);
	switch (product.kind) {
		case "busy":
			return refuse(
				503,
				"BUSY",
				"The store is busy. Wait a few seconds and upload the file again.",
				{ "Retry-After": String(BUSY_RETRY_AFTER_SECONDS) },
			);
		case "failed":
			return refuse(
				503,
				"UNAVAILABLE",
				"The store could not check this product just now. Upload the file again in a moment.",
			);
		case "refused":
			return refuse(404, "PRODUCT_NOT_FOUND", product.message);
		case "found":
			break;
	}
	if (product.deletedAt !== null) {
		return refuse(409, "PRODUCT_DELETED", "This product is in the trash, so it can't get a file.");
	}
	if (product.productKind !== "digital") {
		return refuse(
			409,
			"NOT_DIGITAL",
			"Only a Digital product can have a download file. Set the product type to Digital and save, then upload the file.",
		);
	}
	if (!PRODUCT_ID.test(product.productId))
		return refuse(503, "UNAVAILABLE", "Unexpected product id.");

	const key = mintDownloadAssetKey(
		product.productId as Parameters<typeof mintDownloadAssetKey>[0],
		deps.now(),
		deps.random(DOWNLOAD_KEY_RANDOM_BYTES),
	);
	const contentType = downloadContentTypeFor(request.headers.get("Content-Type"));
	const filename = sanitizeDownloadFilename(declaredFilename(request.headers));

	let stored: { size: number } | null;
	try {
		stored = await bucket.put(key, request.body, {
			httpMetadata: { contentType },
			// For whoever lists the bucket to find orphans (DEPLOYMENT.md): which
			// product, what it was called, who uploaded it. Encoded, so a name is
			// one safe ASCII string wherever R2 surfaces it as a header.
			customMetadata: {
				productId: product.productId,
				filename: encodeURIComponent(filename),
				uploadedBy: user.id,
			},
		});
	} catch (error) {
		console.error(`[site-staging] download upload: storing ${key} failed`, error);
		await bucket.delete(key).catch(() => undefined);
		return refuse(
			503,
			"STORAGE_FAILED",
			"The file could not be stored just now. Upload it again in a moment.",
		);
	}
	if (stored === null || stored.size !== size) {
		// Fewer bytes than declared: the connection dropped mid-upload. The partial
		// object is removed — nothing points at it yet, so nobody can be reading it.
		await bucket.delete(key).catch(() => undefined);
		return refuse(400, "INCOMPLETE", "The upload did not finish. Upload the file again.");
	}
	const asset: UploadedAsset = { key, filename, contentType, size };
	return json(201, { ok: true, asset });
}
