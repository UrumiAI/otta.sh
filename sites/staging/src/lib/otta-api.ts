/**
 * In-process dispatch to the Otta plugin's PUBLIC routes — the em-dash
 * forms-plugin pattern (ADR-0003): the theme page/endpoint invokes the
 * plugin route through `locals.emdash.handlePublicPluginApiRoute`; no HTTP
 * hop, but the same auth gate (public routes only) and the same JSON
 * envelope (`{ success, data | error }`) as the wire mount at
 * `/_emdash/api/plugins/otta/<route>`.
 *
 * Returns `null` on ANY dispatch/envelope failure — pages must render a
 * friendly degraded state (a stopped commerce service is an expected
 * staging condition, never a crash).
 */
import {
	OTTA_PLUGIN_ID,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	STOREFRONT_CART_READ_ROUTE,
	STOREFRONT_CHECKOUT_SUMMARY_ROUTE,
	STOREFRONT_LIST_ROUTE,
	STOREFRONT_ORDER_ROUTE,
	STOREFRONT_ORDER_ABANDON_ROUTE,
	STOREFRONT_ORDER_RESUME_ROUTE,
	STOREFRONT_PRODUCT_ROUTE,
	type RenderBusy,
} from "@otta-sh/plugin";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { cartErrorMessage } from "./error-messages.js";

/** The plugin's "the store is busy, try again" token (`renderGuard`'s `BUSY`):
 *  storage contention — the refused step wrote nothing. */
export const BUSY = "BUSY";

/**
 * The `Retry-After` a busy answer carries. SHORT on purpose: contention is a
 * burst on one hot document (a flash-sale SKU), measured in milliseconds of
 * compare-and-set backoff, not an outage — the 60s the PDP sends for a CMS
 * outage would park a shopper (or a crawler) far longer than the burst lasts.
 */
export const BUSY_RETRY_AFTER_SECONDS = 3;

/** Structural: is this route result the plugin's retryable BUSY answer? */
export function isBusyResult(result: unknown): result is RenderBusy {
	return (
		typeof result === "object" &&
		result !== null &&
		(result as { ok?: unknown }).ok === false &&
		(result as { error?: unknown }).error === BUSY
	);
}

/** Mark an SSR page's response (Astro's `Astro.response`) as a busy 503. */
export function markBusy(response: { status?: number; headers: Headers }): void {
	response.status = 503;
	response.headers.set("Retry-After", String(BUSY_RETRY_AFTER_SECONDS));
}

/** An origin no request ever has — only used to resolve a relative path. */
const RESOLVE_BASE = "https://same-site.invalid";

/**
 * `path` NORMALIZED the way a browser would resolve it, kept only if the result
 * is still a plain same-site path; otherwise `fallback`. Returns pathname +
 * search — never a scheme or host — and never the raw input.
 *
 * The check runs TWICE, before and after resolving, because resolving is what
 * creates the hazard: `/.//evil.com`, `/..//evil.com`, `/a/../..//evil.com` and
 * their percent-encoded forms (`/%2e%2e//evil.com` — WHATWG decodes `%2e` as a
 * dot segment) all pass a string check, yet resolve to the pathname
 * `//evil.com`, which a browser reads as a protocol-relative, OFF-site URL. So
 * the resolved value is re-validated, and only that value is ever emitted.
 */
export function sameSitePath(path: string, fallback = "/"): string {
	if (!isPlainSameSitePath(path)) return fallback;
	let resolved: URL;
	try {
		resolved = new URL(path, RESOLVE_BASE);
	} catch {
		return fallback;
	}
	if (resolved.origin !== RESOLVE_BASE) return fallback;
	const normalized = resolved.pathname + resolved.search;
	return isPlainSameSitePath(normalized) ? normalized : fallback;
}

/** `/x`, never `//x`, and no backslash or control character anywhere — WHATWG
 *  URL parsing treats `\` as `/` for http(s), so `/\evil.com` is off-site.
 *  A STRING check only: see {@link sameSitePath} for why it is not enough alone. */
