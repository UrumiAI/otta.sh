import { createSandboxWorker } from "../../../sandbox-entry.js";
import { geoScaffoldPlugin } from "./geo-screen.js";

/**
 * The workerd entry for the scaffold characterization fixture: the synthetic
 * 3-level geo screen served through the EXACT production sandbox bridge
 * (`createSandboxWorker` — same dispatch, ctx.http allowedHosts gate, and kv
 * persistence contract as the real plugin's `sandbox-entry.ts`). Booted by
 * `test/sandbox/harness.ts` via its `entry` option; never part of any
 * production bundle (not reachable from `index.ts`/`plugin.ts`/the default
 * sandbox entry, and not a tsdown build entry).
 */
export default createSandboxWorker(geoScaffoldPlugin);
