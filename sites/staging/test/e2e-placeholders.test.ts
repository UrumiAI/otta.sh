/**
 * Issue #531: the e2e placeholder Stripe values (the publishable key and the
 * offline webhook secret) are saved only on a stack THIS run started, or under
 * `OTTA_E2E_SEED=1`. Locally `reuseExistingServer` is on, so
 * `OTTA_E2E_START_STACK=1` alone can mean "a developer's own running dev store",
 * and that store must not get `whsec_e2e_offline` written into it.
 *
 * "This run started it" is a marker file the webServer COMMAND writes: Playwright
 * runs the command only when nothing already answers at the URL.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	consumeServerStartedMarker,
	provisionsE2ePlaceholders,
	serverStartedMarkerPath,
} from "../e2e/server-started-marker.js";

describe("provisionsE2ePlaceholders", () => {
	test.each([
		[{ seeds: false, serverStartedByThisRun: false }, false],
		[{ seeds: false, serverStartedByThisRun: true }, true],
		[{ seeds: true, serverStartedByThisRun: false }, true],
		[{ seeds: true, serverStartedByThisRun: true }, true],
	] as const)("%o → %s", (run, expected) => {
		expect(provisionsE2ePlaceholders(run)).toBe(expected);
	});
});

describe("the server-started marker", () => {
	test("the path is chosen once and shared through the environment", () => {
		const env: Record<string, string | undefined> = {};
		const first = serverStartedMarkerPath(env);
		expect(env["OTTA_E2E_SERVER_STARTED_MARKER"]).toBe(first);
		expect(serverStartedMarkerPath(env)).toBe(first);
	});

	test("consuming it says whether the command ran, and removes it", () => {
		const path = join(mkdtempSync(join(tmpdir(), "otta-e2e-marker-")), "started");
		expect(consumeServerStartedMarker(path)).toBe(false);
		writeFileSync(path, "");
		expect(consumeServerStartedMarker(path)).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(consumeServerStartedMarker(path)).toBe(false);
	});
});
