/**
 * `@urumi.ai/otta-store` — the Otta storefront and admin as ONE Astro
 * integration (ADR-0045).
 *
 * A site's whole config is
 *
 *   adapter: cloudflare(),
 *   integrations: [otta({ template: 1 })],
 *
 * and this module supplies everything `sites/staging/astro.config.ts` used to
 * spell out: EmDash with the trusted Otta plugin, one route per file under
 * `src/pages`, the site middleware, the fonts, the Vite settings the plugin
 * bundle needs, the public scripts and the build guards. Commerce runs
 * IN-PROCESS in the Worker (ADR-0020); there is no service URL.
 *
 * WHAT RUNS WHEN.
 *  - `otta(options)`, while Astro loads the site's config: the template
 *    contract, the retired Stripe build key (#498), the egress hosts and the
 *    email sender. A bad value throws here, before anything is bundled, so the
 *    config module itself fails to load, exactly as the old config did.
 *  - `astro:config:setup`, once Astro knows the project root: the guards that
 *    read the site's wrangler config (downloads bucket privacy #376, the EMAIL
 *    binding ADR-0043), the seed check, and the config updates.
 *
 * Published, this file is the one part of the package that is compiled
 * (`dist/integration.mjs`): Astro loads `astro.config.*` through Node, and Node
 * will not strip types from a file under `node_modules`. Everything it points
 * Astro at (pages, middleware, worker, theme) ships as source for Vite.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import { parseExtraAllowedHosts } from "@urumi.ai/otta-plugin";
import type { AstroIntegration, AstroUserConfig } from "astro";
import { fontProviders } from "astro/config";
import emdash from "emdash/astro";
import { buildEmdashOptions } from "./emdash-options.js";
import { buildPathScrub } from "./lib/build-path-scrub.js";
import { parseDotEnv } from "./lib/dot-env.js";
import { assertDownloadsBucketPrivate } from "./lib/downloads-bucket.js";
import { assertEmailBindingForBuild } from "./lib/email-binding.js";
import { parseEmailFrom } from "./lib/email-from.js";
import { buildPlaygroundEmdashOptions } from "./playground-options.js";

/** This integration's name, as Astro lists it. */
export const OTTA_INTEGRATION_NAME = "@urumi.ai/otta-store";

/**
 * THE TEMPLATE CONTRACT (ADR-0045). The shape this release expects the site's
 * OWN files to have: the bindings in `wrangler.jsonc`, the two re-export files,
 * the pinned dependencies. A release that needs any of them changed raises this
 * number, and a site still passing the old one fails to build (see
 * {@link assertTemplateContract}) instead of deploying a broken store. A
 * release that keeps it is a pure dependency bump.
 */
export const OTTA_TEMPLATE_CONTRACT = 1;

/** Where a merchant reads what each contract change needs. */
export const OTTA_UPGRADE_NOTES_URL = "https://github.com/UrumiAI/otta.sh/blob/main/UPGRADING.md";

export interface OttaOptions {
	/**
	 * The template contract this site's files follow. REQUIRED: a site says which
	 * shape it is, and a release that expects another one refuses to build.
	 */
	template: number;
	/** The default email provider's sender (ADR-0043). Else `OTTA_EMAIL_FROM`. */
	emailFrom?: string;
	/** Its display name. Else `OTTA_EMAIL_FROM_NAME`. */
	emailFromName?: string;
	/** Comma-separated extra plugin egress hosts. Else `OTTA_EXTRA_ALLOWED_HOSTS`. */
	extraAllowedHosts?: string;
	/**
	 * The directory whose `.env` is read for the `OTTA_*` build settings when the
	 * shell does not set them. Default: the working directory.
	 */
	envDir?: string | URL;
	/**
	 * The wrangler config this build uses, relative to the project root. It must
	 * be the file the Cloudflare adapter reads (`configPath`). Default
	 * `wrangler.jsonc`. Any other file is treated as a local copy of
	 * `wrangler.jsonc`, which then only serves as the tracked template.
	 */
	wranglerConfig?: string;
	/** The disposable playground build (try.otta.sh). Never for a store. */
	playground?: boolean;
	/** The build environment. Default `process.env`; tests pass their own. */
	env?: Record<string, string | undefined>;
}

