/**
 * The setup token and claim cookie for the e2e suite and the scripts
 * (ADR-0042). Plain Node: no Playwright, so the unit tier can test it.
 *
 * While a store is unclaimed, every `/_emdash/*` route but a few refuses a
 * request without the setup token, including the dev-bypass sign-in the
 * scripts and the e2e suite fall back on. A browser gets the cookie from the
 * claim link; a script has no browser, so it sends the same cookie itself,
 * built from `OTTA_SETUP_TOKEN` in ITS environment. The e2e config sets that
 * variable for itself and for the dev server it boots, so both agree. Unset,
 * nothing is sent, and a claimed store never looks at it.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "../src/lib/dot-env.js";
import {
	PUBLIC_E2E_SETUP_TOKEN,
	SETUP_CLAIM_COOKIE,
	SETUP_TOKEN_SECRET,
} from "../src/lib/setup-claim-contract.js";

/** `sites/staging/.dev.vars`: when it exists, wrangler gives the dev Worker its
 *  values INSTEAD of the injected process env (DEPLOYMENT.md §3). */
export const DEV_VARS_PATH = fileURLToPath(new URL("../.dev.vars", import.meta.url));

/**
 * The setup token the e2e suite presents: the one the dev server holds.
 *  1. `OTTA_SETUP_TOKEN` from `sites/staging/.dev.vars`, when that file exists:
 *     it is what the dev Worker reads, whatever this process's env says;
 *  2. otherwise `OTTA_SETUP_TOKEN` from this process's env;
 *  3. otherwise the public throwaway {@link PUBLIC_E2E_SETUP_TOKEN}, which
 *     `playwright.config.ts` hands to the dev server it boots. The gate refuses
 *     it on any host but loopback.
 * A `.dev.vars` WITHOUT the variable leaves a fresh dev Worker to generate its
 * own token, which the suite cannot know: claim that store first, or add it.
 */
export function e2eSetupToken(
	env: Record<string, string | undefined> = process.env,
	devVarsPath: string = DEV_VARS_PATH,
): string {
	if (existsSync(devVarsPath)) {
		const fromFile = parseDotEnv(readFileSync(devVarsPath, "utf8"))[SETUP_TOKEN_SECRET];
		if (fromFile !== undefined && fromFile !== "") return fromFile;
	}
	const fromEnv = env[SETUP_TOKEN_SECRET];
	return fromEnv !== undefined && fromEnv !== "" ? fromEnv : PUBLIC_E2E_SETUP_TOKEN;
}

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
