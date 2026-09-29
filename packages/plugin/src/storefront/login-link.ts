/**
 * Where the emailed magic link points (issue #306).
 *
 * THE LINK IS THE OPERATOR'S CONFIGURED SIGN-IN PAGE, `settings:loginLinkUrl`,
 * and nothing else — an absolute http(s) URL (normally the storefront's
 * `/account/verify`) saved in Settings, with `challenge` and `token` appended.
 * Setting and validation adapted from #325 by @stephanedemotte.
 *
 * THERE IS NO REQUEST-ORIGIN FALLBACK, deliberately. The origin of the request
 * that asked for the link is `Host`-derived, and a host that does not pin
 * `Host` (a Node deployment behind a permissive proxy) would let anyone request
 * a victim's link with a forged `Host`: the victim's inbox would receive a
 * working token pointing at the attacker's domain, and one click would hand it
 * over. Caller input is refused for the same reason. So an unset or invalid
 * setting means NO LINK: the client issues nothing, sends nothing, answers the
 * same generic success, and logs once that login needs the URL configured.
 *
 * The page should redeem the token on a POST from its own form rather than on
 * the GET, so a mail scanner that pre-fetches links does not burn it.
 */
import type { PluginContext } from "../types.js";

/** The storefront page the emailed link lands on, by convention — the
 *  placeholder the Settings field suggests. */
export const ACCOUNT_VERIFY_PATH = "/account/verify";

/** The operator's sign-in link page. Readable kv, like the from-address: an
 *  operator must be able to see where links point. */
export const LOGIN_LINK_URL_KEY = "settings:loginLinkUrl";

/**
 * Is this a URL a sign-in link may point at? Absolute, http or https, and with
 * no credentials in it. Shared by the Settings save path and the send path, so a
 * value that could not be saved can never be used either. (From #325.)
 */
export function isValidLoginLinkUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return (
		(url.protocol === "https:" || url.protocol === "http:") &&
		url.username === "" &&
		url.password === ""
	);
}

/** The configured sign-in page, or `undefined` when it is unset, invalid, or kv
 *  cannot be read. Never throws, and never falls back to anything else. */
export async function resolveLoginLinkUrl(ctx: PluginContext): Promise<string | undefined> {
	let configured: unknown;
	try {
		configured = await ctx.kv.get<string>(LOGIN_LINK_URL_KEY);
	} catch {
		return undefined;
	}
	return typeof configured === "string" && isValidLoginLinkUrl(configured) ? configured : undefined;
}

/** The link for one challenge: the configured page, its own query kept, plus
 *  `challenge` and `token`. */
export function loginLinkUrl(verifyPageUrl: string, challengeId: string, token: string): string {
	const url = new URL(verifyPageUrl);
	url.searchParams.set("challenge", challengeId);
	url.searchParams.set("token", token);
	return url.toString();
}
