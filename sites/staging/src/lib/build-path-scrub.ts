/**
 * Issue #121: keep the builder's absolute paths out of the deployed worker.
 *
 * Astro writes absolute filesystem paths into the server bundle, and no config
 * option turns that off:
 *  - the compiler puts each `.astro` file's absolute path into its
 *    `createComponent(…, "<path>")` call and into `$$file`;
 *  - the serialized SSR manifest stores `rootDir`, `srcDir`, `outDir`, … as
 *    `file://<path>` URLs, and keys `entryModules` and `componentMetadata` by
 *    absolute module id.
 * So every build carried `/home/<user>/<checkout>/…` into the worker it uploads.
 *
 * WHY AN INTEGRATION HOOK AND NOT A VITE/ROLLDOWN PLUGIN. The manifest is not in
 * the bundle while Rolldown runs: Astro emits a placeholder and fills it in from
 * its own post-build step (`manifestBuildPostHook` in astro's
 * `core/build/plugins/plugin-manifest.js`), after every bundler hook has run. A
 * `renderChunk` rewrite therefore relativizes the `createComponent` ids but not
 * the manifest keys they are looked up under, and the runtime then misses its
 * `componentMetadata` (head propagation) and `entryModules` (island scripts)
 * entries. `astro:build:done` is the first point where the server bundle is
 * final, so the rewrite runs there, over the server output only.
 *
 * The rewrite removes the workspace-root prefix, so
 * `<root>/sites/staging/src/X.astro` becomes `/sites/staging/src/X.astro` and
 * `file://<root>/sites/staging/` becomes `file:///sites/staging/` (still a valid
 * URL). Every occurrence changes the same way, so an id and the map key it is
 * looked up under stay equal.
 *
 * Scope:
 *  - build only: `astro dev` never fires `astro:build:done`, so dev keeps real
 *    paths for error overlays, the dev toolbar and editor links;
 *  - after prerendering, which reads files by these paths on this machine;
 *  - only `.mjs`/`.js` under `build.server` (the worker). The client bundle
 *    carries none of these paths, and `wrangler.json` is local deploy metadata
 *    that wrangler reads from this machine. `test/build-path-leak.test.ts` scans
 *    all of `dist/`;
 *  - the site emits no source maps. The rewrite only shortens strings inside a
 *    line, so line numbers in a stack trace still match the chunk.
 *
 * ANCHORED, not a bare substring replace. In a real build the root only ever
 * starts a string literal (`"<root>/…"`, 309 times) or a file URL
 * (`file://<root>/…`, 7 times). Matching only there is what keeps a short root
 * (a Docker WORKDIR such as `/otta` or `/app`) from rewriting real literals:
 * `"/_emdash/api/plugins/otta/admin"` contains `/otta/` but does not start with
 * it.
 *
 * THE SECOND LEAK: SHELL VARIABLES. Astro loads ALL of `process.env` as private
 * env (`loadEnv(mode, root, "")` in astro's `env/env-loader.js`). In every
 * server module that uses a bare `import.meta.env`, it then inlines each
 * variable whose NAME is a substring of that module's source
 * (`getReferencedPrivateKeys`: `source.includes(key)`, in
 * `env/vite-plugin-import-meta-env.js`). `_` is a substring of nearly every
 * module, so the shell's `_` (the path of the binary that started the build,
 * e.g. `/home/runner/setup-pnpm/node_modules/.bin/pnpm`) was baked into eight
 * chunks; `NODE` and `EDITOR` were too. No Astro 7.3.6 option narrows this:
 * `vite.envPrefix` only names PUBLIC prefixes, `env.schema` only adds secrets,
 * and `envDir` only moves the `.env` files. So the integration drops the shell's
 * own path variables ({@link SHELL_PATH_ENV_KEYS}) from `process.env` in
 * `astro:config:setup`, which runs before Astro reads the env. It does this for
 * `build` only, so `astro dev` keeps `EDITOR`/`VISUAL` for open-in-editor.
 *
 * THE THIRD LEAK: SECRETS IN THE BUILD SHELL (issue #584). The same heuristic
 * inlines a secret's VALUE when its name appears in such a module. emdash's
 * OAuth routes call `getOAuthConfig(cfEnv ?? import.meta.env)` and name
 * `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` and
 * their `EMDASH_OAUTH_*` forms, so a build whose shell exported one wrote it in
 * plain text into `_provider_*.mjs` and `callback_*.mjs`. Astro also defines
 * `import.meta.env.KEY` as a plain string literal for EVERY private key, so a
 * dotted read leaks the same way. Removing the values loses nothing at runtime:
 * under @astrojs/cloudflare, emdash's `virtual:emdash/env` re-exports `env` from
 * `cloudflare:workers`, which is always defined, so `cfEnv ?? import.meta.env`
 * never reaches the fallback. Layers:
 *  - `astro:config:setup` drops every secret ({@link isBuildSecretEnvKey}) from
 *    `process.env` for a build, and warns with the NAMES it dropped;
 *  - `astro:build:done` deletes `<server>/.dev.vars`: the Cloudflare Vite
 *    plugin copies the project's `.dev.vars` (or `.env`) there in plain text.
 *    `wrangler deploy` does not upload it and `astro dev` reads the source
 *    file, so nothing loses it except `astro preview` of a built `dist/`; any
 *    copy of `dist/` (an artifact, a cache, a tarball) would otherwise carry
 *    the local secrets. Deleting rather than failing keeps the documented dev
 *    setup (a dev-only `EMDASH_ENCRYPTION_KEY` in `.env`) buildable;
 *  - `astro:build:done` then FAILS the build, and deletes the server bundle so
 *    a careless `wrangler deploy` has nothing to ship, if any secret VALUE is
 *    still in it: the values dropped from the shell plus the secrets Astro
 *    itself loads from `.env` files (`loadEnv`, which `process.env` never
 *    sees). It searches every server file for each value, raw and
 *    JSON-escaped, so the define's form and the bundler's spacing do not
 *    matter. Astro's inlined env object is checked by key as well
 *    ({@link findInlinedSecretsInDir}), which also covers a value too short to
 *    search for.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AstroIntegration } from "astro";

export const BUILD_PATH_SCRUB_INTEGRATION = "otta:build-path-scrub";

/** The repo root: the nearest directory above this file holding `pnpm-workspace.yaml`. */
export function workspaceRoot(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error(`build-path-scrub: no pnpm-workspace.yaml above ${dir}`);
		dir = parent;
	}
	return dir;
}

