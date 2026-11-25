import plugin from "../../plugin.js";
import { createSandboxWorker } from "../../sandbox-entry.js";

/**
 * The workerd entry for the agentic sandbox suites (ADR-0047): the REAL plugin,
 * served through the exact production sandbox bridge (`createSandboxWorker` —
 * same dispatch, `ctx.http` allowedHosts gate and kv persistence), with the
 * test-only windows switched on. The suites need one: setting the agentic-checkout
 * switch in kv, because the Settings form refuses to turn it on until buyer-data
 * export and erasure exist.
 *
 * Booted by `test/sandbox/harness.ts` via its `entry` option; never part of any
 * production bundle (not reachable from `index.ts`, `plugin.ts` or the default
 * sandbox entry, and not a tsdown build entry).
 */
export default createSandboxWorker(plugin, { testHooks: true });
