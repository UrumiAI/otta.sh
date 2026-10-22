/**
 * Issue #531 — did THIS e2e run start the dev server, or adopt one already up?
 *
 * Locally `reuseExistingServer` is on (`playwright.config.ts`), so
 * `OTTA_E2E_START_STACK=1` against a developer's own running `astro dev` adopts
 * it. The global setup must then not save the placeholder publishable key and
 * the offline `whsec_e2e_offline` into that store: a real `sk_test_…` saved later
 * would read "Card payments: ready." while every forwarded webhook fails its
 * signature check.
 *
 * Playwright runs the webServer COMMAND only when nothing already answers at the
 * URL, and runs its plugins (the webServer) before the global setup, in the
 * same process. So the command touches a marker file first; the setup consumes
 * it. The path rides in the environment, chosen once where the config loads, so
 * the config, the command's shell and the setup all name the same file.
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARKER_ENV = "OTTA_E2E_SERVER_STARTED_MARKER";

/** The marker's path for this run: from the environment, or chosen now and put
 *  there (so worker processes and the webServer's shell inherit it). */
export function serverStartedMarkerPath(
	env: Record<string, string | undefined> = process.env,
): string {
	const existing = env[MARKER_ENV];
	if (existing !== undefined && existing !== "") return existing;
	const path = join(tmpdir(), `otta-e2e-server-started-${process.pid}-${Date.now()}`);
	env[MARKER_ENV] = path;
	return path;
}

/** The shell prefix the webServer command runs first: creates the marker. */
export function markServerStartedCommand(): string {
	return `node -e "require('node:fs').writeFileSync(process.env.${MARKER_ENV}, '')"`;
}

/** Whether the marker is there (the command ran), removing it either way. */
export function consumeServerStartedMarker(path: string): boolean {
	const started = existsSync(path);
	rmSync(path, { force: true });
	return started;
}

/** Save the placeholder Stripe values only on a stack this run started, or when
 *  the run was asked to seed (`OTTA_E2E_SEED=1`, which CI sets). */
export function provisionsE2ePlaceholders(run: {
	seeds: boolean;
	serverStartedByThisRun: boolean;
}): boolean {
	return run.seeds || run.serverStartedByThisRun;
}