function isPlainSameSitePath(path: string): boolean {
	// oxlint-disable-next-line no-control-regex -- rejecting control characters IS the point
	return path.startsWith("/") && !path.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(path);
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/**
 * The answer a FORM POST gives when the plugin is still busy after the one retry
 * {@link dispatchOttaRoute} already spent: 503 + `Retry-After`, the friendly
 * busy copy, and a link back.
 *
 * A 503 rather than the usual 303-with-`?error=`: the request was not completed,
 * and that is what 503 says — to the browser, to any proxy and to monitoring.
 * The copy invites a retry, exactly as the generic "please try again" it
 * replaces did; what a manual retry (a reload re-POSTs the same form, key
 * included) is worth depends on the ROUTE's replay guarantee, and this helper
 * makes no claim about it — see `isRetrySafe` for the calls that ARE retried.
 *
 * `backTo` is normalized to a same-site path here whatever the caller passed
 * ({@link sameSitePath}): a browser resolves `/\evil.com` and `/.//evil.com`
 * like `//evil.com`, so a string check alone is not a same-site guarantee.
 */
export function busyResponse(backTo: string): Response {
	const message = escapeHtml(cartErrorMessage(BUSY));
	const href = escapeHtml(sameSitePath(backTo));
	const body =
		'<!doctype html><html lang="en"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1">' +
		`<title>Busy — please try again</title></head><body><main><p>${message}</p>` +
		`<p><a href="${href}">Go back</a></p></main></body></html>`;
	return new Response(body, {
		status: 503,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Retry-After": String(BUSY_RETRY_AFTER_SECONDS),
			"Cache-Control": "no-store",
		},
	});
}

/**
 * Routes that only READ commerce state, so repeating one cannot change anything.
 * (`cart/read` and `checkout/summary` may converge an expired hold as a side
 * effect of the read, which is itself idempotent.)
 */
const READ_ROUTES: ReadonlySet<string> = new Set([
	STOREFRONT_PRODUCT_ROUTE,
	STOREFRONT_LIST_ROUTE,
	STOREFRONT_CART_READ_ROUTE,
	STOREFRONT_CHECKOUT_SUMMARY_ROUTE,
	STOREFRONT_ORDER_ROUTE,
]);

/**
 * The keyed cart-line mutations: each carries the form's `idempotencyKey`, the
 * domain enforces once-only on it (DEVELOPMENT.md §4), and the route is a single
 * line change — so a replay with the SAME key converges on the first attempt's
 * outcome instead of repeating its effect.
 */
const KEYED_REPLAY_ROUTES: ReadonlySet<string> = new Set([
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
]);

/**
 * Routes that replay a key of their OWN, so a repeat converges whatever the
 * caller sent. `storefront/order/resume` (QA U-2) replays the order's original
 * checkout on the order's own idempotency key: the same order, and at Stripe the
 * same PaymentIntent. One cost, stated: a retried EMAIL attempt may take a second
 * slot of that order's guess window — over-refusal, bounded by the window.
 */
const REPLAYING_ROUTES: ReadonlySet<string> = new Set([
	STOREFRONT_ORDER_RESUME_ROUTE,
	// QA2 X4: the cancel runs under a key derived from the order, and a cancelled
	// order answers "nothing to cancel" — a repeat converges.
	STOREFRONT_ORDER_ABANDON_ROUTE,
]);

/**
 * May a BUSY answer to this call be retried automatically? An ALLOWLIST: a
 * route is retried only when it is named here, and every other route —
 * including any added later — defaults to NO retry.
 *
 * BUSY promises only that the STEP that gave up wrote nothing — a multi-step
 * route may have committed earlier steps. So a blind replay is safe only when
 * repeating the whole call provably cannot double anything:
 *  - a read route ({@link READ_ROUTES}); or
 *  - a route that replays its own key ({@link REPLAYING_ROUTES}); or
 *  - a keyed cart-line mutation ({@link KEYED_REPLAY_ROUTES}) that actually
 *    carries its key — without one there is nothing to converge on.
 *
 * Deliberately NOT listed, though some carry a key:
 *  - `cart/create`: no key; a replay could mint a second cart.
 *  - `checkout/place`: its key is `checkout:<cartId>`. Since #337 a same-key
 *    replay FINISHES a partial first attempt (adoption, cart flip) instead of
 *    short-circuiting past it, so a buyer who reloads the 503 is safe — but it
 *    is the one route that mints a payment intent, so the SITE still adds no
 *    retry of its own and leaves that choice to the buyer.
 *  - the Stripe webhook: Stripe's redelivery IS the retry; its key is a fresh
 *    per-delivery id that gates nothing, and retrying here only doubles load.
 * The caller of an unlisted route sees BUSY and answers 503.
 */
function isRetrySafe(route: string, input: unknown): boolean {
	if (READ_ROUTES.has(route) || REPLAYING_ROUTES.has(route)) return true;
	if (!KEYED_REPLAY_ROUTES.has(route)) return false;
	if (typeof input !== "object" || input === null) return false;
	const key = (input as { idempotencyKey?: unknown }).idempotencyKey;
	return typeof key === "string" && key.length > 0;
}

/** A short jittered pause before the one retry: long enough for the contended
 *  writer ahead of us to commit, short enough to stay inside the request. */
