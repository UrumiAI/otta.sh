/**
 * The emdash() integration options for the staging site — a pure builder
 * so the site-config test can assert the whole trusted-registration
 * surface (plan D6):
 *  - D1 (`DB`) with `session` OFF — it MUST stay off while wrangler.jsonc
 *    carries `global_fetch_strictly_public` (required for the site's
 *    Worker→*.workers.dev service subrequests; combining the two deadlocks
 *    every SSR request, silently — em-dash cloudflare.mdx:121-130, #1273).
 *    Read replication was inert anyway (not enabled account-side). Pinned
 *    by the pairing-invariant test in site-config.test.ts.
 *  - R2 (`MEDIA`) — zero-config media storage.
 *  - The Otta plugin registered TRUSTED via a hand-written descriptor
 *    (ADR-0006). Deliberately NO `sandboxed:`, NO `sandboxRunner:` — the
 *    Worker-Loader sandbox is the Workers-Paid cost pivot this deployment
 *    avoids — and no cloudflareImages/Stream/Access (paid / not needed:
 *    default passkey+password auth with the first-boot setup wizard).
 *  - The React console (`otta-console`) registered as a SECOND descriptor in
 *    the SAME array (ADR-0014). Two entries, one kind of registration: still
 *    `plugins: []`, still no sandbox runner.
 */
import { d1, r2 } from "@emdash-cms/cloudflare";
import type { DatabaseDescriptor, PluginDescriptor, StorageDescriptor } from "emdash";
import { ottaConsoleDescriptor } from "./otta-console-descriptor.js";
import { ottaPluginDescriptor } from "./otta-plugin-descriptor.js";

/** Placeholder mirrors @otta-sh/plugin's manifest fallback — a build without
 *  COMMERCE_SERVICE_URL produces a deployable-but-inert commerce egress.
 *  Kept as a literal (importing the plugin's resolved constant would be
 *  circularly self-fulfilling); equality with the plugin's un-defined
 *  COMMERCE_SERVICE_BASE_URL is pinned in site-config.test.ts so the two
 *  can never diverge silently. */
export const COMMERCE_SERVICE_URL_PLACEHOLDER = "https://commerce.otta.internal";

/** Resolve + validate the build-time service URL (throws early on garbage
 *  instead of baking a broken allowlist into the bundle). */
export function resolveServiceUrl(raw: string | undefined): string {
	const value = raw !== undefined && raw.length > 0 ? raw : COMMERCE_SERVICE_URL_PLACEHOLDER;
	return new URL(value).toString().replace(/\/$/, "");
}

/** The narrow option surface this site uses — structurally assignable to
 *  emdash()'s config; having no sandboxed/sandboxRunner/marketplace keys
 *  by TYPE is part of the point. */
export interface StagingEmdashOptions {
	database: DatabaseDescriptor;
	storage: StorageDescriptor;
	plugins: PluginDescriptor[];
}

export function buildEmdashOptions(serviceUrl: string): StagingEmdashOptions {
	return {
		// No `session` — see the pairing invariant in the module doc above.
		database: d1({ binding: "DB" }),
		storage: r2({ binding: "MEDIA" }),
		// TWO descriptors, one array. `otta` is unchanged — standard format,
		// five Block Kit pages, its own capabilities and allowedHosts.
		// `otta-console` is native and carries the React adminEntry. EmDash's
		// build-time throw ("Standard plugins use Block Kit for admin UI, not
		// React components") is evaluated PER DESCRIPTOR, which is what lets the
		// two coexist; and the sidebar's `adminMode` is derived PER PLUGIN ID,
		// which is why they must not be one descriptor (ADR-0014 Decision 7).
		// ORDER IS LOAD-BEARING for the site-config test, which reads
		// `plugins[0]` as the Block Kit descriptor.
		plugins: [ottaPluginDescriptor(serviceUrl), ottaConsoleDescriptor()],
	};
}
