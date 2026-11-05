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
 * `<root>/sites/store/src/X.astro` becomes `/sites/store/src/X.astro` and
 * `file://<root>/sites/staging/` becomes `file:///sites/staging/` (still a valid
 * URL). Every occurrence changes the same way, so an id and the map key it is
 * looked up under stay equal.
 *
 * Scope:
 *  - build only: `astro dev` never fires `astro:build:done`, so dev keeps real
 *    paths for error overlays, the dev toolbar and editor links;
 *  - after prerendering, which reads files by these paths on this machine;
 *  - only `.mjs`/`.js` (and their `.map`s) under `build.server` (the worker). The client bundle
 *    carries none of these paths, and `wrangler.json` is local deploy metadata
 *    that wrangler reads from this machine. `test/build-path-leak.test.ts` scans
 *    all of `dist/`;
 *  - the rewrite only shortens strings inside a line, so line numbers in a stack
 *    trace still match the chunk. Columns on a rewritten line shift, though, so a
 *    scrubbed chunk's source map has slightly wrong columns on those lines (the
 *    lines still match). Some dependencies' chunks do come with source
 *    maps (found by `scripts/pack-build.mjs`); their `sources` are rewritten too.
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
 *    sees). It searches every server file, and every client file (a
 *    prerendered page is rendered on the server but written there), for each
 *    value of at least {@link MIN_SEARCHED_SECRET_LENGTH} characters, raw and
 *    JSON-escaped, so the define's form and the bundler's spacing do not
 *    matter. A client hit deletes the client output too. Astro's inlined env
 *    object is checked by key as well ({@link findInlinedSecretsInDir}), which
 *    also covers a value too short to search for.
 *    A variable whose NAME is not secret-shaped but whose value only LOOKS random
 *    ({@link isRandomLookingEnvValue}) is searched for too, but a hit only WARNS
 *    (a release id or a build hash is not a secret). A secret-shaped name, or a
 *    value with URL credentials ({@link hasUrlCredentials}), fails the build.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AstroIntegration } from "astro";

export const BUILD_PATH_SCRUB_INTEGRATION = "otta:build-path-scrub";

/** Whether `dir` holds an npm or yarn workspace root: a package.json with `workspaces`. */
function isNpmWorkspaceRoot(dir: string): boolean {
	const manifest = path.join(dir, "package.json");
	if (!existsSync(manifest)) return false;
	try {
		return (
			(JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown }).workspaces !==
			undefined
		);
	} catch {
		return false;
	}
}

/**
 * The root whose prefix is removed: the nearest directory at or above `start`
 * holding `pnpm-workspace.yaml`, or a package.json with `workspaces` (npm, yarn)
 * (in this repository, the repo root, so both
 * `sites/store` and `sites/staging` paths go), else `start` itself. A site built
 * from the published package (ADR-0045) has no workspace file; its project root
 * holds everything the bundle names, `node_modules` included.
 */
