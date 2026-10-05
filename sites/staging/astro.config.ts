/**
 * Otta staging storefront + admin — EmDash on Cloudflare Workers.
 *
 * Modeled on em-dash's `templates/starter-cloudflare/astro.config.mjs`
 * (no Access / Images / Stream / sandbox), plus the trusted Otta plugin
 * descriptor (ADR-0006). Commerce runs IN-PROCESS in this Worker: there is no
 * separate service to point at, and the only build-time URLs left are the two
 * optional egress endpoints below (email provider, x402 facilitator), which are
 * baked into the bundle AND fed to the descriptor's allowlist from one const.
 */
import { existsSync, readFileSync } from "node:fs";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";
import { parseDotEnv } from "./src/lib/dot-env.js";
import { buildEmdashOptions } from "./src/emdash-options.js";
import { devLoginCaptureIntegration } from "./src/lib/e2e-login-capture.js";
import { devStripeOfflineIntegration } from "./src/lib/e2e-stripe-offline.js";
import { resolveStripePublishableKey, STRIPE_PUBLIC_KEY_VAR } from "./src/lib/stripe-config.js";

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
 * THE IN-PROCESS EGRESS URLS — resolved ONCE, here (review round 3, B1).
 *
 * These are two URLs and two consumers. The plugin BUNDLE reads them as Vite
 * defines (`manifest.ts`: `__OTTA_EMAIL_API_URL__`,
 * `__OTTA_X402_FACILITATOR_URL__`) to decide whether to build an `EmailSender` and
 * a facilitator client at all. The registered DESCRIPTOR needs the same two values
 * to put their hosts on `allowedHosts` — and `allowedHosts` is the one ADR-0006
 * gate that still bites in trusted mode. Feed only the defines and you get a
 * bundle that sends email to a host the gate refuses: every send fails, rows
 * reschedule and park `failed`, and the cron leg reports `count: 0` instead of the
 * honest `skipped`. So one const, both consumers.
 *
 * URLS, NEVER SECRETS. The API credentials that ride them live in write-only
 * plugin kv (the `settings:` keys `payment-secrets.ts` owns), provisioned through
 * the admin Settings form — which is what keeps wrangler-config.test.ts's
 * /SECRET|KEY|TOKEN|PASSWORD/i ban on `vars` intact and unroutable-around, and
 * why site-config.test.ts can assert this file names none of them.
 *
 * UNSET IS THE DEFAULT AND IT IS FAIL-CLOSED, not broken: the define bakes `""`,
 * which `hostnameOf` yields no host for, so `resolveInProcessEgress` reports the
 * provider unconfigured and `resolveAllowedHosts` grants nothing for it. Staging
 * today sets neither, so its allowlist is the Stripe API host alone — order email
 * is a capability this deployment does not yet have, and setting `EMAIL_API_URL`
 * at build time is the whole of turning it on.
 */
const egress = {
	emailApiUrl: process.env.EMAIL_API_URL ?? readDotEnv("EMAIL_API_URL"),
	facilitatorUrl: process.env.X402_FACILITATOR_URL ?? readDotEnv("X402_FACILITATOR_URL"),
};

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
	// The last two bake the e2e defines, each `true` only under `astro dev` with
	// its variable set to 1 (issue #378 and its follow-up):
	// `__OTTA_DEV_STRIPE_OFFLINE__` (OTTA_E2E_STRIPE_OFFLINE) for the order seed,
	// and `__OTTA_DEV_LOGIN_CAPTURE__` (OTTA_E2E_LOGIN_CAPTURE) for the signed-in
	// account specs. Integrations because only a hook can see the command; see
	// src/lib/e2e-stripe-offline.ts and src/lib/e2e-login-capture.ts.
	integrations: [
		react(),
		emdash(buildEmdashOptions(egress)),
		devStripeOfflineIntegration(),
		devLoginCaptureIntegration(),
	],
	// CSRF: Astro's `security.checkOrigin` does NOT protect the /cart/*
	// endpoints — the emdash integration force-injects `checkOrigin: false`
	// and its replacement layer covers only /_emdash/api/* routes. The
	// protection is the site-owned origin guard (src/lib/origin-guard.ts,
	// ADR-0006). We still never set checkOrigin:false ourselves (pinned by
	// the site-config test) so nothing regresses if emdash stops overriding.
	vite: {
		// Build-time globals the @otta-sh/plugin bundle reads through `typeof`
		// guards (manifest.ts, src/lib/stripe-config.ts).
		define: {
			// The Stripe publishable key for /checkout/pay's Payment Element
			// (src/lib/stripe-config.ts). ALWAYS a string — an unconfigured store
			// bakes "", which that module reads as undefined; baking `undefined`
			// would leave the identifier undeclared in the worker bundle.
			__OTTA_STRIPE_PUBLIC_KEY__: JSON.stringify(stripePublishableKey ?? ""),
			// The two in-process egress URLs, from the SAME `egress` const that
			// decides what the descriptor allowlists (see its note above). ALWAYS a
			// string, like the Stripe key: baking `undefined` would leave the
			// identifier undeclared, and `""` is what both the plugin's `typeof`
			// guard and `hostnameOf` read as "this provider is unconfigured".
			__OTTA_EMAIL_API_URL__: JSON.stringify(egress.emailApiUrl ?? ""),
			__OTTA_X402_FACILITATOR_URL__: JSON.stringify(egress.facilitatorUrl ?? ""),
		},
		ssr: {
			// UNCONDITIONAL: if @otta-sh/plugin is ever externalized the defines
			// above silently never apply and the bundle resolves every egress URL
			// as unconfigured. (It is also consumed as TS
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
