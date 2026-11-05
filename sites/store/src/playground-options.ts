/**
 * EmDash options for the disposable playground build.
 *
 * Same Otta registration as the storefront (`buildEmdashOptions`): the plugin
 * and the React console, trusted and in-process, no sandbox runner. The
 * database is EmDash's per-visitor Durable Object instead of the site's D1,
 * and media is the playground's bundled asset store instead of R2. That is
 * the whole difference. A visitor who opens `/playground` gets their own
 * EmDash with Otta already installed — not a bare CMS they would then have
 * to add commerce to, and not this repo's shared staging store.
 */
import { playgroundDatabase } from "@emdash-cms/cloudflare";
import type { InProcessEgressUrls } from "@urumi.ai/otta-plugin";
import { buildEmdashOptions } from "./emdash-options.js";

/** Binding name in `wrangler.playground.jsonc`. One namespace; each visitor
 *  cookie names a distinct Durable Object inside it. */
export const PLAYGROUND_DB_BINDING = "PLAYGROUND_DB";

/** EmDash's playground middleware. It mints the session, migrates, applies
 *  the site seed and signs the visitor in as the anonymous admin. */
export const PLAYGROUND_MIDDLEWARE = "@emdash-cms/cloudflare/db/playground-middleware";

export function buildPlaygroundEmdashOptions(egress: InProcessEgressUrls = {}) {
	const store = buildEmdashOptions(egress);
	return {
		database: playgroundDatabase({ binding: PLAYGROUND_DB_BINDING }),
		// Media only. Commerce documents live in the session database, the
		// same place the plugin's storage collections live on D1.
		storage: {
			entrypoint: "@emdash-cms/cloudflare/db/playground",
			config: {},
		},
		plugins: store.plugins,
		// This sandbox does not advertise an MCP server. Otta does not ship
		// one, and the playground should not grow one by inheriting the host
		// default.
		mcp: false,
		playground: {
			middlewareEntrypoint: PLAYGROUND_MIDDLEWARE,
		},
	};
}
