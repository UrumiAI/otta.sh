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
import { s3 } from "emdash/astro";
import { postgres } from "emdash/db";
import { ottaConsoleDescriptor } from "./otta-console-descriptor.js";
import { ottaPluginDescriptor } from "./otta-plugin-descriptor.js";

/**
 * Which runtime this build targets, selected by `OTTA_SITE_TARGET` at BUILD
 * time — like COMMERCE_SERVICE_URL and for the same reason: the emdash
 * integration serializes these descriptors into the bundle, so nothing here
 * is switchable at runtime.
 *
 * - `cloudflare` (DEFAULT, unchanged): D1 + R2 on Workers. Every existing
 *   deploy and every existing assertion takes this path.
 * - `node`: the Node adapter behind `server/cluster.mjs`, content in Postgres
 *   and media in S3 — the container shape the platform's "Deploy from GitHub"
 *   builds (root `Dockerfile`; DEPLOYMENT.md §3bis).
 *
 * Both descriptor factories are imported statically, which costs nothing:
 * this module is build-time only (astro.config.ts and the config tests are
 * its only importers) and a descriptor is inert data — `{entrypoint, config}`
 * — whose entrypoint module emdash loads at runtime only on the target that
 * actually names it.
 */
export type SiteTarget = "cloudflare" | "node";

export const SITE_TARGET_VAR = "OTTA_SITE_TARGET";
export const DEFAULT_SITE_TARGET: SiteTarget = "cloudflare";

/** Resolve + validate the build-time target. An unrecognised value THROWS
 *  rather than falling back: a typo'd `OTTA_SITE_TARGET=nodejs` would
 *  otherwise silently produce a Cloudflare build that cannot start in the
 *  container, bound to D1 and R2 that do not exist there. */
export function resolveSiteTarget(raw: string | undefined): SiteTarget {
	if (raw === undefined || raw.length === 0) return DEFAULT_SITE_TARGET;
	if (raw === "cloudflare" || raw === "node") return raw;
	throw new Error(`${SITE_TARGET_VAR} must be "cloudflare" or "node" (got ${JSON.stringify(raw)})`);
}

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

/**
 * Content database + media storage for a target.
 *
 * The `node` pair is deliberately NOT the upstream template default of
 * `sqlite({url:"file:./data.db"})` + `local({directory:"./uploads"})`: a store
 * pod has no persistent volume, so both are lost on every restart and each
 * replica would keep a private copy. Postgres points at the per-store database
 * and `s3()` at the per-store bucket.
 *
 * `s3()` takes no credentials on purpose — it reads S3_BUCKET / S3_REGION /
 * S3_ENDPOINT from the environment and authenticates through the AWS default
 * provider chain, which resolves to the pod's IRSA role.
 *
 * `postgres()` is passed `DATABASE_URL` as read HERE, at build time, where it
 * is normally undefined (the image is built by a kaniko Job with no database).
 * That is intentional and cannot be worked around by baking a URL in — QA and
 * production run the SAME image tag against different databases. What
 * reconnects it is `server/cluster.mjs`, which translates DATABASE_URL into
 * the PG* variables `pg` falls back to; see that file for the full reasoning.
 */
function infrastructure(target: SiteTarget): Pick<StagingEmdashOptions, "database" | "storage"> {
	if (target === "node") {
		const connectionString = process.env["DATABASE_URL"];
		return {
			database: postgres(connectionString !== undefined ? { connectionString } : {}),
			storage: s3(),
		};
	}
	return {
		// No `session` — see the pairing invariant in the module doc above.
		database: d1({ binding: "DB" }),
		storage: r2({ binding: "MEDIA" }),
	};
}

export function buildEmdashOptions(
	serviceUrl: string,
	target: SiteTarget = DEFAULT_SITE_TARGET,
): StagingEmdashOptions {
	return {
		...infrastructure(target),
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
