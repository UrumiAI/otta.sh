/**
 * Otta staging storefront + admin — EmDash on Cloudflare Workers.
 *
 * Modeled on em-dash's `templates/starter-cloudflare/astro.config.mjs`
 * (no Access / Images / Stream / sandbox), plus the trusted Otta plugin
 * descriptor (ADR-0006). Commerce runs IN-PROCESS in this Worker: there is no
 * separate service to point at, and no build-time egress URL is left — the
 * plugin's allowlist is Stripe's API host alone, and email goes through EmDash's
 * `ctx.email` (ADR-0031).
 */
import { existsSync, readFileSync } from "node:fs";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";
import { parseDotEnv } from "./src/lib/dot-env.js";
import { buildEmdashOptions } from "./src/emdash-options.js";
import { assertDownloadsBucketPrivate } from "./src/lib/downloads-bucket.js";
import { devStripeOfflineIntegration } from "./src/lib/e2e-stripe-offline.js";
import { resolveStripePublishableKey, STRIPE_PUBLIC_KEY_VAR } from "./src/lib/stripe-config.js";
import { assertWranglerSessionPairing } from "./src/lib/wrangler-pairing.js";

/** Astro does NOT load .env into process.env for THIS module (verified —
 *  see src/lib/dot-env.ts), so fall back to sites/staging/.env explicitly:
 *  shell env wins, then .env, then unset. */
function readDotEnv(name: string): string | undefined {
	try {
		return parseDotEnv(readFileSync(new URL(".env", import.meta.url), "utf8"))[name];
	} catch {
		return undefined; // no .env — fine
	}
}

/**
 * The Stripe publishable key (ADR-0012 decision 4): shell env, then `.env`.
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

/**
 * Two guards on the config this build actually uses — the gitignored local
 * config when there is one, which no test sees; with no local file, the tracked
 * template. Each throws naming the file.
 *
 * THE PAIRING GUARD (issue #375). D1 sessions are on, and a `wrangler.local.jsonc`
 * copied from the pre-#375 template still carries `global_fetch_strictly_public`,
 * which breaks them at runtime with nothing failing at deploy — so the build
 * throws instead, naming the line to delete (`src/lib/wrangler-pairing.ts`). The
 * tracked template never carries the flag.
 *
 * The private downloads bucket must never be the public media bucket (issue
 * #376): EmDash serves every MEDIA key without auth (`src/lib/downloads-bucket.ts`).
 */
const selectedWranglerConfig = localWranglerConfig ?? "wrangler.jsonc";
assertWranglerSessionPairing(
	readFileSync(new URL(selectedWranglerConfig, import.meta.url), "utf8"),
	selectedWranglerConfig,
	(buildEmdashOptions().database as { config?: { session?: unknown } }).config,
);
assertDownloadsBucketPrivate(
	readFileSync(new URL(selectedWranglerConfig, import.meta.url), "utf8"),
	selectedWranglerConfig,
);

/**
 * The latin `unicode-range`: the range on the face Google Fonts' css2 response
 * comments as "latin", copied verbatim. It is what the Google provider emitted
 * before the fonts were vendored and what the vendored latin-subset files
 * cover. All three faces share it; `test/fonts-config.test.ts` pins each face
 * to this list.
 */