export function workspaceRoot(
	start: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
	let dir = start;
	while (!existsSync(path.join(dir, "pnpm-workspace.yaml")) && !isNpmWorkspaceRoot(dir)) {
		const parent = path.dirname(dir);
		if (parent === dir) return start;
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
 * `PASSWORD` or `SALT`, or a key such as `API_KEY`/`ACCESS_KEY`/`PRIVATE_KEY`
 * (the underscore optional: `SENDGRID_APIKEY`).
 */
const SECRET_SHAPED_ENV_KEY =
	/(?:^|_)(?:SECRETS?|TOKEN|PASSWORD|PASSWD|SALT|CREDENTIALS?|(?:API|ACCESS|PRIVATE|ENCRYPTION|SIGNING|AUTH)_?KEY)(?:_|$)/i;

/**
 * A name that ENDS in a bare `KEY`, `PASS`, `DSN` or `PAT` (`LICENSE_KEY`, `SMTP_PASS`,
 * `SENTRY_DSN`, `GITHUB_PAT`), or in `WEBHOOK_URL` (a Slack or Discord webhook URL
 * carries its secret in the path). Suffixes only: `WEBHOOK_PATH`, `ENABLE_WEBHOOKS`
 * and `DATE_PAT_STYLE` are plain settings.
 */
const SECRET_SUFFIX_ENV_KEY = /(?:^|_)(?:KEY|PASS|DSN|PAT|WEBHOOKS?_URL)$/i;

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

/**
 * A name that says what the value is, none of it a secret: a commit, a hash, a
 * version, a release, a build, a URL or a path. CI sets many of these as long
 * hex strings.
 */
const PLAIN_VALUE_ENV_KEY =
	/(?:^|_)(?:SHA\d*|COMMIT|HASH|REV|REVISION|VERSION|RELEASE|BUILD|ID|UUID|URL|URI|PATH|DIR|HOME|HOST|BRANCH|REF)(?:_|$)/i;

/**
 * The variables GitHub Actions' runner sets that hold no secret (its documented
 * default environment variables). `GITHUB_TOKEN` and the like are not here, and
 * neither is a bare `GITHUB_`/`RUNNER_` prefix: `GITHUB_PAT` is a user's own.
 */
const GITHUB_RUNNER_ENV_KEYS: ReadonlySet<string> = new Set([
	"GITHUB_ACTION",
	"GITHUB_ACTION_PATH",
	"GITHUB_ACTION_REPOSITORY",
	"GITHUB_ACTIONS",
	"GITHUB_ACTOR",
	"GITHUB_ACTOR_ID",
	"GITHUB_API_URL",
	"GITHUB_BASE_REF",
	"GITHUB_ENV",
	"GITHUB_EVENT_NAME",
	"GITHUB_EVENT_PATH",
	"GITHUB_GRAPHQL_URL",
	"GITHUB_HEAD_REF",
	"GITHUB_JOB",
	"GITHUB_OUTPUT",
	"GITHUB_PATH",
	"GITHUB_REF",
	"GITHUB_REF_NAME",
	"GITHUB_REF_PROTECTED",
	"GITHUB_REF_TYPE",
	"GITHUB_REPOSITORY",
	"GITHUB_REPOSITORY_ID",
	"GITHUB_REPOSITORY_OWNER",
	"GITHUB_REPOSITORY_OWNER_ID",
	"GITHUB_RETENTION_DAYS",
	"GITHUB_RUN_ATTEMPT",
	"GITHUB_RUN_ID",
	"GITHUB_RUN_NUMBER",
	"GITHUB_SERVER_URL",
	"GITHUB_SHA",
	"GITHUB_STATE",
	"GITHUB_STEP_SUMMARY",
	"GITHUB_TRIGGERING_ACTOR",
	"GITHUB_WORKFLOW",
	"GITHUB_WORKFLOW_REF",
	"GITHUB_WORKFLOW_SHA",
	"GITHUB_WORKSPACE",
	"RUNNER_ARCH",
	"RUNNER_DEBUG",
	"RUNNER_ENVIRONMENT",
	"RUNNER_NAME",
	"RUNNER_OS",
	"RUNNER_TEMP",
	"RUNNER_TOOL_CACHE",
	"RUNNER_TRACKING_ID",
]);

/** Values this long, with this much entropy, look generated (a key, a token, a random secret). */
export const MIN_RANDOM_VALUE_LENGTH = 24;
export const MIN_RANDOM_VALUE_ENTROPY = 3.5;
/**
 * A random hex string has at most 4 bits per character, and a 24 to 40
 * character one often lands under 3.5, so an all-hex value uses this lower bar.
 */
export const MIN_RANDOM_HEX_ENTROPY = 3.0;

/** Shannon entropy of `value`, in bits per character. */
function entropyOf(value: string): number {
	const counts = new Map<string, number>();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

/**
 * Whether `value` carries credentials in a URL: `scheme://user:pass@host`, or
 * `scheme://<long token>@host` (a token as the user). Such a value is a secret
 * whatever the variable is called. A short user alone (`ssh://git@host`) is not.
 */
export function hasUrlCredentials(value: string): boolean {
	return /[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@:]+:[^\s/@]+|[^\s/@:]{20,})@/i.test(value);
}

/**
 * Whether the variable `key` holds a value that looks generated, whatever the
 * name: 24+ characters from the token alphabet, both letters and digits, high
 * entropy (a lower bar for all-hex). Paths, URLs (public by design), words,
 * anything Astro or the allow-list already treats as known, keys that are
 * public by design (`PUBLIC_*`, `*_SITE_KEY`, `*_PUBLISHABLE_KEY`,
 * `*_PUBLIC_KEY`), GitHub's runner variables and names that say "commit",
 * "version", "release" and the like are not.
 */
export function isRandomLookingEnvValue(key: string, value: string): boolean {
	if (key.startsWith("PUBLIC_") || key.startsWith("npm_") || key.startsWith("WORKERS_CI")) {
		return false;
	}
	if (PUBLIC_KEY_SUFFIX.test(key) || GITHUB_RUNNER_ENV_KEYS.has(key)) return false;
	if (ALLOWED_ENV_KEYS.has(key) || WHOLE_ENV_KEYS.has(key) || PLAIN_VALUE_ENV_KEY.test(key)) {
		return false;
	}
	if (value.length < MIN_RANDOM_VALUE_LENGTH) return false;
	if (/^(?:[a-z][a-z0-9+.-]*:\/\/|\/|\.{1,2}\/|~|[A-Za-z]:\\)/.test(value)) return false;
	if (!/^[A-Za-z0-9+/_=.~-]+$/.test(value)) return false;
	if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
	const floor = /^[0-9a-fA-F]+$/.test(value) ? MIN_RANDOM_HEX_ENTROPY : MIN_RANDOM_VALUE_ENTROPY;
	return entropyOf(value) >= floor;
}

/**
 * What the bundle is searched for, in two sets. `secrets` FAIL the build when
 * found: the variables with a secret-shaped name ({@link buildSecretEnvValues})
 * and any variable whose value carries URL credentials
 * ({@link hasUrlCredentials}). `random` only WARN: any other variable with a
 * random-looking value ({@link isRandomLookingEnvValue}), whose name does not say
 * it is a secret. Only the name-matched secrets are dropped from the
 * environment; nothing else is changed.
 */
export function searchedEnvValueSets(env: Record<string, string | undefined>): {
	secrets: Map<string, string>;
	random: Map<string, string>;
} {
	const secrets = buildSecretEnvValues(env);
	const random = new Map<string, string>();
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || secrets.has(key)) continue;
		// Public by design (`PUBLIC_SENTRY_DSN` carries its key as the URL user, and
		// Astro inlines `PUBLIC_*` into the client on purpose): never a failing secret.
		if (key.startsWith("PUBLIC_") || PUBLIC_KEY_SUFFIX.test(key)) continue;
		if (hasUrlCredentials(value)) secrets.set(key, value);
		else if (isRandomLookingEnvValue(key, value)) random.set(key, value);
	}
	return { secrets, random };
}

