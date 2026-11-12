/**
 * The setup token and claim cookie for the e2e suite and the scripts
 * (ADR-0042). Plain Node: no Playwright, so the unit tier can test it.
 *
 * While a store is unclaimed, every `/_emdash/*` route but a few refuses a
 * request without the setup token, including the dev-bypass sign-in the
 * scripts and the e2e suite fall back on. A browser gets the cookie from the
 * claim link; a script has no browser, so it sends the same cookie itself.
 * For a LOOPBACK site (`localhost`, `127.0.0.1`, `[::1]`) it is built from the token the dev store holds
 * ({@link devSetupToken}): the one in the dev store's `.dev.vars` first, then
 * `OTTA_SETUP_TOKEN` in the script's environment. The e2e suite's own token
 * lookup (`sites/staging/e2e/setup-token.ts`) is the same one, with a public
 * fallback. For any other site only an explicit `OTTA_SETUP_TOKEN` in the env
 * is sent: a local file's token never leaves the machine. No token, nothing is
 * sent, and a claimed store never looks at it.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "../src/lib/dot-env.js";
import { SETUP_CLAIM_COOKIE, SETUP_TOKEN_SECRET } from "../src/lib/setup-claim-contract.js";

/** `sites/staging/.dev.vars`, the dev store's: when it exists, wrangler gives
 *  the dev Worker its values INSTEAD of the process env (DEPLOYMENT.md §3).
 *  Resolved from this file's location, so it only means something in this
 *  repository's layout. In the published `@urumi.ai/otta-store` package it
 *  points at `node_modules/@urumi.ai/staging/.dev.vars`, which does not exist,
 *  and the env alone counts. */
export const DEV_VARS_PATH = fileURLToPath(new URL("../../staging/.dev.vars", import.meta.url));

/**
 * The setup token the dev store holds, as far as a script can tell:
 *  1. `OTTA_SETUP_TOKEN` from the dev store's `.dev.vars`, when that file
 *     exists: it is what the dev Worker reads, whatever this process's env says;
 *  2. otherwise `OTTA_SETUP_TOKEN` from this process's env;
 *  3. otherwise undefined.
 * Trimmed, as the gate trims the secret.
 *
 * A `.dev.vars` that exists WITHOUT the variable still falls back to the env,
 * but the dev Worker does not: it ignores the env and mints its own token, so
 * the env's token may not be the one it holds. Claim that store first (its
 * `[otta-setup]` link), or put the token in `.dev.vars`.
 */
export function devSetupToken(
	env: Record<string, string | undefined> = process.env,
	devVarsPath: string = DEV_VARS_PATH,
): string | undefined {
	if (existsSync(devVarsPath)) {
		const fromFile = parseDotEnv(readFileSync(devVarsPath, "utf8"))[SETUP_TOKEN_SECRET]?.trim();
		if (fromFile !== undefined && fromFile !== "") return fromFile;
	}
	return envSetupToken(env);
}

function envSetupToken(env: Record<string, string | undefined>): string | undefined {
	const fromEnv = env[SETUP_TOKEN_SECRET]?.trim();
	return fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
}

/** The hosts a script sends the local `.dev.vars` token to. Narrower than the
 *  gate's loopback test: `*.localhost` is left out, because Node may resolve it
 *  through DNS on some hosts and the token would leave the machine. */
const SCRIPT_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackSite(siteUrl: string): boolean {
	try {
		return SCRIPT_LOOPBACK_HOSTS.has(new URL(siteUrl).hostname);
	} catch {
		return false;
	}
}

/** Where a script's token comes from; both default to the real ones. */
export interface SetupClaimSource {
	env?: Record<string, string | undefined>;
	devVarsPath?: string;
}

/** `name=value` for a `Cookie` header to `siteUrl`, or undefined without a
 *  token. Only `localhost`, `127.0.0.1` and `[::1]` get the local `.dev.vars`
 *  token. */
export function setupClaimCookie(
	siteUrl: string,
	{ env = process.env, devVarsPath = DEV_VARS_PATH }: SetupClaimSource = {},
): string | undefined {
	const token = isLoopbackSite(siteUrl) ? devSetupToken(env, devVarsPath) : envSetupToken(env);
	return token === undefined ? undefined : `${SETUP_CLAIM_COOKIE}=${token}`;
}

/** Headers carrying the setup-claim cookie for `siteUrl`, if there is one. */
export function setupClaimHeaders(
	siteUrl: string,
	source: SetupClaimSource = {},
): Record<string, string> {
	const cookie = setupClaimCookie(siteUrl, source);
	return cookie === undefined ? {} : { Cookie: cookie };
}
