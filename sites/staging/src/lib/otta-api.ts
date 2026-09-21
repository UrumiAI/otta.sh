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
import { OTTA_PLUGIN_ID } from "@otta-sh/plugin";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";

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
 *  redirect through the returnTo field). */
export function safeReturnPath(value: FormDataEntryValue | null, fallback: string): string {
	const raw = formString(value);
	if (raw === undefined) return fallback;
	return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}