function busyRetryPause(): Promise<void> {
	const ms = 50 + Math.random() * 100;
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function dispatchOttaRoute<TResult>(
	handler: PublicPluginApiRouteHandler | undefined,
	route: string,
	input: unknown,
	baseUrl: URL,
	/**
	 * Extra request headers. Storefront callers pass none — a public route
	 * reached in-process from an SSR page has nothing to attest. The Stripe
	 * webhook edge passes the `X-Otta-Wh-Token` shared secret, which the plugin
	 * reads off `routeCtx.request.headers` (EmDash's `sanitizeHeadersForSandbox`
	 * forwards everything except cookies/authorization, lower-cased; the plugin's
	 * own lookup is case-insensitive, so the casing here is for readability).
	 */
	headers: Record<string, string> = {},
): Promise<TResult | null> {
	const first = await dispatchOnce<TResult>(handler, route, input, baseUrl, headers);
	// ONE automatic retry of a BUSY answer, and only for an allowlisted call (see
	// `isRetrySafe`). This layer stacks on the store's own jittered
	// compare-and-set budget, and that is acceptable because it cannot multiply
	// it into a storm: it is a single retry (never a loop, so worst case is 2x the
	// store's bounded budget per request), it waits a jittered pause first so
	// concurrent losers do not re-collide in lockstep, and it applies only to
	// reads and keyed line mutations whose replay converges. A second BUSY means
	// real pressure — it goes back to the caller as a 503 rather than more load.
	if (!isBusyResult(first) || !isRetrySafe(route, input)) return first;
	console.warn(`[site-staging] otta route ${route} busy — retrying once`);
	await busyRetryPause();
	return dispatchOnce<TResult>(handler, route, input, baseUrl, headers);
}

/**
 * {@link dispatchOttaRoute} WITHOUT the automatic BUSY retry: one dispatch, and
 * a BUSY answer goes straight back to the caller. For a read whose caller fails
 * soft anyway (the chrome's bag, `lib/bag.ts`): a retry there would only add a
 * jittered pause and a second read to a page that answers without it.
 */
export function dispatchOttaRouteOnce<TResult>(
	handler: PublicPluginApiRouteHandler | undefined,
	route: string,
	input: unknown,
	baseUrl: URL,
): Promise<TResult | null> {
	return dispatchOnce<TResult>(handler, route, input, baseUrl, {});
}

async function dispatchOnce<TResult>(
	handler: PublicPluginApiRouteHandler | undefined,
	route: string,
	input: unknown,
	baseUrl: URL,
	headers: Record<string, string>,
): Promise<TResult | null> {
	if (handler === undefined) return null;
	const request = new Request(new URL(`/_emdash/api/plugins/${OTTA_PLUGIN_ID}/${route}`, baseUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(input),
	});
	try {
		const response = await handler(OTTA_PLUGIN_ID, "POST", `/${route}`, request);
		if (typeof response !== "object" || response === null) return null;
		const envelope = response as { success?: unknown; data?: unknown };
		if (envelope.success !== true) return null;
		return envelope.data as TResult;
	} catch (error) {
		console.error(`[site-staging] otta route ${route} dispatch failed:`, error);
		return null;
	}
}

/**
 * The request's form body, or `null` when it is not one.
 *
 * `request.formData()` THROWS on anything but a well-formed urlencoded or
 * multipart body — JSON, no Content-Type, a truncated multipart, no body at
 * all — and every form endpoint used to await it bare, so a curl, a bot or a
 * broken client became an unhandled exception and the host's 500 (QA U-6).
 * That is the caller's mistake, not ours: the endpoint answers
 * {@link notAFormResponse} instead. Call it AFTER `rejectCrossOrigin`, as the
 * endpoints read the body.
 */
export async function readFormBody(request: Request): Promise<FormData | null> {
	try {
		return await request.formData();
	} catch {
		return null;
	}
}

/** The 400 a form endpoint answers when {@link readFormBody} found no form. */
export function notAFormResponse(): Response {
	return new Response("Bad request: expected a form submission", {
		status: 400,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

/** FormData value → trimmed non-empty string, else undefined. */
export function formString(value: FormDataEntryValue | null): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** FormData value → positive integer, else undefined. */
export function formPositiveInt(value: FormDataEntryValue | null): number | undefined {
	const raw = formString(value);
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Only same-site absolute paths survive as redirect targets (no open
 *  redirect through the returnTo field). Returns the NORMALIZED path
 *  ({@link sameSitePath}), never the raw form value — `/.//evil.com` passes a
 *  string check but resolves off-site. */
export function safeReturnPath(value: FormDataEntryValue | null, fallback: string): string {
	const raw = formString(value);
	if (raw === undefined) return fallback;
	return sameSitePath(raw, fallback);
}