export const LATIN_UNICODE_RANGE: [string, ...string[]] = [
	"U+0000-00FF",
	"U+0131",
	"U+0152-0153",
	"U+02BB-02BC",
	"U+02C6",
	"U+02DA",
	"U+02DC",
	"U+0304",
	"U+0308",
	"U+0329",
	"U+2000-206F",
	"U+20AC",
	"U+2122",
	"U+2191",
	"U+2193",
	"U+2212",
	"U+2215",
	"U+FEFF",
	"U+FFFD",
];

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
	 * The theme's three faces (docs/theme/TEMPERED.md §3), SELF-HOSTED from files
	 * checked in under `src/fonts/<family>/` (each with its SIL OFL beside it).
	 * Astro serves them from this origin, so a shopper's browser never talks to
	 * fonts.googleapis.com or fonts.gstatic.com. Variables are namespaced per
	 * theme (`--f-<themeId>-<role>`) so two themes' faces never collide:
	 * `src/themes/tempered/theme.css` maps the `--f-tempered-*` variables these
	 * declare onto the shared `--u-display` / `--u-body` / `--u-data` names, and
	 * `src/themes/tempered/Layout.astro` emits the <Font> tags — only the ACTIVE
	 * theme's Layout emits its own.
	 *
	 * VENDORED, not the Google provider, and the reason is measured, not taste.
	 * Astro's Google provider (unifont) fetches css2 with a pinned macOS
	 * Chrome/121 user agent, and Google answers a macOS UA with builds that have
	 * NO `prep` table (macOS ignores hinting). Otherwise the files are the same:
	 * for all three faces the only table that differs is `prep`. That table is
	 * a 7-byte scan-control program (PUSHW 511 SCANCTRL PUSHB 4 SCANTYPE), not
	 * real hinting — but its presence is what makes FreeType take the native
	 * TrueType path. A font with no instructions is handed to FreeType's
	 * AUTOHINTER instead (Chromium on Linux and Android), which rounds each
	 * glyph's advance at text sizes, so body copy spaces unevenly. The files
	 * here are the builds a Windows/Linux browser gets from Google, which carry
	 * `prep`.
	 *
	 * Each file is the full variable font (same axes as the previous Google
	 * download): Bricolage Grotesque opsz 12–96,
	 * wdth 75–100, wght 200–800; Schibsted Grotesk wght 400–900; Martian Mono
	 * wdth 75–112.5, wght 100–800. The width contrast between the narrow display
	 * face and the wide data face is the theme's loudest move, so
	 * `font-variation-settings: "wdth" …` must never be a silent no-op.
	 * `weight` keeps the ranges the theme uses (and the descriptors the Google
	 * provider emitted), and no `stretch` descriptor is declared, exactly as
	 * before, so matching and rendering are unchanged apart from the hinting.
	 * `test/fonts-config.test.ts` pins the provider, the files, a non-empty
	 * `prep` table, the axes, `display` and the unicode range.
	 */
	fonts: [
		{
			provider: fontProviders.local(),
			name: "Bricolage Grotesque",
			cssVariable: "--f-tempered-display",
			options: {
				variants: [
					{
						// Wordmark and titles sit at 700–800; 400 is the muted counter-voice.
						src: ["./src/fonts/bricolage-grotesque/bricolage-grotesque-variable-latin.woff2"],
						weight: "400 800",
						style: "normal",
						display: "swap",
						unicodeRange: LATIN_UNICODE_RANGE,
					},
				],
			},
		},
		{
			provider: fontProviders.local(),
			name: "Schibsted Grotesk",
			cssVariable: "--f-tempered-body",
			options: {
				variants: [
					{
						src: ["./src/fonts/schibsted-grotesk/schibsted-grotesk-variable-latin.woff2"],
						weight: "400 700",
						style: "normal",
						display: "swap",
						unicodeRange: LATIN_UNICODE_RANGE,
					},
				],
			},
		},
		{
			provider: fontProviders.local(),
			name: "Martian Mono",
			cssVariable: "--f-tempered-data",
			options: {
				variants: [
					{
						src: ["./src/fonts/martian-mono/martian-mono-variable-latin.woff2"],
						weight: "300 700",
						style: "normal",
						display: "swap",
						unicodeRange: LATIN_UNICODE_RANGE,
					},
				],
			},
		},
	],
	// The last one bakes `__OTTA_DEV_STRIPE_OFFLINE__` — `true` only under
	// `astro dev` with OTTA_E2E_STRIPE_OFFLINE=1, for the e2e suite's order seed
	// (issue #378). An integration because only a hook can see the command; see
	// src/lib/e2e-stripe-offline.ts.
	integrations: [react(), emdash(buildEmdashOptions()), devStripeOfflineIntegration()],
	// CSRF: Astro's `security.checkOrigin` does NOT protect the storefront's
	// endpoints — the emdash integration force-injects `checkOrigin: false`
	// and its replacement layer covers only /_emdash/api/* routes. The
	// protection is the site-owned origin check in src/middleware.ts
	// (src/lib/origin-guard.ts, ADR-0006). We still never set checkOrigin:false
	// ourselves (pinned by the site-config test) so nothing regresses if emdash
	// stops overriding.
	vite: {
		// Build-time globals the worker bundle reads through `typeof` guards
		// (src/lib/stripe-config.ts).
		define: {
			// The Stripe publishable key for /checkout/pay's Payment Element
			// (src/lib/stripe-config.ts). ALWAYS a string — an unconfigured store
			// bakes "", which that module reads as undefined; baking `undefined`
			// would leave the identifier undeclared in the worker bundle.
			__OTTA_STRIPE_PUBLIC_KEY__: JSON.stringify(stripePublishableKey ?? ""),
		},
		ssr: {
			// UNCONDITIONAL: if @otta-sh/plugin is ever externalized the build-time
			// defines it reads (`__OTTA_DEV_STRIPE_OFFLINE__`, baked by the e2e
			// integration) silently never apply. (It is also consumed as TS
			// source via its workspace `"."`/`"./plugin"` exports, which
			// requires bundling anyway.)
			//
			// @otta-sh/admin-react is here for the second reason only: its
			// workspace `"."`/`"./admin"` exports point at TS/TSX SOURCE, so it
			// cannot be externalized. It carries no build-time define.
			noExternal: ["@otta-sh/plugin", "@otta-sh/admin-react"],
		},
	},
	devToolbar: { enabled: false },
});
