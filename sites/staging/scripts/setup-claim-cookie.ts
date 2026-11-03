/**
 * The setup-claim cookie for a script's own `fetch` (ADR-0042).
 *
 * While a store is unclaimed, every `/_emdash/*` route but a few refuses a
 * request without the setup token, including the dev-bypass sign-in the
 * scripts and the e2e suite fall back on. A browser gets the cookie from the
 * claim link; a script has no browser, so it sends the same cookie itself,
 * built from `OTTA_SETUP_TOKEN` in ITS environment. The e2e config sets that
 * variable for itself and for the dev server it boots, so both agree. Unset,
 * nothing is sent, and a claimed store never looks at it.
 */
import { SETUP_CLAIM_COOKIE, SETUP_TOKEN_SECRET } from "../src/lib/setup-claim-contract.js";

/** `name=value` for a `Cookie` header, or undefined without a token. */
export function setupClaimCookie(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const token = env[SETUP_TOKEN_SECRET]?.trim();
	return token === undefined || token === "" ? undefined : `${SETUP_CLAIM_COOKIE}=${token}`;
}

/** Headers carrying the setup-claim cookie, if there is one. */
export function setupClaimHeaders(
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const cookie = setupClaimCookie(env);
	return cookie === undefined ? {} : { Cookie: cookie };
}
