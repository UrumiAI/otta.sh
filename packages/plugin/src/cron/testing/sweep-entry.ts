import plugin from "../../plugin.js";
import { createSandboxWorker } from "../../sandbox-entry.js";

/**
 * The workerd entry for the cron-sweep suite: the REAL plugin, served through the
 * exact production sandbox bridge (`createSandboxWorker` — same dispatch,
 * `ctx.http` allowedHosts gate and kv persistence), with the test-only windows
 * switched on. The suite needs one: deleting the sweep's cadence stamp, so it can
 * drive a fifteen-minute scan leg through the real hook more than once.
 *
 * Booted by `test/sandbox/harness.ts` via its `entry` option; never part of any
 * production bundle (not reachable from `index.ts`, `plugin.ts` or the default
 * sandbox entry, and not a tsdown build entry).
 */
export default createSandboxWorker(plugin, { testHooks: true });
