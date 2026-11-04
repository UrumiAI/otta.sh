/**
 * The claim e2e stack (ADR-0042): its own dev server, on its own port, over a
 * FRESH, unseeded state directory, so the setup-claim link is exercised on a
 * store that is still unclaimed. Shared by `playwright.claim.config.ts` and
 * the spec. Loopback only, like the main harness.
 */
import { fileURLToPath } from "node:url";

/** Not the main stack's 4500: the two never share a server. */
export const CLAIM_PORT = 4510;

/** The site, as the deployer's link names it. */
export const CLAIM_SITE = `http://localhost:${String(CLAIM_PORT)}`;

/** The same server under ANOTHER site's name: `127.0.0.1` and `localhost` are
 *  different sites to a browser, so a page there starts a cross-site click. */
export const CLAIM_PROBE_HOST = "127.0.0.1";

/** The disposable miniflare state the stack runs on, wiped before each boot.
 *  Under node_modules so a run never dirties the tree. */
export const CLAIM_STATE_DIR = fileURLToPath(
	new URL("../../../../node_modules/.e2e-claim-state", import.meta.url),
);
