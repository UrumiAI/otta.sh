/**
 * The setup token the e2e suite presents (ADR-0042). Split from the store's
 * `scripts/setup-claim-cookie.ts` because it reads THIS site's `.dev.vars`, the
 * file the e2e dev Worker reads.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "../../store/src/lib/dot-env.js";
import {
	PUBLIC_E2E_SETUP_TOKEN,
	SETUP_TOKEN_SECRET,
} from "../../store/src/lib/setup-claim-contract.js";

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