/** Both sets of {@link searchedEnvValueSets} as one map, name to value. */
export function buildSearchedEnvValues(
	env: Record<string, string | undefined>,
): Map<string, string> {
	const { secrets, random } = searchedEnvValueSets(env);
	return new Map([...random, ...secrets]);
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
		if (!entry.isFile() || !/\.m?js(\.map)?$/.test(entry.name)) continue;
		const file = path.join(entry.parentPath, entry.name);
		for (const key of inlinedEnvKeys(readFileSync(file, "utf8"))) {
			if (isBuildSecretEnvKey(key)) found.push(`${path.relative(dir, file)}: ${key}`);
		}
	}
	return found;
}

/**
 * Keys Astro's inlined env object may carry without comment: Astro's own build
 * keys, `PUBLIC_*` (Astro's promise that a value is public), and EmDash 1.3.1's
 * documented non-secret build-time configuration, which Astro inlines from a
 * module that reads them whenever they are set at build time (found by grepping
 * emdash's dist for `import.meta.env` reads and for the names its env-object
 * modules look up: `public-url-*`, `trusted-proxy-*`, the OAuth provider and
 * migration and preview modules). EmDash's secrets (`*_SECRET`, `*_KEY`, `*_SALT`)
 * are not here: they are secret-shaped.
 */
