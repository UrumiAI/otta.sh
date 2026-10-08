import plugin from "../../plugin.js";
import { createSandboxWorker } from "../../sandbox-entry.js";

/**
 * The workerd entry for the encrypted-payment-keys suite (ADR-0032): the REAL
 * plugin, served through the exact production sandbox bridge, with every stored
 * encrypted payment key reading the way EmDash 1.0.1 reports a ciphertext this
 * site cannot decrypt — the kv read rejects (`unreadableSecrets`). Writes still
 * land, so a suite provisions keys through the real Settings form first.
 *
 * Booted by `test/sandbox/harness.ts` via its `entry` option; never part of any
 * production bundle (not reachable from `index.ts`, `plugin.ts` or the default
 * sandbox entry, and not a tsdown build entry).
 */
export default createSandboxWorker(plugin, { unreadableSecrets: true });