/**
 * Shell bookkeeping variables whose values are paths on the build machine and
 * which nothing in a build reads as configuration: `_` (the last command run),
 * `PWD`/`OLDPWD`, `NODE` (pnpm/npm set it to the node binary) and the editor
 * pair. Values that are not paths (`CI`, `NODE_ENV`) are left alone.
 */
export const SHELL_PATH_ENV_KEYS = ["_", "PWD", "OLDPWD", "NODE", "EDITOR", "VISUAL"] as const;

/** Removes {@link SHELL_PATH_ENV_KEYS} from `env` in place. */
export function dropShellPathEnv(env: NodeJS.ProcessEnv): void {
	for (const key of SHELL_PATH_ENV_KEYS) delete env[key];
}

/**
 * Secrets that must never be in a build's environment. emdash's own names
 * (auth, encryption, preview, IP salt, OAuth, Turnstile, storage and database
 * credentials, its CLI token), Otta's (the Stripe pair, the webhook edge token)
 * and the deploy credentials a CI job typically exports. A name that is not
 * listed is still caught by its shape ({@link isBuildSecretEnvKey}).
 */
export const BUILD_SECRET_ENV_KEYS = [
	"EMDASH_AUTH_SECRET",
	"AUTH_SECRET",
	"EMDASH_ENCRYPTION_KEY",
	"EMDASH_PREVIEW_SECRET",
	"EMDASH_IP_SALT",
	"EMDASH_OAUTH_GITHUB_CLIENT_SECRET",
	"GITHUB_CLIENT_SECRET",
	"EMDASH_OAUTH_GOOGLE_CLIENT_SECRET",
	"GOOGLE_CLIENT_SECRET",
	"EMDASH_OAUTH_MICROSOFT_CLIENT_SECRET",
	"MICROSOFT_CLIENT_SECRET",
	"EMDASH_TURNSTILE_SECRET_KEY",
	"TURNSTILE_SECRET_KEY",
	"EMDASH_TOKEN",
	"TURSO_AUTH_TOKEN",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"S3_ACCESS_KEY_ID",
	"S3_SECRET_ACCESS_KEY",
	"PREVIEW_SECRET",
	// Connection strings: they usually carry a password.
	"DATABASE_URL",
	"REDIS_URL",
	"PG_CONNECTION_STRING",
	"POSTGRES_URL",
	"STRIPE_SECRET_KEY",
	"STRIPE_WEBHOOK_SECRET",
	"OTTA_WH_TOKEN",
	"CLOUDFLARE_API_TOKEN",
	"GITHUB_TOKEN",
	"NPM_TOKEN",
] as const;