/** The package directory: the nearest one up holding this package's `package.json`. */
export function packageRoot(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
	let dir = from;
	for (;;) {
		const manifest = path.join(dir, "package.json");
		if (existsSync(manifest)) {
			const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
			if (name === OTTA_INTEGRATION_NAME) return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error(`${OTTA_INTEGRATION_NAME}: no package.json above ${from}`);
		dir = parent;
	}
}

const PACKAGE_ROOT = packageRoot();
const SRC = path.join(PACKAGE_ROOT, "src");

function packageVersion(): string {
	const { version } = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
		version?: unknown;
	};
	return typeof version === "string" ? version : "unknown";
}

/** Throws, naming the upgrade notes, unless `given` is this release's contract. */
export function assertTemplateContract(given: unknown, version: string = packageVersion()): void {
	if (given === OTTA_TEMPLATE_CONTRACT) return;
	throw new Error(
		`${OTTA_INTEGRATION_NAME} ${version} needs template contract ${String(OTTA_TEMPLATE_CONTRACT)}, ` +
			`but astro.config.mjs passes otta({ template: ${String(given)} }). Your store's own files ` +
			`must change before this version can build. Follow "Template contract ` +
			`${String(OTTA_TEMPLATE_CONTRACT)}" in the Otta upgrade notes (${OTTA_UPGRADE_NOTES_URL}), ` +
			`then set template: ${String(OTTA_TEMPLATE_CONTRACT)}. Until then the store keeps serving ` +
			`the last version that built.`,
	);
}

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

/** A vendored font file, as an absolute path (Astro's local provider takes one as is). */
function fontFile(relative: string): string {
	return path.join(SRC, "fonts", relative);
}

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
 *
 * The paths are absolute, into this package: the site has no copy of them.
 */
export const OTTA_FONTS: NonNullable<AstroUserConfig["fonts"]> = [
	{
		provider: fontProviders.local(),
		name: "Bricolage Grotesque",
		cssVariable: "--f-tempered-display",
		options: {
			variants: [
				{
					// Wordmark and titles sit at 700–800; 400 is the muted counter-voice.
					src: [fontFile("bricolage-grotesque/bricolage-grotesque-variable-latin.woff2")],
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
					src: [fontFile("schibsted-grotesk/schibsted-grotesk-variable-latin.woff2")],
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
					src: [fontFile("martian-mono/martian-mono-variable-latin.woff2")],
					weight: "300 700",
					style: "normal",
					display: "swap",
					unicodeRange: LATIN_UNICODE_RANGE,
				},
			],
		},
	},
];

/**
 * One injected route per file under the package's `src/pages`, with the
 * pattern Astro's file router would give it (`index` is its directory,
 * `[param]` segments kept as they are). The list is read from the directory,
 * so a page added to the package is routed with no second list to keep in step.
 */
export function storefrontRoutes(
	pagesDir: string = path.join(SRC, "pages"),
): { pattern: string; entrypoint: string }[] {
	const routes: { pattern: string; entrypoint: string }[] = [];
	for (const entry of readdirSync(pagesDir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.(astro|ts)$/.test(entry.name)) continue;
		const entrypoint = path.join(entry.parentPath, entry.name);
		const segments = path
			.relative(pagesDir, entrypoint)
			.replace(/\.(astro|ts)$/, "")
			.split(path.sep);
		if (segments.at(-1) === "index") segments.pop();
		routes.push({ pattern: `/${segments.join("/")}`, entrypoint });
	}
	return routes.toSorted((a, b) => a.pattern.localeCompare(b.pattern));
}

/** The first-party scripts pages load as `<script src="/scripts/<name>.js">`. */
export const PUBLIC_SCRIPTS_DIR = path.join(PACKAGE_ROOT, "public", "scripts");

