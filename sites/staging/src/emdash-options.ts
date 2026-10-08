/**
 * The emdash() integration options for the staging site — a pure builder
 * so the site-config test can assert the whole trusted-registration
 * surface (plan D6):
 *  - D1 (`DB`) with `session: "primary-first"` (issue #375). Every request
 *    EmDash has not authenticated — every shopper, since `otta_cart` /
 *    `otta_session` are Otta's own cookies — starts on the primary
 *    (`first-primary`), as do writes and the cron; later reads in the same
 *    request may use a replica no older than that start. That keeps the
 *    shopper's POST → 303 → GET flows correct with read replicas on: place →
 *    /checkout/pay reads the new order, sign-in → /account/orders reads the new
 *    session, and GET /checkout/resume replays a payment from what it reads.
 *    NOT "auto": it starts those same GETs on any replica with no bookmark
 *    (bookmarks go only to EmDash-authenticated requests), so a lagging replica
 *    would 404 a just-placed order or bounce a just-signed-in buyer. "auto"
 *    needs a shopper-side bookmark first. EmDash-authenticated GETs resume from
 *    their `__em_d1_bookmark` cookie (read-your-own-writes); that cookie is never
 *    set on an anonymous response. The old pairing invariant with wrangler's
 *    `global_fetch_strictly_public` is moot now the flag is gone, but the rule
 *    stands: the flag hangs every SESSION query (emdash #1273); EmDash 1.0.1's
 *    guard gives up after ~5 s, turns sessions off for that isolate, and may
 *    reject the write that was in flight (`@emdash-cms/cloudflare@1.0.1`
 *    `src/db/d1-session-guard.ts`). So the flag must never return beside
 *    a session mode: site-config.test.ts pins the template, and astro.config.ts
 *    refuses to build from a config that has it (src/lib/wrangler-pairing.ts).
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

/** The narrow option surface this site uses — structurally assignable to
 *  emdash()'s config; having no sandboxed/sandboxRunner/marketplace keys
 *  by TYPE is part of the point. */
export interface StagingEmdashOptions {
	database: DatabaseDescriptor;
	storage: StorageDescriptor;
	plugins: PluginDescriptor[];
}

/**
 * The registered options. No egress parameter: the plugin's allowlist is a
 * constant (Stripe's API host alone, `resolveAllowedHosts` in `manifest.ts`),
 * so nothing deployment-supplied has to reach the descriptor.
 */
export function buildEmdashOptions(): StagingEmdashOptions {
	return {
		// "primary-first", never "auto" — see the module doc above.
		database: d1({ binding: "DB", session: "primary-first" }),
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
		plugins: [ottaPluginDescriptor(), ottaConsoleDescriptor()],
	};
}
