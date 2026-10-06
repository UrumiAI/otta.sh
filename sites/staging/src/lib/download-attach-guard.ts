/**
 * Attaching a download file names an object that is IN the bucket (issue #405,
 * item 5).
 *
 * The upload is two requests (ADR-0029): the site's upload endpoint stores the
 * bytes and answers a descriptor `{key, filename, contentType, size}`, then the
 * console saves that descriptor through the plugin's admin route
 * (`products:attach-download`). The plugin validates the descriptor's SHAPE —
 * a `dl/{productId}/{ULID}` key, a sane name and type — but it cannot reach R2
 * (its only egress is `ctx.http`), so it cannot tell a key the endpoint minted
 * and stored from one with nothing behind it. Saved, such a key turns every
 * buyer's download of that product into a 404 until someone uploads again.
 *
 * ── Why here, and not in the plugin or the endpoint ──────────────────────────
 * Only the site holds the `DOWNLOADS` binding, so only the site can `head()` the
 * key. The upload endpoint already knows its own put landed; what was missing is
 * a check at the SAVE, on whatever descriptor the save carries — a console bug,
 * a stale or hand-made request. So the site's middleware looks at the one write
 * that names a key, before EmDash dispatches it to the plugin, and `head()`s it:
 *  - no object, or an object of another size than the descriptor claims → the
 *    write is answered here as the plugin would refuse it (a `notice` the
 *    Download file card shows as written) and never reaches the plugin;
 *  - no `DOWNLOADS` binding → refused the same way: downloads are off, and a
 *    file attached now could not be served;
 *  - the bucket throws → a retryable failure (`retryable: true`, the flag every
 *    Otta busy shape carries): the file may be fine, so the card offers a save
 *    again rather than a re-upload.
 * Everything else passes through untouched. The alternative designs — the site
 * SIGNING the descriptor for the plugin to verify, or the upload endpoint making
 * the save itself — each need a secret shared between site and plugin, or a
 * second write path into the plugin, for what is one existence check.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * Only a POST to a plugin route (`/_emdash/api/plugins/…`, matched decoded and
 * with repeated slashes collapsed, as Astro routes it) by a signed-in user who
 * holds `plugins:manage` — the role the plugin's admin route itself requires.
 * Anyone else is left to EmDash's own refusal, so the bucket is never read for a
 * request that could not have saved anything. The body is read from a CLONE, so
 * EmDash still reads the original. The plugin's console act is matched exactly as
 * the plugin reads it: `type` and `action_id` compared as strings, the payload's
 * fields only when they are strings. A body that does not parse, or a payload
 * without a string key and size, passes through: the plugin refuses it as
 * unreadable on its own.
 */
import { CONSOLE_ACT_INTERACTION } from "@otta-sh/plugin";
import type { DownloadsBucket } from "./download-delivery.js";
import { DOWNLOADS_BINDING } from "./downloads-bucket.js";
import { PRIVATE_NO_STORE } from "./no-store.js";

/** The plugin's attach action id (`products-actions.ts`). */
export const ATTACH_DOWNLOAD_ACTION = "products:attach-download";

/** EmDash's plugin API prefix — every plugin route, the `otta` admin route among them. */
const PLUGIN_ROUTE_PREFIX = "/_emdash/api/plugins/";

/** The `DOWNLOADS` binding's one method this check uses. */
export type AttachBucket = Pick<DownloadsBucket, "head">;

/** What the check reads off an attach: the key and the claimed byte count, as
 *  the console sent them. */
export interface AttachClaim {
	readonly key: string;
	readonly size: string;
}

/** The `DOWNLOADS` binding from the Worker's env, or `undefined` when this
 *  deployment has none (downloads are then off). */
export function attachBucketFrom(
	env: Record<string, unknown> | undefined,
): AttachBucket | undefined {
	const candidate = env?.[DOWNLOADS_BINDING];
	if (typeof candidate !== "object" || candidate === null) return undefined;
	return typeof (candidate as Record<string, unknown>)["head"] === "function"
		? (candidate as AttachBucket)
		: undefined;
}

/** Whether the path is under EmDash's plugin API, as Astro would route it. */
export function isPluginRoutePath(url: URL): boolean {
	let path = url.pathname;
	try {
		path = decodeURI(path);
	} catch {
		// An undecodable path is checked raw.
	}
	return path.replace(/\/{2,}/g, "/").startsWith(PLUGIN_ROUTE_PREFIX);
}

/** The attach's key and size, or `null` when the body is not the console's
 *  attach act (or carries no string key and size — the plugin refuses that). */
export function readAttachDownload(body: unknown): AttachClaim | null {
	if (typeof body !== "object" || body === null) return null;
	const { type, action_id: actionId, value } = body as Record<string, unknown>;
	if (type !== CONSOLE_ACT_INTERACTION || actionId !== ATTACH_DOWNLOAD_ACTION) return null;
	if (typeof value !== "object" || value === null) return null;
	const { key, size } = value as Record<string, unknown>;
	return typeof key === "string" && typeof size === "string" ? { key, size } : null;
}

/** An answer in EmDash's envelope, carrying what the plugin's route would. */
function answer(data: unknown): Response {
	return new Response(JSON.stringify({ success: true, data }), {
		status: 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": PRIVATE_NO_STORE,
			"X-Content-Type-Options": "nosniff",
		},
	});
}

/** The refusal, in the plugin's `applied` shape so the card shows it as it
 *  shows the plugin's own refusals of a descriptor. */
function refused(description: string): Response {
	return answer({
		ok: true,
		notice: { variant: "error", title: "This file wasn't attached", description },
	});
}

/**
 * `null` when the claimed object is in the bucket at the claimed size; else the
 * response to send in the plugin's place.
 */
export async function attachDownloadRefusal(
	bucket: AttachBucket | undefined,
	claim: AttachClaim,
): Promise<Response | null> {
	if (bucket === undefined) {
		return refused(
			`Downloads are not set up on this store: it has no private ${DOWNLOADS_BINDING} bucket, so buyers could not get this file. Your developer can add one (DEPLOYMENT.md §2.1).`,
		);
	}
	let stored: { size: number } | null;
	try {
		stored = await bucket.head(claim.key);
	} catch (error) {
		console.error(`[site-staging] attach download: checking ${claim.key} failed`, error);
		return answer({
			ok: false,
			title: "The file could not be checked",
			description:
				"The store could not confirm the uploaded file just now, so nothing was attached. Save it again in a moment.",
			retryable: true,
		});
	}
	if (stored === null || String(stored.size) !== claim.size) {
		return refused(
			"The uploaded file is not in the store's downloads storage, so buyers' links would fail. Nothing was attached. Upload the file again.",
		);
	}
	return null;
}

/** The middleware's whole step: `null` to pass the request on, or the answer
 *  to send instead. Only a role at or above `minRole` is checked. */
export async function guardAttachDownload(
	request: Request,
	url: URL,
	user: unknown,
	minRole: number,
	bucket: AttachBucket | undefined,
): Promise<Response | null> {
	if (request.method !== "POST" || !isPluginRoutePath(url)) return null;
	const role = (user as { role?: unknown } | null | undefined)?.role;
	if (typeof role !== "number" || !(role >= minRole)) return null;
	let body: unknown;
	try {
		body = JSON.parse(await request.clone().text()) as unknown;
	} catch {
		return null;
	}
	const claim = readAttachDownload(body);
	return claim === null ? null : attachDownloadRefusal(bucket, claim);
}
