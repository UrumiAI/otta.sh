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
import { defineConfig, fontProviders } from "astro/config";
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
	/**
	 * The theme's three faces (docs/theme/TEMPERED.md §3), SELF-HOSTED: Astro
	 * downloads them at build time and serves them from this origin, so a
	 * shopper's browser never talks to fonts.googleapis.com or fonts.gstatic.com
	 * at runtime. `src/styles/tokens.css` reads the `--u-face-*` variables these
	 * declare; `src/layouts/Base.astro` emits the <Font> tags.
	 *
	 * `options.experimental.variableAxis` is load-bearing, not a nicety. Google's
	 * css2 endpoint only ships an axis you asked for, and the width contrast
	 * between the narrow display face and the wide data face is the theme's
	 * loudest move — drop these and `font-variation-settings: "wdth" …` becomes
	 * a silent no-op that renders at default widths with no error anywhere.
	 * `test/fonts-config.test.ts` pins them for that reason.
	 *
	 * CAVEAT: `experimental` here is UNIFONT's namespace (Astro's font API wraps
	 * unifont's google provider), not Astro's — it can be renamed or moved under
	 * a transitive PATCH bump, with no Astro major release to warn us.
	 * fonts-config.test.ts is the tripwire and will be the first thing to fail;
	 * the fix is to follow unifont's current option name, not to delete the
	 * assertion.
	 */
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Bricolage Grotesque",
			cssVariable: "--u-face-display",
			// Wordmark and titles sit at 700–800; 400 is the muted counter-voice.
			weights: ["400 800"],
			styles: ["normal"],
			subsets: ["latin"],
			display: "swap",
			options: { experimental: { variableAxis: { opsz: [["12", "96"]], wdth: [["75", "100"]] } } },
		},
		{
			provider: fontProviders.google(),
			name: "Schibsted Grotesk",
			cssVariable: "--u-face-body",
			weights: ["400 700"],
			styles: ["normal"],
			subsets: ["latin"],
			display: "swap",
		},
		{
			provider: fontProviders.google(),
			name: "Martian Mono",
			cssVariable: "--u-face-data",
			weights: ["300 700"],
			styles: ["normal"],
			subsets: ["latin"],
			display: "swap",
			options: { experimental: { variableAxis: { wdth: [["75", "112.5"]] } } },
		},
	],
	integrations: [react(), emdash(buildEmdashOptions(serviceUrl))],
	// CSRF: Astro's `security.checkOrigin` does NOT protect the /cart/*
	// endpoints — the emdash integration force-injects `checkOrigin: false`
	// and its replacement layer covers only /_emdash/api/* routes. The
	// protection is the site-owned origin guard (src/lib/origin-guard.ts,
	// ADR-0006). We still never set checkOrigin:false ourselves (pinned by
	// the site-config test) so nothing regresses if emdash stops overriding.
	vite: {
		// Bake the service URL into the @otta-sh/plugin bundle (manifest.ts
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
			// UNCONDITIONAL: if @otta-sh/plugin is ever externalized the define
			// above silently never applies and every ctx.http call fails the
			// allowedHosts check at runtime. (It is also consumed as TS
			// source via its workspace `"."`/`"./plugin"` exports, which
			// requires bundling anyway.)
			noExternal: ["@otta-sh/plugin"],
		},
	},
	devToolbar: { enabled: false },
});
