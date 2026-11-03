/**
 * The names the setup-claim gate (`setup-claim.ts`, ADR-0042) shares with the
 * people and tools that hold the setup token: the deployer's link, the e2e
 * harness and the docs.
 *
 * Pure constants with no imports, so the Playwright harness (Node, no EmDash
 * runtime) can import them without loading the gate itself.
 */

/** The Worker secret that, when set, IS the setup token (ADR-0042 §2). */
export const SETUP_TOKEN_SECRET = "OTTA_SETUP_TOKEN";

/** The query parameter the claim link carries the token in. */
export const SETUP_TOKEN_PARAM = "setup_token";

/** The page the claim link opens: EmDash's setup wizard. It is the one admin
 *  path EmDash's own setup middleware never redirects away from, so the link's
 *  query string reaches the site middleware intact. */
export const SETUP_CLAIM_PATH = "/_emdash/admin/setup";

/** The cookie that carries the token from the link to the wizard's API calls. */
export const SETUP_CLAIM_COOKIE = "otta_setup_claim";

/** The cookie's path: every EmDash route, and nothing on the storefront. */
export const SETUP_CLAIM_COOKIE_PATH = "/_emdash/";

/** The cookie's lifetime: EmDash's own setup nonce lasts as long. The link
 *  itself stays valid until the store is claimed, so it can be opened again. */
export const SETUP_CLAIM_MAX_AGE_SECONDS = 3600;

/** The marker the claim link's log line starts with, so the deployer can
 *  search Workers Logs for it. */
export const SETUP_CLAIM_LOG_TAG = "[otta-setup]";

/** The claim link for a token, on a site origin. */
export function setupClaimUrl(origin: string, token: string): string {
	const url = new URL(SETUP_CLAIM_PATH, origin);
	url.searchParams.set(SETUP_TOKEN_PARAM, token);
	return url.toString();
}