const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set([
	"SSR",
	"DEV",
	"PROD",
	"MODE",
	"BASE_URL",
	"SITE",
	"ASSETS_PREFIX",
	// `CI=true` is set by GitHub Actions and Workers Builds alike. Astro inlines it
	// into the app chunk whenever a bare-env module there contains the letters "CI"
	// (its referenced-key scan is a substring match). A boolean flag, never a secret.
	"CI",
	"SITE_URL",
	"EMDASH_SITE_URL",
	"EMDASH_ALLOWED_ORIGINS",
	"EMDASH_TRUSTED_PROXY_HEADERS",
	"EMDASH_MIGRATIONS_MODE",
	"EMDASH_PREVIEW_PATH_PATTERN",
	"EMDASH_OAUTH_GITHUB_CLIENT_ID",
	"EMDASH_OAUTH_GOOGLE_CLIENT_ID",
	"EMDASH_OAUTH_MICROSOFT_CLIENT_ID",
	"EMDASH_OAUTH_MICROSOFT_TENANT_ID",
]);

/**
 * Variables no module reads as configuration, set in every shell or CI job. One
 * of them inlined means a module handed Astro a bare `import.meta.env` and it
 * inlined the build environment wholesale (HOME, PATH and TERM in the case
 * ADR-0045 records).
 */
const WHOLE_ENV_KEYS: ReadonlySet<string> = new Set([
	"PATH",
	"HOME",
	"USER",
	"TERM",
	"SHELL",
	"PWD",
	"HOSTNAME",
]);

/** How the build treats one inlined env key. */
export type InlinedEnvKeyClass = "allowed" | "secret" | "whole-env" | "unknown";

export function classifyInlinedEnvKey(key: string): InlinedEnvKeyClass {
	if (isBuildSecretEnvKey(key)) return "secret";
	if (WHOLE_ENV_KEYS.has(key) || key.startsWith("npm_") || key.startsWith("WORKERS_CI")) {
		return "whole-env";
	}
	if (ALLOWED_ENV_KEYS.has(key) || key.startsWith("PUBLIC_")) return "allowed";
	return "unknown";
}

/** Every `<file>: <KEY>` of each inlined env key under `dir`, by class. Names only. */
export function inlinedEnvKeysByClass(dir: string): Record<InlinedEnvKeyClass, string[]> {
	const found: Record<InlinedEnvKeyClass, string[]> = {
		allowed: [],
		secret: [],
		"whole-env": [],
		unknown: [],
	};
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.m?js(\.map)?$/.test(entry.name)) continue;
		const file = path.join(entry.parentPath, entry.name);
		for (const key of inlinedEnvKeys(readFileSync(file, "utf8"))) {
			found[classifyInlinedEnvKey(key)].push(`${path.relative(dir, file)}: ${key}`);
		}
	}
	return found;
}

/**
 * The inlined keys that FAIL the build: secrets, and the whole-environment
 * markers. An unknown key only warns ({@link inlinedEnvKeysByClass}): a site's
 * own build-time configuration may be legitimately inlined.
 */
export function findInlinedEnvKeysInDir(dir: string): string[] {
	const found = inlinedEnvKeysByClass(dir);
	return [...found.secret, ...found["whole-env"]];
}

