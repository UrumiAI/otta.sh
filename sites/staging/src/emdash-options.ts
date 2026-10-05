/**
 * The emdash() integration options for the staging site — a pure builder
 * so the site-config test can assert the whole trusted-registration
 * surface (plan D6):
 *  - D1 (`DB`) with `session` OFF. Not for the old wrangler-flag reason:
 *    `global_fetch_strictly_public` is gone (issue #375), though the pairing
 *    invariant still holds should it return — the flag silently hangs D1
 *    sessions (emdash #1273), pinned in site-config.test.ts. It stays off
 *    because `session: "auto"` gives a request no read-your-writes unless
 *    EmDash itself authenticates it: every other request starts on any replica
 *    (`first-unconstrained`) with no bookmark cookie. Every shopper is anonymous
 *    to EmDash, and every shopper write is a POST that 303s to a GET reading it
 *    back (place → /checkout/pay reads the new order; sign-in → /account/orders
 *    reads the new session). A lagging replica would 404 a just-placed order or
 *    bounce a just-signed-in buyer to login. Read replication is not enabled
 *    account-side today, so "off" costs nothing now; turning it on (and with it
 *    "auto" or "primary-first") is a product decision, not a config cleanup.
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
import type { InProcessEgressUrls } from "@otta-sh/plugin";
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
 * @param egress THE IN-PROCESS EGRESS URLS, threaded rather than read from the
 *   plugin's own resolver — and the omission was a real hole (review round 3,
 *   B1). The plugin bundle resolves `__OTTA_EMAIL_API_URL__` and
 *   `__OTTA_X402_FACILITATOR_URL__` from Vite defines (`manifest.ts`), and Vite
 *   substitutes defines when it bundles the WORKER; it does not touch
 *   `astro.config.ts`, which Node evaluates at config time, before any bundling.
 *   The DESCRIPTOR's `allowedHosts` is built HERE, in that Node pass. With no
 *   parameter for them the descriptor could never allowlist either host, so the
 *   first person to add one of those defines would ship a bundle holding a live
 *   `EmailSender` aimed at a host the gate refuses: every send fails, rows
 *   reschedule and park `failed`, and the sweep leg reports `count: 0` rather
 *   than the honest `skipped` — the exact failure `manifest.ts`'s
 *   `resolveInProcessEgress` note documents.
 *
 *   Same const, both consumers, one decision. The cannot-disagree test in
 *   site-config.test.ts pins it by reading `astro.config.ts` AS SOURCE and
 *   requiring that the identifier the two defines are baked from is the
 *   identifier passed here. It has to work that way: `emdash()` captures its
 *   options in a closure, so the registered descriptor is not reachable from a
 *   test, and rebuilding it from the baked values would compare two values
 *   derived from one input and stay green for the very omission described above
 *   (review round 3, A3). With nothing configured the resolved allowlist is
 *   Stripe's API host alone.
 */
export function buildEmdashOptions(egress: InProcessEgressUrls = {}): StagingEmdashOptions {
	return {
		// No `session` (= "disabled") — see the module doc above.
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
		plugins: [ottaPluginDescriptor({ egress }), ottaConsoleDescriptor()],
	};
}
