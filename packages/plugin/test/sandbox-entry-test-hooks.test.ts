/**
 * The sandbox entry's test-only kv window must not ship in the production
 * `./sandbox-entry` export. The cron suite deletes the sweep's cadence stamp
 * through it; the production entry (`createSandboxWorker(plugin)`, no options)
 * must answer that request as an unknown route.
 */
import { describe, expect, test } from "vitest";
import plugin from "../src/plugin.js";
import { createSandboxWorker } from "../src/sandbox-entry.js";

const STAMP = encodeURIComponent("cron:sweep:cursor:state");

describe("the sandbox entry's test hooks", () => {
	test("the production entry has no kv delete window", async () => {
		const worker = createSandboxWorker(plugin);
		const res = await worker.fetch(new Request(`http://sandbox/kv/${STAMP}`, { method: "DELETE" }));
		expect(res.status).toBe(404);
	});

	test("a fixture entry that opts in gets it, for cron:sweep: keys only", async () => {
		const worker = createSandboxWorker(plugin, { testHooks: true });
		const ok = await worker.fetch(new Request(`http://sandbox/kv/${STAMP}`, { method: "DELETE" }));
		expect(ok.status).toBe(200);
		const other = await worker.fetch(
			new Request(`http://sandbox/kv/${encodeURIComponent("settings:storeTheme")}`, {
				method: "DELETE",
			}),
		);
		expect(other.status).toBe(403);
	});
});