/**
 * Values shorter than this are not searched for. A clean server bundle already
 * contains `"postgres"`, `"password"` and `changeme`, so a builder whose shell
 * has `POSTGRES_PASSWORD=postgres` would otherwise fail every build. Real
 * secrets (API keys, OAuth client secrets, generated keys) are far longer, and
 * a short value Astro inlines is still caught by key in its env object
 * ({@link findInlinedSecretsInDir}).
 */
export const MIN_SEARCHED_SECRET_LENGTH = 16;

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

/** The name a leaked `PATH` VALUE is reported under: the second layer behind the key check. */
export const WHOLE_ENV_MARKER = "PATH (build environment variables were inlined into the bundle)";

const RANDOM_HELP =
	"Nothing was deleted and the build continues. If the variable is a secret, remove it from the " +
	"build environment and set it as a Worker secret (`wrangler secret put`). If it is not " +
	"(a release id, a build hash), rename it `PUBLIC_…`: that marks it public and silences this " +
	"warning.";

const LEAK_HELP =
	"Astro writes a variable from the build's env or a .env file into the bundle when its name " +
	"appears in a module that mentions `import.meta.env` other than as `import.meta.env.KEY`, or " +
	"that reads it as `import.meta.env.KEY`. If the name is a secret, remove it from the build " +
	"environment and from the project's .env, set it as a Worker secret (`wrangler secret put`), " +
	"and build again; for `astro dev`, keep local secrets in the project's .dev.vars, which Astro " +
	"never reads. If it is a shell variable no code reads as configuration (HOME, PATH, npm_…), " +
	"some module in the bundle spells the bare `import.meta.env` and the build environment was " +
	"inlined wholesale: find that module (the file is named above). A variable of any name whose " +
	"value holds URL credentials (`scheme://user:pass@host`) counts as a secret too. See " +
	"https://github.com/UrumiAI/otta.sh/blob/main/DEPLOYMENT.md#3-secrets--tokens-checklist.";

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

/**
 * Rewrites every `.mjs`/`.js` file under `dir`, and every `.map` next to one, in place;
 * returns how many changed. A map names its sources as `"<root>/…"` strings, the same
 * anchored form the code uses.
 */
export async function scrubBuildPathsInDir(dir: string, root: string): Promise<number> {
	let changed = 0;
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.m?js(\.map)?$/.test(entry.name)) continue;
		const file = path.join(entry.parentPath, entry.name);
		const code = await readFile(file, "utf8");
		const scrubbed = scrubBuildPaths(code, root);
		if (scrubbed === code) continue;
		await writeFile(file, scrubbed);
		changed += 1;
	}
	return changed;
}

