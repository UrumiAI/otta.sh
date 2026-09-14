/**
 * The document store the standalone workerd worker runs against — the ONE seam
 * `sandbox-entry.ts` cannot build for itself.
 *
 * READ THIS FIRST, because the file is easy to mistake for production wiring. In
 * a real deploy the host builds `ctx` and injects `ctx.storage` from the
 * descriptor's declared collections; neither this module nor `sandbox-entry.ts`
 * is involved at all. Both exist for the standalone workerd suites, which boot
 * the plugin's own bundle inside a real `workerd` process and therefore have to
 * mirror the host's side of the bridge themselves — the same reason
 * `createHttpAccess` and `createKvAccess` live next door.
 *
 * WHY A MODULE RATHER THAN AN ARGUMENT. A document store cannot be constructed
 * inside the isolate: it is a database, and the isolate has no driver and must
 * never acquire one. So the only shape that works is injection from outside, and
 * the suites' harness injects by REPLACING this module in the scratch tree it
 * bundles — exactly as it already replaces `manifest.ts` — with one whose
 * collections proxy to a real repository the harness owns. Going through a module
 * rather than a `createSandboxWorker` argument is what makes that work for EVERY
 * entry, the production one and the test fixtures alike, with no per-entry
 * plumbing to forget.
 *
 * HERE IT IS ABSENT, and absent is the honest answer: this copy has no database
 * behind it, and a bundle built from it carries no document store, no driver and
 * no egress. The in-process commerce composition asks for the store by name and
 * fails loudly when there is none, which is the failure a caller should get.
 */

import type { StorageAccess } from "@otta-sh/store-emdash";

/** The store for this bundle: none, unless something replaced this module. */
export function sandboxStorage(): StorageAccess | undefined {
	return undefined;
}
