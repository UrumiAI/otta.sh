/**
 * Where the emailed magic link points (issue #306).
 *
 * THE LINK IS A STOREFRONT PAGE, `/account/verify?challenge=…&token=…`, on the
 * site that asked for it. The page is the theme's, not the plugin's: the plugin
 * cannot set a cookie (see `account-routes.ts`), so redeeming the token has to
 * happen on a first-party page that can — and that page should redeem on a
 * POST from its own form rather than on the GET, so a mail scanner that
 * pre-fetches links does not burn the single-use token.
 *
 * THE BASE IS NEVER CALLER INPUT. A base taken from the route's input would let
 * anyone request a link for a victim's address that points at THEIR host, and
 * the victim's click would hand them the token. So the base is, in order:
 *
 *  1. `settings:storefrontBaseUrl` in kv — an operator-set value, for a
 *     deployment whose request origin is not the public one (a Node host behind
 *     a proxy that does not pin `Host`, a site mounted under a path);
 *  2. otherwise the ORIGIN of the request the route was invoked with. EmDash
 *     hands a sandboxed route `request.url` verbatim; the theme's in-process
 *     dispatch builds that request on its own `Astro.url`, and on Workers the
 *     host is fixed by routing, so this is the site the shopper is on.
 *
 * Neither usable ⇒ `undefined`, and the client issues nothing (it logs once).
 */
import type { PluginContext, SandboxedRequest } from "../types.js";

/** The storefront page the emailed link lands on. */
export const ACCOUNT_VERIFY_PATH = "/account/verify";

/** The optional operator override for the link's base URL. Readable kv — it is
 *  not a secret. */
export const STOREFRONT_BASE_URL_KEY = "settings:storefrontBaseUrl";

/** An absolute http(s) URL → its origin plus any path prefix, no trailing
 *  slash. Anything else → `undefined`. */
function normalizeBase(value: unknown, keepPath: boolean): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	const path = keepPath ? url.pathname.replace(/\/+$/, "") : "";
	return `${url.origin}${path}`;
}

/** The base the link is built on — see the module doc for the order. Never
 *  throws: a kv outage falls through to the request origin. */
export async function resolveLoginLinkBase(
	ctx: PluginContext,
	request: Pick<SandboxedRequest, "url"> | undefined,
): Promise<string | undefined> {
	let configured: unknown;
	try {
		configured = await ctx.kv.get<string>(STOREFRONT_BASE_URL_KEY);
	} catch {
		configured = undefined;
	}
	return normalizeBase(configured, true) ?? normalizeBase(request?.url, false);
}

/** The full link for one challenge. `baseUrl` is what {@link resolveLoginLinkBase}
 *  returned. */
export function loginLinkUrl(baseUrl: string, challengeId: string, token: string): string {
	const url = new URL(`${baseUrl.replace(/\/+$/, "")}${ACCOUNT_VERIFY_PATH}`);
	url.searchParams.set("challenge", challengeId);
	url.searchParams.set("token", token);
	return url.toString();
}