/** @param rootOption the prefix to remove; default {@link workspaceRoot} of the project root. */
export function buildPathScrub(rootOption?: string): AstroIntegration {
	let root = rootOption ?? "";
	let serverDir: URL | undefined;
	let clientDir: URL | undefined;
	let envDir: string | false | undefined;
	let mode = "production";
	// The secrets dropped from the shell, kept (in memory only) to search the
	// bundle for. `undefined` outside a build, where nothing is checked.
	let droppedSecrets: Map<string, string> | undefined;
	// Variables whose value only looks random: a hit warns, never fails.
	let randomValues = new Map<string, string>();
	return {
		name: BUILD_PATH_SCRUB_INTEGRATION,
		hooks: {
			"astro:config:setup": ({ command, config, logger, updateConfig }) => {
				if (rootOption === undefined) root = workspaceRoot(fileURLToPath(config.root));
				if (command !== "build") return;
				dropShellPathEnv(process.env);
				const searched = searchedEnvValueSets(process.env);
				droppedSecrets = searched.secrets;
				randomValues = searched.random;
				const dropped = dropBuildSecretEnv(process.env);
				if (dropped.length > 0) {
					logger.warn(
						`ignored ${dropped.length} secret(s) set in the build environment, so none can be ` +
							`inlined into the worker: ${dropped.toSorted().join(", ")}. Set secrets as Worker ` +
							`secrets (\`wrangler secret put\`), never in the build shell (Otta's DEPLOYMENT.md §3: https://github.com/UrumiAI/otta.sh/blob/main/DEPLOYMENT.md).`,
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
				clientDir = config.build.client;
			},
			"astro:build:done": async ({ logger }) => {
				if (serverDir === undefined || !existsSync(serverDir)) return;
				const server = fileURLToPath(serverDir);
				rmSync(path.join(server, ".dev.vars"), { force: true });
				if (droppedSecrets !== undefined) {
					const secrets = new Map(droppedSecrets);
					const random = new Map(randomValues);
					if (envDir !== undefined) {
						const fromFiles = searchedEnvValueSets(viteLoadEnv(mode, envDir, ""));
						for (const [key, value] of fromFiles.secrets) secrets.set(key, value);
						for (const [key, value] of fromFiles.random) {
							if (!secrets.has(key)) random.set(key, value);
						}
					}
					// Not a secret, but no module reads PATH: its VALUE in the bundle means
					// build variables were inlined, however minified (the key check above is
					// the first layer; this one does not depend on the object's shape).
					if (process.env.PATH !== undefined) {
						secrets.set(WHOLE_ENV_MARKER, process.env.PATH);
					}
					// A prerendered page renders on the server but is written to the CLIENT
					// output, which is uploaded as public static assets: search it too.
					const client =
						clientDir !== undefined && existsSync(clientDir) ? fileURLToPath(clientDir) : undefined;
					// A key that is neither a secret, a shell marker nor known config may be the
					// site's own build-time setting: say so, do not fail.
					const unknown = inlinedEnvKeysByClass(server).unknown;
					if (unknown.length > 0) {
						logger.warn(
							`build variables were inlined into the worker by name (values not shown): ` +
								`${unknown.toSorted().join(", ")}. Fine if they are your own non-secret build ` +
								`settings; if one is a secret, make it a Worker secret instead.`,
						);
					}
					const serverLeaks = [
						...new Set([
							...findInlinedEnvKeysInDir(server),
							...findLeakedSecretValuesInDir(server, secrets),
						]),
					];
					const clientLeaks =
						client === undefined
							? []
							: findLeakedSecretValuesInDir(client, secrets).map((leak) => `client/${leak}`);
					const leaks = [...serverLeaks, ...clientLeaks];
					// A random-looking value under a name that is not secret-shaped only warns:
					// a release id or a build hash is not a secret. Names only, never a value.
					const randomHits = [
						...findLeakedSecretValuesInDir(server, random),
						...(client === undefined
							? []
							: findLeakedSecretValuesInDir(client, random).map((leak) => `client/${leak}`)),
					].filter((hit) => !leaks.includes(hit));
					if (randomHits.length > 0) {
						logger.warn(
							`a random-looking value was found in the build output (values not shown):\n  ` +
								`${randomHits
									.toSorted()
									.map((hit) => `${hit} (random-looking value)`)
									.join("\n  ")}\n${RANDOM_HELP}`,
						);
					}
					if (leaks.length > 0) {
						// Without the server output there is nothing for `wrangler deploy` to
						// ship. A client hit is public HTML or JS, so that output goes as well.
						const deleted =
							clientLeaks.length > 0 && client !== undefined ? [server, client] : [server];
						for (const dir of deleted) rmSync(dir, { recursive: true, force: true });
						throw new Error(
							`a secret was written into the build output (issue #584), so ${deleted.join(" and ")} ` +
								`${deleted.length === 1 ? "was" : "were"} deleted:\n  ${leaks.toSorted().join("\n  ")}\n${LEAK_HELP}`,
						);
					}
				}
				// Set in astro:config:setup, which always runs first; an empty root
				// would match every quoted absolute path, so never scrub without one.
				if (root === "") throw new Error("build-path-scrub: no root was resolved");
				const changed = await scrubBuildPathsInDir(server, root);
				logger.info(`removed the workspace root from ${changed} server file(s)`);
			},
		},
	};
}
