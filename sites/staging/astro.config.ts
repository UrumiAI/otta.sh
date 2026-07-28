/**
 * Urumi staging storefront + admin — EmDash on Cloudflare Workers.
 *
 * Modeled on em-dash's `templates/starter-cloudflare/astro.config.mjs`
 * (no Access / Images / Stream / sandbox), plus the trusted Urumi plugin
 * descriptor (ADR-0006) and the build-time commerce-service URL:
 *
 *   COMMERCE_SERVICE_URL=https://<service host> pnpm build
 *
 * The URL is baked in at BUILD time (define + allowedHosts); changing it
 * means rebuild + redeploy (see README).
 */
import { existsSync, readFileSync } from "node:fs";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { parseDotEnv } from "./src/lib/dot-env.js";
import { buildEmdashOptions, resolveServiceUrl } from "./src/emdash-options.js";
import { resolveStripePublishableKey, STRIPE_PUBLIC_KEY_VAR } from "./src/lib/stripe-config.js";

/** Astro does NOT load .env into process.env for THIS module (verified —
 *  see src/lib/dot-env.ts), so fall back to sites/staging/.env explicitly:
 *  shell env wins, then .env, then the placeholder. */
function readDotEnv(name: string): string | undefined {
	try {
		return parseDotEnv(readFileSync(new URL(".env", import.meta.url), "utf8"))[name];
	} catch {
		return undefined; // no .env — fine
	}
}

const serviceUrl = resolveServiceUrl(
	process.env.COMMERCE_SERVICE_URL ?? readDotEnv("COMMERCE_SERVICE_URL"),
);

/**
 * The Stripe publishable key (ADR-0012 decision 4), resolved the same way.
 * Absent ⇒ `undefined` ⇒ the define below bakes `""` ⇒ `/checkout` renders
 * review + totals but says "Card payment isn't set up on this store yet." and
 * creates NO order. PRESENT but malformed ⇒ `resolveStripePublishableKey`
 * THROWS here and fails the build, because a typo'd key is otherwise
 * indistinguishable at runtime from having no key at all.
 */
const stripePublishableKey = resolveStripePublishableKey(
	process.env[STRIPE_PUBLIC_KEY_VAR] ?? readDotEnv(STRIPE_PUBLIC_KEY_VAR),
);

/**
 * Real deploy identifiers live in the gitignored `wrangler.local.jsonc`
 * (the tracked `wrangler.jsonc` is a placeholder TEMPLATE). The adapter
 * reads the wrangler config at BUILD time and emits the merged
 * `dist/server/wrangler.json` that plain `wrangler deploy` then follows
 * via `.wrangler/deploy/config.json` — so the local file must be selected
 * HERE, not with `wrangler deploy --config` (which bypasses the redirect
 * and tries to rebundle the raw worker source).
 */
const localWranglerConfig = existsSync(new URL("wrangler.local.jsonc", import.meta.url))
	? "wrangler.local.jsonc"
	: undefined;

export default defineConfig({
	output: "server",
	// NOT `cloudflare({ imageService: "cloudflare" })` — that's the paid
	// image resizing product; Astro's built-in service is fine for staging.
	adapter: cloudflare(localWranglerConfig !== undefined ? { configPath: localWranglerConfig } : {}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [react(), emdash(buildEmdashOptions(serviceUrl))],
	// CSRF: Astro's `security.checkOrigin` does NOT protect the /cart/*
	// endpoints — the emdash integration force-injects `checkOrigin: false`
	// and its replacement layer covers only /_emdash/api/* routes. The
	// protection is the site-owned origin guard (src/lib/origin-guard.ts,
	// ADR-0006). We still never set checkOrigin:false ourselves (pinned by
	// the site-config test) so nothing regresses if emdash stops overriding.
	vite: {
		// Bake the service URL into the @urumi/plugin bundle (manifest.ts
		// reads this compile-time global; falls back to its placeholder).
		define: {
			__URUMI_COMMERCE_SERVICE_URL__: JSON.stringify(serviceUrl),
			// The Stripe publishable key for /checkout/pay's Payment Element
			// (src/lib/stripe-config.ts). ALWAYS a string — an unconfigured store
			// bakes "", which that module reads as undefined; baking `undefined`
			// would leave the identifier undeclared in the worker bundle.
			__URUMI_STRIPE_PUBLIC_KEY__: JSON.stringify(stripePublishableKey ?? ""),
		},
		ssr: {
			// UNCONDITIONAL: if @urumi/plugin is ever externalized the define
			// above silently never applies and every ctx.http call fails the
			// allowedHosts check at runtime. (It is also consumed as TS
			// source via its workspace `"."`/`"./plugin"` exports, which
			// requires bundling anyway.)
			noExternal: ["@urumi/plugin"],
		},
	},
	devToolbar: { enabled: false },
});