const LISTED_SECRET_ENV_KEYS: ReadonlySet<string> = new Set(BUILD_SECRET_ENV_KEYS);

/**
 * A secret-shaped name: an `_`-delimited word such as `SECRET`, `TOKEN`,
 * `PASSWORD` or `SALT`, or a key such as `API_KEY`/`ACCESS_KEY`/`PRIVATE_KEY`.
 */
const SECRET_SHAPED_ENV_KEY =
	/(?:^|_)(?:SECRETS?|TOKEN|PASSWORD|PASSWD|SALT|CREDENTIALS?|(?:API|ACCESS|PRIVATE|ENCRYPTION|SIGNING|AUTH)_KEY)(?:_|$)/i;

/** A name that ENDS in a bare `KEY`, `PASS` or `DSN` (`LICENSE_KEY`, `SMTP_PASS`, `SENTRY_DSN`). */
const SECRET_SUFFIX_ENV_KEY = /(?:^|_)(?:KEY|PASS|DSN)$/i;

/** Keys that are public by design: Turnstile's site key, Stripe's publishable key. */
const PUBLIC_KEY_SUFFIX = /(?:^|_)(?:SITE|PUBLISHABLE|PUBLIC)_KEY$/i;

/**
 * Whether `key` names a secret: listed in {@link BUILD_SECRET_ENV_KEYS}, or
 * secret-shaped. `PUBLIC_*` is exempt: that prefix is Astro's own promise that a
 * value is public, and Astro ships it to the browser by design. So are
 * `*_SITE_KEY`, `*_PUBLISHABLE_KEY` and `*_PUBLIC_KEY` for the `KEY` suffix rule.
 */
export function isBuildSecretEnvKey(key: string): boolean {
	if (key.startsWith("PUBLIC_")) return false;
	if (LISTED_SECRET_ENV_KEYS.has(key) || SECRET_SHAPED_ENV_KEY.test(key)) return true;
	return SECRET_SUFFIX_ENV_KEY.test(key) && !PUBLIC_KEY_SUFFIX.test(key);
}

/** The secrets in `env` ({@link isBuildSecretEnvKey}), name to value. */
export function buildSecretEnvValues(env: Record<string, string | undefined>): Map<string, string> {
	const secrets = new Map<string, string>();
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && isBuildSecretEnvKey(key)) secrets.set(key, value);
	}
	return secrets;
}

/** Removes every secret ({@link isBuildSecretEnvKey}) from `env` in place; returns their names. */
export function dropBuildSecretEnv(env: NodeJS.ProcessEnv): string[] {
	const dropped = Object.keys(env).filter(isBuildSecretEnvKey);
	for (const key of dropped) delete env[key];
	return dropped;
}

/**
 * Astro inlines private env into a server module that uses a bare
 * `import.meta.env` as `Object.assign({ …, "SSR": true }, { KEY: "value", … })`.
 * Returns the keys of every such inlined object in `code`. Every value is a JSON
 * string, so the object is read string by string: a brace or comma inside a
 * value cannot end it early.
 */