/** The seed EmDash applies to a new database (its own lookup order: `.emdash/seed.json`,
 *  `package.json` → `emdash.seed`, `seed/seed.json`). */
export const OTTA_SEED = path.join(PACKAGE_ROOT, "seed", "seed.json");

/**
 * Throws unless EmDash will find a seed. With none, EmDash applies its own
 * default seed, which has no `products` collection: the storefront would boot
 * with nothing to sell and no field to price. The template points
 * `package.json` → `emdash.seed` at {@link OTTA_SEED}.
 */
export function assertSeedFound(root: string): void {
	if (existsSync(path.join(root, ".emdash", "seed.json"))) return;
	if (existsSync(path.join(root, "seed", "seed.json"))) return;
	const manifest = path.join(root, "package.json");
	if (existsSync(manifest)) {
		const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { emdash?: { seed?: unknown } };
		const seed = pkg.emdash?.seed;
		if (typeof seed === "string" && existsSync(path.resolve(root, seed))) return;
	}
	throw new Error(
		`${OTTA_INTEGRATION_NAME}: EmDash will not find the store's seed, so a new store would boot ` +
			`with no products collection. Add "emdash": { "seed": ` +
			`"node_modules/@urumi.ai/otta-store/seed/seed.json" } to ${manifest}.`,
	);
}

/** Read one variable: the build environment first, then `<envDir>/.env`, then unset.
 *  Astro does NOT load `.env` into `process.env` while it loads the config. */
function buildSetting(
	name: string,
	env: Record<string, string | undefined>,
	envDir: string,
): string | undefined {
	const fromEnv = env[name];
	if (fromEnv !== undefined) return fromEnv;
	try {
		return parseDotEnv(readFileSync(path.join(envDir, ".env"), "utf8"))[name];
	} catch {
		return undefined; // no .env — fine
	}
}

/** `/scripts/<name>.js` in dev: Vite serves only the site's own `public/`. */
function publicScriptsDevPlugin() {
	return {
		name: `${OTTA_INTEGRATION_NAME}:public-scripts`,
		configureServer(server: {
			middlewares: {
				use(
					handler: (
						req: { url?: string },
						res: { setHeader(name: string, value: string): void; end(body: Buffer): void },
						next: () => void,
					) => void,
				): void;
			};
		}) {
			server.middlewares.use((req, res, next) => {
				const match = /^\/scripts\/([a-z0-9-]+\.js)(?:\?|$)/.exec(req.url ?? "");
				const file = match?.[1] === undefined ? undefined : path.join(PUBLIC_SCRIPTS_DIR, match[1]);
				if (file === undefined || !existsSync(file)) {
					next();
					return;
				}
				res.setHeader("Content-Type", "text/javascript; charset=utf-8");
				res.end(readFileSync(file));
			});
		},
	};
}

