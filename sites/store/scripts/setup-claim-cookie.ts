/**
 * The setup token and claim cookie for the e2e suite and the scripts
 * (ADR-0042). Plain Node: no Playwright, so the unit tier can test it.
 *
 * While a store is unclaimed, every `/_emdash/*` route but a few refuses a
 * request without the setup token, including the dev-bypass sign-in the
 * scripts and the e2e suite fall back on. A browser gets the cookie from the
 * claim link; a script has no browser, so it sends the same cookie itself,
 * built from the token the dev store holds ({@link devSetupToken}): the one in
 * the dev store's `.dev.vars` first, then `OTTA_SETUP_TOKEN` in the script's
 * environment. The e2e suite's own token lookup
 * (`sites/staging/e2e/setup-token.ts`) is the same one, with a public fallback.
 * Neither set, nothing is sent, and a claimed store never looks at it.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "../src/lib/dot-env.js";
import { SETUP_CLAIM_COOKIE, SETUP_TOKEN_SECRET } from "../src/lib/setup-claim-contract.js";

/** `sites/staging/.dev.vars`, the dev store's: when it exists, wrangler gives
 *  the dev Worker its values INSTEAD of the process env (DEPLOYMENT.md §3).
 *  Outside this repository the file is not there and only the env counts. */
export const DEV_VARS_PATH = fileURLToPath(new URL("../../staging/.dev.vars", import.meta.url));

/**
 * The setup token the dev store holds, as far as a script can tell:
 *  1. `OTTA_SETUP_TOKEN` from the dev store's `.dev.vars`, when that file
 *     exists: it is what the dev Worker reads, whatever this process's env says;
 *  2. otherwise `OTTA_SETUP_TOKEN` from this process's env;
 *  3. otherwise undefined.
 */
export function devSetupToken(
	env: Record<string, string | undefined> = process.env,
	devVarsPath: string = DEV_VARS_PATH,
): string | undefined {
	if (existsSync(devVarsPath)) {
		const fromFile = parseDotEnv(readFileSync(devVarsPath, "utf8"))[SETUP_TOKEN_SECRET]?.trim();
		if (fromFile !== undefined && fromFile !== "") return fromFile;
	}
	const fromEnv = env[SETUP_TOKEN_SECRET]?.trim();
	return fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
}

/** `name=value` for a `Cookie` header, or undefined without a token. */
export function setupClaimCookie(
	env: Record<string, string | undefined> = process.env,
	devVarsPath: string = DEV_VARS_PATH,
): string | undefined {
	const token = devSetupToken(env, devVarsPath);
	return token === undefined ? undefined : `${SETUP_CLAIM_COOKIE}=${token}`;
}

/** Headers carrying the setup-claim cookie, if there is one. */
export function setupClaimHeaders(
	env: Record<string, string | undefined> = process.env,
	devVarsPath: string = DEV_VARS_PATH,
): Record<string, string> {
	const cookie = setupClaimCookie(env, devVarsPath);
	return cookie === undefined ? {} : { Cookie: cookie };
}
