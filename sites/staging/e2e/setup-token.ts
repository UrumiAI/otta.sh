/**
 * The setup token the e2e suite presents (ADR-0042). The lookup itself is the
 * store's `scripts/setup-claim-cookie.ts` ({@link devSetupToken}), so the suite
 * and the scripts' claim cookie always agree; this adds the public fallback.
 */
import { DEV_VARS_PATH, devSetupToken } from "../../store/scripts/setup-claim-cookie.js";
import { PUBLIC_E2E_SETUP_TOKEN } from "../../store/src/lib/setup-claim-contract.js";

/** `sites/staging/.dev.vars`: when it exists, wrangler gives the dev Worker its
 *  values INSTEAD of the injected process env (DEPLOYMENT.md §3). */
export { DEV_VARS_PATH };

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
	return devSetupToken(env, devVarsPath) ?? PUBLIC_E2E_SETUP_TOKEN;
}