export function inlinedEnvKeys(code: string): string[] {
	const str = String.raw`"(?:[^"\\]|\\.)*"`;
	const prop = String.raw`"?([A-Za-z_$][\w$]*)"?\s*:\s*${str}`;
	const object = new RegExp(
		String.raw`"SSR": (?:true|false)\s*\}, \{((?:\s*"?[A-Za-z_$][\w$]*"?\s*:\s*${str}\s*,?)*)\s*\}\)`,
		"g",
	);
	const keys: string[] = [];
	for (const match of code.matchAll(object)) {
		for (const key of match[1]?.matchAll(new RegExp(prop, "g")) ?? []) {
			if (key[1] !== undefined) keys.push(key[1]);
		}
	}
	return keys;
}

/**
 * Every `<file>: <KEY>` for a secret inlined into a `.mjs`/`.js` file under
 * `dir`, the file relative to `dir`. Names only: a value is never returned.
 */
export function findInlinedSecretsInDir(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.m?js$/.test(entry.name)) continue;
		const file = path.join(entry.parentPath, entry.name);
		for (const key of inlinedEnvKeys(readFileSync(file, "utf8"))) {
			if (isBuildSecretEnvKey(key)) found.push(`${path.relative(dir, file)}: ${key}`);
		}
	}
	return found;
}

/**
 * Values shorter than this are not searched for: a short string such as `true`
 * or `1234` matches unrelated code. Real secrets are far longer, and Astro's
 * inlined env object is still checked by key ({@link findInlinedSecretsInDir}).
 */
export const MIN_SEARCHED_SECRET_LENGTH = 8;

/** Every file under `dir`, recursively. */
function filesIn(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Every `<file>: <KEY>` for a secret whose VALUE appears, raw or JSON-escaped,
 * in any file under `dir`, the file relative to `dir`. This does not depend on
 * how the value got there (the env object, a dotted `import.meta.env.KEY`
 * define, minified or not). Names only: a value is never returned.
 */
export function findLeakedSecretValuesInDir(dir: string, secrets: Map<string, string>): string[] {
	const needles = [...secrets]
		.filter(([, value]) => value.length >= MIN_SEARCHED_SECRET_LENGTH)
		.map(([key, value]) => ({
			key,
			forms: [...new Set([value, JSON.stringify(value).slice(1, -1)])],
		}));
	if (needles.length === 0) return [];
	const found: string[] = [];
	for (const file of filesIn(dir)) {
		const text = readFileSync(file, "utf8");
		for (const { key, forms } of needles) {
			if (forms.some((form) => text.includes(form)))
				found.push(`${path.relative(dir, file)}: ${key}`);
		}
	}
	return found;
}

type LoadEnv = (mode: string, envDir: string | false, prefixes: string) => Record<string, string>;

/**
 * Vite's own `loadEnv`, the function Astro loads a build's env with
 * (`loadEnv(mode, envDir, "")`: `.env`, `.env.local`, `.env.<mode>`, … plus
 * `process.env`). Vite is Astro's dependency, not this package's, so it is
 * resolved from Astro's location. It is imported when this module loads:
 * the config (and so this module) runs in Astro's config module runner, which
 * is already closed when the integration hooks run, so an `import()` from a
 * hook fails ("Vite module runner has been closed").
 */
const viteLoadEnv: LoadEnv = (
	(await import(
		/* @vite-ignore */ pathToFileURL(createRequire(import.meta.resolve("astro")).resolve("vite"))
			.href
	)) as {
		loadEnv: LoadEnv;
	}
).loadEnv;

const LEAK_HELP =
	"Astro writes a variable from the build's env or a .env file into the bundle when its name " +
	"appears next to `import.meta.env` (or is read as `import.meta.env.KEY`). Remove it from the " +
	"build environment and from sites/staging/.env, set it as a Worker secret (`wrangler secret " +
	"put`), and build again. For `astro dev`, keep local secrets in sites/staging/.dev.vars, which " +
	"Astro never reads (DEPLOYMENT.md §3).";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes the root where it STARTS a path: right after a string quote
 * (`"<root>/x"` → `"/x"`) or as the path of a file URL, plain or percent-encoded
 * (`file://<root>/x` → `file:///x`). The trailing slash is part of the match, so
 * a sibling such as `<root>-other/` is left alone.
 */
export function scrubBuildPaths(code: string, root: string): string {
	const bare = root.replace(/\/+$/, "");
	const forms = [
		`(["'\`])${escapeRegExp(bare)}/`,
		`file://${escapeRegExp(bare)}/`,
		`${escapeRegExp(pathToFileURL(bare).href)}/`,
	];
	return code.replace(new RegExp(forms.join("|"), "g"), (_match, quote: string | undefined) =>
		quote === undefined ? "file:///" : `${quote}/`,
	);
}

/** Rewrites every `.mjs`/`.js` file under `dir` in place; returns how many changed. */
export async function scrubBuildPathsInDir(dir: string, root: string): Promise<number> {
	let changed = 0;
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.m?js$/.test(entry.name)) continue;
		const file = path.join(entry.parentPath, entry.name);
		const code = await readFile(file, "utf8");
		const scrubbed = scrubBuildPaths(code, root);
		if (scrubbed === code) continue;
		await writeFile(file, scrubbed);
		changed += 1;
	}
	return changed;
}