export default function otta(options: OttaOptions): AstroIntegration {
	assertTemplateContract(options.template);
	const env = options.env ?? process.env;
	const envDir =
		options.envDir === undefined
			? process.cwd()
			: options.envDir instanceof URL
				? fileURLToPath(options.envDir)
				: options.envDir;
	const playground = options.playground === true;

	/**
	 * Issue #498: the Stripe publishable key is no longer a build setting — it is
	 * entered in admin Settings and read per request. A build that still sets the
	 * old variable FAILS, naming where the key goes now: left unread, it would look
	 * like configuration while checkout says card payment isn't set up.
	 */
	if ((buildSetting("STRIPE_PUBLIC_KEY", env, envDir) ?? "").trim() !== "") {
		throw new Error(
			"STRIPE_PUBLIC_KEY is no longer read (issue #498). Remove it from the environment and " +
				"the site's .env, and enter the publishable key in the admin: Otta Settings → " +
				"Payments & email → Stripe publishable key.",
		);
	}

	/**
	 * THE IN-PROCESS EGRESS — resolved ONCE, here (review round 3, B1).
	 *
	 * One value and two consumers. The plugin BUNDLE reads it through Vite defines
	 * (`manifest.ts`), and the registered DESCRIPTOR needs the same value to put its
	 * hosts on `allowedHosts` — the one ADR-0006 gate that still bites in trusted
	 * mode. Feed only the defines and you get a bundle that calls a host the gate
	 * refuses. So one const, both consumers. Operator-supplied egress plugs in here.
	 *
	 * NO EMAIL URL. Email goes through EmDash's `ctx.email` (ADR-0031): install and
	 * select an EmDash email provider; otta grants itself no email host. The site's
	 * default provider is wired below (`emailFrom`, ADR-0043).
	 *
	 * NEVER SECRETS. API credentials live in write-only plugin kv (the `settings:`
	 * keys `payment-secrets.ts` owns), provisioned through the admin Settings form —
	 * which is what keeps wrangler-config.test.ts's /SECRET|KEY|TOKEN|PASSWORD/i ban
	 * on `vars` intact and unroutable-around, and why site-config.test.ts can assert
	 * this file names none of them.
	 *
	 * UNSET IS THE DEFAULT AND IT IS FAIL-CLOSED: with no OTTA_EXTRA_ALLOWED_HOSTS,
	 * the allowlist is the constant part alone — Stripe's API host.
	 */
	const egress = {
		// OTTA_EXTRA_ALLOWED_HOSTS: comma-separated extra egress hostnames. Validated
		// HERE so a typo fails the build loudly (parseExtraAllowedHosts throws naming
		// the entry); the normalized list is what both the descriptor and the Vite
		// define below receive, so they agree by construction.
		extraAllowedHosts: parseExtraAllowedHosts(
			options.extraAllowedHosts ?? buildSetting("OTTA_EXTRA_ALLOWED_HOSTS", env, envDir),
		),
	};

	/**
	 * The default email provider's sender (ADR-0043). Unset registers NO provider
	 * (fail-closed, ADR-0031). Validated here so a malformed address fails the
	 * build. Not a secret and not a wrangler `vars` entry: it is baked into the
	 * provider's descriptor at build time. The playground does not receive it.
	 */
	const emailFrom = playground
		? undefined
		: parseEmailFrom(
				options.emailFrom ?? buildSetting("OTTA_EMAIL_FROM", env, envDir),
				options.emailFromName ?? buildSetting("OTTA_EMAIL_FROM_NAME", env, envDir),
			);

	const wranglerConfig = options.wranglerConfig ?? "wrangler.jsonc";
	let clientDir: URL | undefined;

	return {
		name: OTTA_INTEGRATION_NAME,
		hooks: {
			"astro:config:setup": ({ config, updateConfig, injectRoute, addMiddleware }) => {
				const root = fileURLToPath(config.root);
				const read = (file: string) => readFileSync(path.join(root, file), "utf8");

				/**
				 * A guard on the config this build actually uses. It throws naming the
				 * file: the private downloads bucket must never be the public media
				 * bucket (issue #376): EmDash serves every MEDIA key without auth
				 * (`src/lib/downloads-bucket.ts`).
				 */
				assertDownloadsBucketPrivate(read(wranglerConfig), wranglerConfig);

				/**
				 * A configured sender needs the `EMAIL` send_email binding in the config
				 * this build uses (ADR-0043): selected-but-unbound burns order-email
				 * attempts.
				 */
				assertEmailBindingForBuild(emailFrom, {
					...(wranglerConfig !== "wrangler.jsonc" ? { localText: read(wranglerConfig) } : {}),
					templateText: read(
						wranglerConfig === "wrangler.jsonc" ? wranglerConfig : "wrangler.jsonc",
					),
				});

				if (!playground) assertSeedFound(root);

				updateConfig({
					output: "server",
					image: {
						layout: "constrained",
						responsiveStyles: true,
					},
					fonts: OTTA_FONTS,
					// `buildPathScrub` (issue #121) removes the builder's absolute paths
					// from the worker bundle once the build is done; see
					// src/lib/build-path-scrub.ts. It roots itself at the project root
					// (or the workspace above it).
					integrations: [
						react(),
						playground
							? emdash(buildPlaygroundEmdashOptions(egress))
							: emdash(buildEmdashOptions(egress, emailFrom)),
						buildPathScrub(),
					],
					// CSRF: Astro's `security.checkOrigin` does NOT protect the storefront's
					// endpoints — the emdash integration force-injects `checkOrigin: false`
					// and its replacement layer covers only /_emdash/api/* routes. The
					// protection is the site-owned origin check in src/middleware.ts
					// (src/lib/origin-guard.ts, ADR-0006). We still never set checkOrigin:false
					// ourselves (pinned by the site-config test) so nothing regresses if emdash
					// stops overriding.
					vite: {
						plugins: [publicScriptsDevPlugin()],
						// Build-time globals the @urumi.ai/otta-plugin bundle reads through
						// `typeof` guards (manifest.ts, src/lib/stripe-config.ts).
						define: {
							// Validated extra egress hosts, comma-joined, from the SAME `egress` const
							// that decides what the descriptor allowlists (see its note above).
							// ALWAYS a string: baking `undefined` would leave the identifier
							// undeclared, and `""` is what the plugin's `typeof` guard reads as none.
							__OTTA_EXTRA_ALLOWED_HOSTS__: JSON.stringify(egress.extraAllowedHosts.join(",")),
							// The disposable playground build sets this true and seeds demo
							// commerce. The storefront deploy must stay false.
							__OTTA_PLAYGROUND__: JSON.stringify(playground),
						},
						ssr: {
							// UNCONDITIONAL: if @urumi.ai/otta-plugin is ever externalized the defines
							// it reads (the egress defines above, `__OTTA_DEV_STRIPE_OFFLINE__`)
							// silently never apply. (In this repository it is also consumed as TS
							// source via its workspace `"."`/`"./plugin"` exports, which requires
							// bundling anyway.)
							//
							// @urumi.ai/otta-admin-react is here for the second reason only: its
							// workspace `"."`/`"./admin"` exports point at TS/TSX SOURCE, so it
							// cannot be externalized. It carries no build-time define.
							//
							// @urumi.ai/otta-store itself: its runtime ships as `.ts` and `.astro`
							// source, which only Vite can compile.
							noExternal: [
								"@urumi.ai/otta-plugin",
								"@urumi.ai/otta-admin-react",
								OTTA_INTEGRATION_NAME,
							],
						},
						optimizeDeps: {
							// Dev only (issue #568). Both are first imported when the admin loads —
							// PluginRegistry by EmDash's admin.astro, plugin-utils by
							// packages/admin-react/src/console-api.ts — so Vite's crawl misses them,
							// discovers them mid-session, re-bundles and reloads the admin SPA under
							// a running e2e test. Listing them pre-bundles both at startup. Bare
							// specifiers resolve from the site, which depends on emdash directly
							// (same 1.3.1 instance admin-react gets). Merged with the emdash
							// integration's own `include`; a production build does not use it.
							include: ["emdash/internal/routes/PluginRegistry", "emdash/plugin-utils"],
						},
					},
					devToolbar: { enabled: false },
				});

				for (const route of storefrontRoutes()) injectRoute(route);
				/* "post": after EmDash's middlewares, which are all "pre" — where the
				   site's own src/middleware.ts used to run. */
				addMiddleware({ entrypoint: path.join(SRC, "middleware.ts"), order: "post" });
			},
			"astro:config:done": ({ config }) => {
				clientDir = config.build.client;
			},
			/* The client output is what wrangler uploads as static assets, so the
			   scripts keep their `/scripts/<name>.js` URLs. */
			"astro:build:done": async () => {
				if (clientDir === undefined) return;
				const target = path.join(fileURLToPath(clientDir), "scripts");
				await mkdir(target, { recursive: true });
				for (const name of readdirSync(PUBLIC_SCRIPTS_DIR)) {
					await copyFile(path.join(PUBLIC_SCRIPTS_DIR, name), path.join(target, name));
				}
			},
		},
	};
}
