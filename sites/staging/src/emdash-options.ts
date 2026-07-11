/**
 * The emdash() integration options for the staging site — a pure builder
 * so the site-config test can assert the whole trusted-registration
 * surface (plan D6):
 *  - D1 (`DB`) with `session: "auto"` — inert until read replication is
 *    enabled on the D1 database account-side; harmless before that, free
 *    read-replica routing after. Do not remove.
 *  - R2 (`MEDIA`) — zero-config media storage.
 *  - The Urumi plugin registered TRUSTED via a hand-written descriptor
 *    (ADR-0004). Deliberately NO `sandboxed:`, NO `sandboxRunner:` — the
 *    Worker-Loader sandbox is the Workers-Paid cost pivot this deployment
 *    avoids — and no cloudflareImages/Stream/Access (paid / not needed:
 *    default passkey+password auth with the first-boot setup wizard).
 */
import { d1, r2 } from "@emdash-cms/cloudflare";
import type { DatabaseDescriptor, PluginDescriptor, StorageDescriptor } from "emdash";
import { urumiPluginDescriptor } from "./urumi-plugin-descriptor.js";

/** Placeholder mirrors @urumi/plugin's manifest fallback — a build without
 *  COMMERCE_SERVICE_URL produces a deployable-but-inert commerce egress.
 *  Kept as a literal (importing the plugin's resolved constant would be
 *  circularly self-fulfilling); equality with the plugin's un-defined
 *  COMMERCE_SERVICE_BASE_URL is pinned in site-config.test.ts so the two
 *  can never diverge silently. */
export const COMMERCE_SERVICE_URL_PLACEHOLDER = "https://commerce.urumi.internal";

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
		database: d1({ binding: "DB", session: "auto" }),
		storage: r2({ binding: "MEDIA" }),
		plugins: [urumiPluginDescriptor(serviceUrl)],
	};
}