export function buildPathScrub(root: string = workspaceRoot()): AstroIntegration {
	let serverDir: URL | undefined;
	let envDir: string | false | undefined;
	let mode = "production";
	// The secrets dropped from the shell, kept (in memory only) to search the
	// bundle for. `undefined` outside a build, where nothing is checked.
	let droppedSecrets: Map<string, string> | undefined;
	return {
		name: BUILD_PATH_SCRUB_INTEGRATION,
		hooks: {
			"astro:config:setup": ({ command, config, logger, updateConfig }) => {
				if (command !== "build") return;
				dropShellPathEnv(process.env);
				droppedSecrets = buildSecretEnvValues(process.env);
				const dropped = dropBuildSecretEnv(process.env);
				if (dropped.length > 0) {
					logger.warn(
						`ignored ${dropped.length} secret(s) set in the build environment, so none can be ` +
							`inlined into the worker: ${dropped.toSorted().join(", ")}. Set secrets as Worker ` +
							`secrets (\`wrangler secret put\`), never in the build shell (DEPLOYMENT.md §3).`,
					);
				}
				// Astro's own `.env` lookup: `vite.envDir`, else the project root.
				envDir = config.vite?.envDir ?? fileURLToPath(config.root);
				updateConfig({
					vite: {
						plugins: [
							{
								name: `${BUILD_PATH_SCRUB_INTEGRATION}:mode`,
								configResolved: (resolved: { mode: string }) => {
									mode = resolved.mode;
								},
							},
						],
					},
				});
			},
			"astro:config:done": ({ config }) => {
				serverDir = config.build.server;
			},
			"astro:build:done": async ({ logger }) => {
				if (serverDir === undefined || !existsSync(serverDir)) return;
				const server = fileURLToPath(serverDir);
				rmSync(path.join(server, ".dev.vars"), { force: true });
				if (droppedSecrets !== undefined) {
					const secrets = new Map(droppedSecrets);
					if (envDir !== undefined) {
						for (const [key, value] of buildSecretEnvValues(viteLoadEnv(mode, envDir, ""))) {
							secrets.set(key, value);
						}
					}
					const leaks = [
						...new Set([
							...findInlinedSecretsInDir(server),
							...findLeakedSecretValuesInDir(server, secrets),
						]),
					];
					if (leaks.length > 0) {
						rmSync(server, { recursive: true, force: true });
						throw new Error(
							`a secret was written into the worker bundle (issue #584), so ${server} was ` +
								`deleted:\n  ${leaks.toSorted().join("\n  ")}\n${LEAK_HELP}`,
						);
					}
				}
				const changed = await scrubBuildPathsInDir(server, root);
				logger.info(`removed the workspace root from ${changed} server file(s)`);
			},
		},
	};
}
