/**
 * Issue #121: the production build must not carry the builder's absolute
 * filesystem paths. Astro's compiler embeds every `.astro` file's absolute path
 * (the `createComponent(…, "/home/…/X.astro")` id and `$$file`), and the
 * serialized SSR manifest carries `rootDir`/`srcDir`/… as `file:///home/…` URLs
 * plus `entryModules`/`componentMetadata` keyed by absolute module ids. All of
 * it shipped to Cloudflare in the worker bundle.
 *
 * Shell variables leaked the same way: Astro inlined `_` (the pnpm binary's path)
 * and other variables into server chunks (see src/lib/build-path-scrub.ts).
 * Issue #584: so did SECRETS exported in the build shell. emdash's OAuth routes
 * name `GITHUB_CLIENT_SECRET` & co. next to a bare `import.meta.env`, so their
 * values were written in plain text into `_provider_*.mjs` and `callback_*.mjs`.
 *
 * Three layers: the scrub and env strip themselves, the configs that wire them,
 * and a scan of the real `dist/`. The scan needs a build; CI runs `pnpm -r build` before
 * `pnpm test` in the same job, so there it is REQUIRED (a missing `dist/` fails
 * rather than skips). Locally it runs whenever a build is present.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
	BUILD_PATH_SCRUB_INTEGRATION,
	BUILD_SECRET_ENV_KEYS,
	buildPathScrub,
	dropBuildSecretEnv,
	dropShellPathEnv,
	findInlinedSecretsInDir,
	findLeakedSecretValuesInDir,
	MIN_SEARCHED_SECRET_LENGTH,
	inlinedEnvKeys,
	isBuildSecretEnvKey,
	SHELL_PATH_ENV_KEYS,
	scrubBuildPaths,
	scrubBuildPathsInDir,
	workspaceRoot,
} from "../src/lib/build-path-scrub.js";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(siteRoot, "dist");

describe("scrubBuildPaths", () => {
	const root = "/home/builder/otta";

	test("relativizes a createComponent id and $$file to the workspace root", () => {
		const code = [
			`const $$Sum = createComponent(($$result) => {}, "${root}/sites/staging/src/components/Sum.astro", void 0);`,
			`var $$file = "${root}/sites/staging/src/pages/index.astro";`,
		].join("\n");
		expect(scrubBuildPaths(code, root)).toBe(
			[
				`const $$Sum = createComponent(($$result) => {}, "/sites/staging/src/components/Sum.astro", void 0);`,
				`var $$file = "/sites/staging/src/pages/index.astro";`,
			].join("\n"),
		);
	});

	test("keeps a manifest file:// URL a valid URL", () => {
		const out = scrubBuildPaths(`{"rootDir":"file://${root}/sites/staging/"}`, root);
		expect(out).toBe(`{"rootDir":"file:///sites/staging/"}`);
		expect(new URL(JSON.parse(out).rootDir).pathname).toBe("/sites/staging/");
	});

	test("rewrites every occurrence the same way, so ids used as map keys still match", () => {
		const id = `${root}/node_modules/.pnpm/emdash@1.3.1/node_modules/emdash/src/astro/routes/admin.astro`;
		const out = scrubBuildPaths(`m.set("${id}", 1); createComponent(f, "${id}");`, root);
		const ids = [...out.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
		expect(ids).toEqual([
			"/node_modules/.pnpm/emdash@1.3.1/node_modules/emdash/src/astro/routes/admin.astro",
			"/node_modules/.pnpm/emdash@1.3.1/node_modules/emdash/src/astro/routes/admin.astro",
		]);
	});

	test("does not touch a sibling directory that merely shares the prefix", () => {
		const code = `"${root}-other/x.astro"`;
		expect(scrubBuildPaths(code, root)).toBe(code);
	});

	test("accepts a root given with a trailing slash", () => {
		expect(scrubBuildPaths(`"${root}/a.astro"`, `${root}/`)).toBe(`"/a.astro"`);
	});

	test.each([
		["a double-quoted literal", `"${root}/x.astro"`, `"/x.astro"`],
		["a single-quoted literal", `'${root}/x.astro'`, `'/x.astro'`],
		["a template literal", `\`${root}/x.astro\``, `\`/x.astro\``],
		["a file:// URL", `"file://${root}/x/"`, `"file:///x/"`],
	])("removes the root where it starts %s", (_form, code, expected) => {
		expect(scrubBuildPaths(code, root)).toBe(expected);
	});

	test("removes a percent-encoded root from a file URL (spaces, non-ASCII)", () => {
		const spaced = "/home/b/my otta é";
		const href = pathToFileURL(spaced).href;
		expect(href).toContain("%20");
		expect(scrubBuildPaths(`"${href}/sites/staging/"`, spaced)).toBe(`"file:///sites/staging/"`);
	});

	test("leaves the root alone where it does not start a path", () => {
		const code = `"see ${root}/x.astro"`;
		expect(scrubBuildPaths(code, root)).toBe(code);
	});

	describe("a short root (a Docker WORKDIR such as /otta)", () => {
		test("does not corrupt a real literal that contains it", () => {
			for (const literal of [
				`"/_emdash/api/plugins/otta/admin"`,
				`'/_emdash/api/plugins/otta/admin'`,
				`fetch(\`/_emdash/api/plugins/otta/admin\`)`,
				`"file:///srv/otta/x"`,
			]) {
				expect(scrubBuildPaths(literal, "/otta")).toBe(literal);
			}
		});

		test("still removes it where it starts a path", () => {
			expect(scrubBuildPaths(`"/otta/sites/staging/src/X.astro"`, "/otta")).toBe(
				`"/sites/staging/src/X.astro"`,
			);
			expect(scrubBuildPaths(`"file:///otta/sites/staging/"`, "/otta")).toBe(
				`"file:///sites/staging/"`,
			);
		});
	});
});

describe("dropShellPathEnv", () => {
	test("removes the shell's path variables and nothing else", () => {
		const env: NodeJS.ProcessEnv = {
			_: "/home/x/.bin/pnpm",
			PWD: "/home/x/otta",
			OLDPWD: "/home/x",
			NODE: "/home/x/node",
			EDITOR: "/home/x/vim",
			VISUAL: "/home/x/vim",
			CI: "true",
			NODE_ENV: "production",
			PATH: "/usr/bin",
			OTTA_EXTRA_ALLOWED_HOSTS: "api.example.com",
		};
		dropShellPathEnv(env);
		expect(env).toEqual({
			CI: "true",
			NODE_ENV: "production",
			PATH: "/usr/bin",
			OTTA_EXTRA_ALLOWED_HOSTS: "api.example.com",
		});
		expect(Object.keys(env)).not.toEqual(expect.arrayContaining([...SHELL_PATH_ENV_KEYS]));
	});
});

interface HookRun {
	warnings: string[];
	/** The error `astro:build:done` threw, as text, or undefined. */
	failure?: string;
}

/**
 * Runs one integration instance through a build's hooks in Astro's order:
 * `astro:config:setup` (project root `projectRoot` and optional `vite.envDir`,
 * which decide where Astro's `.env` lookup happens), the Vite plugin it injects
 * (`configResolved` with `mode`, default "production"), `astro:config:done`
 * (server and client output dirs) and, when `serverDir` is given,
 * `astro:build:done`.
 */
async function runHooks(
	command: string,
	{
		projectRoot = "/nonexistent-otta-root",
		envDir,
		mode = "production",
		serverDir,
		clientDir = "/nonexistent-otta-client",
	}: {
		projectRoot?: string;
		envDir?: string;
		mode?: string;
		serverDir?: string;
		clientDir?: string;
	} = {},
): Promise<HookRun> {
	const run: HookRun = { warnings: [] };
	const logger = {
		info: () => {},
		warn: (message: string) => {
			run.warnings.push(message);
		},
	};
	const plugins: { configResolved?: (c: { mode: string }) => void }[] = [];
	const integration = buildPathScrub("/r");
	const hook = (name: string) =>
		integration.hooks[name as "astro:config:setup"] as (o: unknown) => unknown;
	await hook("astro:config:setup")({
		command,
		logger,
		config: {
			root: pathToFileURL(`${projectRoot}/`),
			vite: envDir === undefined ? {} : { envDir },
		},
		updateConfig: (update: { vite?: { plugins?: typeof plugins } }) => {
			plugins.push(...(update.vite?.plugins ?? []));
		},
	});
	for (const plugin of plugins) plugin.configResolved?.({ mode });
	if (serverDir === undefined) return run;
	await hook("astro:config:done")({
		config: {
			build: {
				server: pathToFileURL(`${serverDir}/`),
				client: pathToFileURL(`${clientDir}/`),
			},
		},
	});
	try {
		await hook("astro:build:done")({ logger });
	} catch (error) {
		run.failure = String(error);
	}
	return run;
}

/** A server chunk with Astro's inlined env object around `body`. */
function withInlinedEnv(body: string): string {
	return `x(Object.assign({\n\t"SSR": true\n}, {\n${body}\n}));`;
}

/** A fresh temp dir, removed after `use`. */
async function withTempDir(use: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(path.join(tmpdir(), "otta-584-"));
	try {
		await use(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("astro config wiring", () => {
	test("workspaceRoot is the repo root (it holds pnpm-workspace.yaml)", () => {
		expect(existsSync(path.join(workspaceRoot(), "pnpm-workspace.yaml"))).toBe(true);
		expect(path.resolve(siteRoot, "../..")).toBe(workspaceRoot());
	});

	test.each([
		["astro.config.ts", "../astro.config.js"],
		["astro.config.playground.ts", "../astro.config.playground.js"],
	])("%s registers the scrub integration", async (_name, specifier) => {
		const config = (await import(specifier)).default as { integrations?: unknown[] };
		const names = (config.integrations ?? []).flat().map((i) => (i as { name?: string })?.name);
		expect(names).toContain(BUILD_PATH_SCRUB_INTEGRATION);
	});

	test("the scrub hooks setup, config:done and build:done only", () => {
		const hooks = Object.keys(buildPathScrub("/r").hooks);
		expect(hooks.toSorted()).toEqual([
			"astro:build:done",
			"astro:config:done",
			"astro:config:setup",
		]);
	});

	describe("astro:config:setup drops the shell's path variables and secrets for a build only", () => {
		// The hook deletes the path variables AND every secret-shaped variable the
		// test process has, so the whole environment is put back.
		const saved = { ...process.env };
		afterEach(() => {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		});

		test("build: removed before Astro reads the env", async () => {
			process.env._ = "/home/x/.bin/pnpm";
			process.env.EDITOR = "/home/x/vim";
			await runHooks("build");
			expect(process.env._).toBeUndefined();
			expect(process.env.EDITOR).toBeUndefined();
		});

		test("build: the build shell's secrets are removed before Astro reads the env (#584)", async () => {
			process.env.GITHUB_CLIENT_SECRET = "OTTA_TEST_MARKER";
			process.env.EMDASH_ENCRYPTION_KEY = "OTTA_TEST_MARKER";
			const { warnings } = await runHooks("build");
			expect(process.env.GITHUB_CLIENT_SECRET).toBeUndefined();
			expect(process.env.EMDASH_ENCRYPTION_KEY).toBeUndefined();
			// The warning names the variables and never prints a value.
			expect(warnings.join("\n")).toContain("GITHUB_CLIENT_SECRET");
			expect(warnings.join("\n")).not.toContain("OTTA_TEST_MARKER");
		});

		test("dev: untouched (open-in-editor still reads EDITOR)", async () => {
			process.env._ = "/home/x/.bin/pnpm";
			process.env.EDITOR = "/home/x/vim";
			process.env.GITHUB_CLIENT_SECRET = "OTTA_TEST_MARKER";
			await runHooks("dev");
			expect(process.env.GITHUB_CLIENT_SECRET).toBe("OTTA_TEST_MARKER");
			expect(process.env._).toBe("/home/x/.bin/pnpm");
			expect(process.env.EDITOR).toBe("/home/x/vim");
		});
	});
});

describe("astro:build:done fails the build on a leaked secret (#584)", () => {
	const saved = { ...process.env };
	afterEach(() => {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	});

	const MARKER = "OTTA_TEST_MARKER_584_VALUE";

	test("Astro's inlined env object: throws naming chunk + key, never the value, and deletes the bundle", () =>
		withTempDir(async (dir) => {
			const server = path.join(dir, "server");
			mkdirSync(server);
			writeFileSync(
				path.join(server, "callback_X.mjs"),
				withInlinedEnv(`\tGITHUB_CLIENT_SECRET: "x"`),
			);
			const { failure } = await runHooks("build", { serverDir: server });
			expect(failure).toContain("callback_X.mjs: GITHUB_CLIENT_SECRET");
			expect(existsSync(server), "a leaked bundle must not survive to be deployed").toBe(false);
		}));

	test("a dotted `import.meta.env.KEY` define (a plain literal, no env object) from the shell", () =>
		withTempDir(async (dir) => {
			const server = path.join(dir, "server");
			mkdirSync(server);
			// What Astro's `import.meta.env.GITHUB_CLIENT_SECRET` define leaves behind.
			writeFileSync(
				path.join(server, "chunk.mjs"),
				`const secret = "${MARKER}";\nexport { secret };`,
			);
			const client = path.join(dir, "client");
			mkdirSync(client);
			writeFileSync(path.join(client, "index.html"), "<p>clean</p>");
			process.env.GITHUB_CLIENT_SECRET = MARKER;
			const { failure } = await runHooks("build", { serverDir: server, clientDir: client });
			expect(failure).toContain("chunk.mjs: GITHUB_CLIENT_SECRET");
			expect(failure).not.toContain(MARKER);
			expect(existsSync(server)).toBe(false);
			// A server-only leak leaves the (clean) client output alone.
			expect(existsSync(client)).toBe(true);
		}));

	test("a value from the project's .env file (never in process.env), JSON-escaped in the chunk", () =>
		withTempDir(async (dir) => {
			const server = path.join(dir, "dist", "server");
			mkdirSync(server, { recursive: true });
			const value = `${MARKER}"quoted\\slash`;
			writeFileSync(path.join(dir, ".env"), `STRIPE_SECRET_KEY='${value}'\n`);
			writeFileSync(path.join(server, "chunk.mjs"), `const k = ${JSON.stringify(value)};`);
			const { failure } = await runHooks("build", { projectRoot: dir, serverDir: server });
			expect(failure).toContain("chunk.mjs: STRIPE_SECRET_KEY");
			expect(failure).not.toContain(MARKER);
		}));

	test.each([
		[".env.production.local", "production"],
		[".env.staging", "staging"],
	])(
		"a value only in %s (mode %s) fails the build: the mode reaches the .env lookup",
		(file, mode) =>
			withTempDir(async (dir) => {
				const server = path.join(dir, "dist", "server");
				mkdirSync(server, { recursive: true });
				writeFileSync(path.join(dir, file), `GITHUB_CLIENT_SECRET=${MARKER}\n`);
				writeFileSync(path.join(server, "chunk.mjs"), `const s = "${MARKER}";`);
				const { failure } = await runHooks("build", { projectRoot: dir, mode, serverDir: server });
				expect(failure).toContain("chunk.mjs: GITHUB_CLIENT_SECRET");
				expect(existsSync(server)).toBe(false);
			}),
	);

	test("a value in the .env under `vite.envDir` (not the project root) fails the build", () =>
		withTempDir(async (dir) => {
			const envDir = path.join(dir, "env-files");
			const server = path.join(dir, "dist", "server");
			mkdirSync(envDir);
			mkdirSync(server, { recursive: true });
			writeFileSync(path.join(envDir, ".env"), `STRIPE_SECRET_KEY=${MARKER}\n`);
			writeFileSync(path.join(server, "chunk.mjs"), `const s = "${MARKER}";`);
			const { failure } = await runHooks("build", { projectRoot: dir, envDir, serverDir: server });
			expect(failure).toContain("chunk.mjs: STRIPE_SECRET_KEY");
		}));

	test("a common short value under a secret name does not fail, even where the bundle has it", () =>
		withTempDir(async (dir) => {
			const server = path.join(dir, "dist", "server");
			mkdirSync(server, { recursive: true });
			// A clean bundle really contains "postgres", "password" and "changeme".
			writeFileSync(path.join(dir, ".env"), "DB_PASSWORD=password\nSMTP_PASS=changeme\n");
			writeFileSync(
				path.join(server, "chunk.mjs"),
				`const kinds = ["postgres", "password", "changeme"];`,
			);
			process.env.POSTGRES_PASSWORD = "postgres";
			const { failure } = await runHooks("build", { projectRoot: dir, serverDir: server });
			expect(failure).toBeUndefined();
			expect(existsSync(path.join(server, "chunk.mjs"))).toBe(true);
		}));

	test("a value in the CLIENT output (a prerendered page) fails the build and deletes both outputs", () =>
		withTempDir(async (dir) => {
			const server = path.join(dir, "dist", "server");
			const client = path.join(dir, "dist", "client");
			mkdirSync(server, { recursive: true });
			mkdirSync(path.join(client, "about"), { recursive: true });
			writeFileSync(path.join(server, "entry.mjs"), "export {};");
			writeFileSync(path.join(client, "about", "index.html"), `<p>${MARKER}</p>`);
			process.env.GITHUB_CLIENT_SECRET = MARKER;
			const { failure } = await runHooks("build", { serverDir: server, clientDir: client });
			expect(failure).toContain(`client/${path.join("about", "index.html")}: GITHUB_CLIENT_SECRET`);
			expect(failure).not.toContain(MARKER);
			expect(existsSync(server)).toBe(false);
			expect(existsSync(client)).toBe(false);
		}));

	test("deletes dist/server/.dev.vars, the plaintext copy of the local dev secrets", () =>
		withTempDir(async (dir) => {
			const server = path.join(dir, "server");
			mkdirSync(server);
			writeFileSync(path.join(server, ".dev.vars"), `EMDASH_ENCRYPTION_KEY=${MARKER}\n`);
			writeFileSync(path.join(server, "entry.mjs"), "export {};");
			const { failure } = await runHooks("build", { serverDir: server });
			expect(failure).toBeUndefined();
			expect(existsSync(path.join(server, ".dev.vars"))).toBe(false);
			expect(existsSync(path.join(server, "entry.mjs"))).toBe(true);
		}));

	test("passes a server bundle with no secret in it", () =>
		withTempDir(async (dir) => {
			writeFileSync(path.join(dir, "ok.mjs"), withInlinedEnv(`\tCI: "1"`));
			process.env.GITHUB_CLIENT_SECRET = MARKER;
			const { failure } = await runHooks("build", { serverDir: dir });
			expect(failure).toBeUndefined();
			expect(existsSync(path.join(dir, "ok.mjs"))).toBe(true);
		}));
});

describe("findLeakedSecretValuesInDir", () => {
	test("finds raw and JSON-escaped values in any file, by key; skips values under 16 chars", () =>
		withTempDir((dir) => {
			mkdirSync(path.join(dir, "chunks"));
			const escaped = 'abc"def\\ghi-long';
			writeFileSync(path.join(dir, "chunks", "a.mjs"), "x = 'raw-secret-value-1';");
			writeFileSync(path.join(dir, "b.json"), JSON.stringify({ v: escaped }));
			writeFileSync(path.join(dir, "c.mjs"), "short x=123456789012345");
			const secrets = new Map([
				["RAW_SECRET", "raw-secret-value-1"],
				["ESCAPED_TOKEN", escaped],
				["SHORT_SECRET", "123456789012345"],
			]);
			expect(MIN_SEARCHED_SECRET_LENGTH).toBe(16);
			expect(findLeakedSecretValuesInDir(dir, secrets).toSorted()).toEqual([
				"b.json: ESCAPED_TOKEN",
				`${path.join("chunks", "a.mjs")}: RAW_SECRET`,
			]);
		}));
});

describe("scrubBuildPathsInDir", () => {
	test("rewrites .mjs/.js under the dir and leaves other files alone", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "otta-scrub-"));
		const root = "/home/builder/otta";
		try {
			mkdirSync(path.join(dir, "chunks"));
			writeFileSync(path.join(dir, "entry.mjs"), `import "${root}/a.mjs";`);
			writeFileSync(path.join(dir, "chunks", "x.js"), `createComponent(f, "${root}/X.astro");`);
			writeFileSync(path.join(dir, "chunks", "clean.mjs"), "export {};");
			writeFileSync(path.join(dir, "wrangler.json"), `{"configPath":"${root}/wrangler.jsonc"}`);
			expect(await scrubBuildPathsInDir(dir, root)).toBe(2);
			expect(readFileSync(path.join(dir, "entry.mjs"), "utf8")).toBe(`import "/a.mjs";`);
			expect(readFileSync(path.join(dir, "chunks", "x.js"), "utf8")).toBe(
				`createComponent(f, "/X.astro");`,
			);
			expect(readFileSync(path.join(dir, "wrangler.json"), "utf8")).toContain(root);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * `dist/server/wrangler.json` is the redirected deploy config the Cloudflare
 * Vite plugin writes for `wrangler deploy` to read ON THIS MACHINE. It is not
 * uploaded, and wrangler records where the source config lives in these two
 * keys. Everything else in the file is still scanned.
 */
const WRANGLER_LOCAL_KEYS = ["configPath", "userConfigPath"] as const;

function shippedText(file: string): string {
	const text = readFileSync(file, "utf8");
	if (path.relative(dist, file) !== path.join("server", "wrangler.json")) return text;
	const json = JSON.parse(text) as Record<string, unknown>;
	for (const key of WRANGLER_LOCAL_KEYS) delete json[key];
	return JSON.stringify(json);
}

/**
 * The leak needles: the workspace root (with no trailing slash, so no form of it
 * slips past), its percent-encoded file URL, and the home directory. The home
 * directory catches paths that are not under the checkout (CI's `_` pointed at
 * `/home/runner/setup-pnpm/…`). It is skipped when it is `/` (a container user
 * with no home), where it would match everything.
 */
function leakNeedles(): string[] {
	const root = workspaceRoot();
	const needles = [root, pathToFileURL(root).href];
	if (homedir().length > 1) needles.push(`${homedir()}/`);
	return [...new Set(needles)];
}

describe("inlinedEnvKeys", () => {
	test("reads the keys of Astro's inlined env object", () => {
		const code = `(Object.assign({\n\t"BASE_URL": "/",\n\t"SSR": true\n}, {\n\tCI: "true",\n\t_: "/home/runner/pnpm"\n})?.PROD)`;
		expect(inlinedEnvKeys(code)).toEqual(["CI", "_"]);
	});

	test("reads every key when a value contains braces, quotes or commas", () => {
		const code = `Object.assign({\n\t"SSR": true\n}, {\n\tA: "x}{,\\"y: 1",\n\tGITHUB_CLIENT_SECRET: "s"\n})`;
		expect(inlinedEnvKeys(code)).toEqual(["A", "GITHUB_CLIENT_SECRET"]);
	});
});

describe("isBuildSecretEnvKey", () => {
	test.each([...BUILD_SECRET_ENV_KEYS])("names %s a secret", (key) => {
		expect(isBuildSecretEnvKey(key)).toBe(true);
	});

	test.each([
		"EMDASH_OAUTH_GITHUB_CLIENT_SECRET",
		"GITHUB_CLIENT_SECRET",
		"EMDASH_OAUTH_GOOGLE_CLIENT_SECRET",
		"GOOGLE_CLIENT_SECRET",
		"STRIPE_SECRET_KEY",
		"STRIPE_WEBHOOK_SECRET",
		"EMDASH_AUTH_SECRET",
		"EMDASH_ENCRYPTION_KEY",
		"AUTH_SECRET",
		"EMDASH_PREVIEW_SECRET",
		"EMDASH_IP_SALT",
	])("lists %s explicitly (issue #584)", (key) => {
		expect(BUILD_SECRET_ENV_KEYS).toContain(key);
	});

	test.each([
		"SOME_FUTURE_SECRET",
		"ACME_API_TOKEN",
		"DB_PASSWORD",
		"VENDOR_API_KEY",
		"AWS_SECRET_ACCESS_KEY",
		"SIGNING_PRIVATE_KEY",
		"vendor_secret",
		"LICENSE_KEY",
		"KEY",
		"SMTP_PASS",
		"SENTRY_DSN",
		"PG_CONNECTION_STRING",
		"POSTGRES_URL",
		"PREVIEW_SECRET",
	])("names %s a secret by its shape", (key) => {
		expect(isBuildSecretEnvKey(key)).toBe(true);
	});

	test.each([
		"CI",
		"NODE_ENV",
		"PATH",
		"HOME",
		"OTTA_EXTRA_ALLOWED_HOSTS",
		"GITHUB_CLIENT_ID",
		"EMDASH_SITE_URL",
		"PUBLIC_STRIPE_TOKEN",
		"TOKENIZER_MODE",
		"KEYBOARD",
		"TURNSTILE_SITE_KEY",
		"EMDASH_TURNSTILE_SITE_KEY",
		"STRIPE_PUBLISHABLE_KEY",
		"STRIPE_PUBLIC_KEY",
		"PUBLIC_API_KEY",
		"PASSTHROUGH",
	])("leaves %s alone", (key) => {
		expect(isBuildSecretEnvKey(key)).toBe(false);
	});
});

describe("dropBuildSecretEnv", () => {
	test("removes the secrets, keeps everything else, and returns the names it removed", () => {
		const env: NodeJS.ProcessEnv = {
			GITHUB_CLIENT_SECRET: "x",
			EMDASH_ENCRYPTION_KEY: "x",
			ACME_API_TOKEN: "x",
			GITHUB_CLIENT_ID: "public",
			CI: "true",
			PATH: "/usr/bin",
		};
		expect(dropBuildSecretEnv(env).toSorted()).toEqual([
			"ACME_API_TOKEN",
			"EMDASH_ENCRYPTION_KEY",
			"GITHUB_CLIENT_SECRET",
		]);
		expect(env).toEqual({ GITHUB_CLIENT_ID: "public", CI: "true", PATH: "/usr/bin" });
	});
});

describe("findInlinedSecretsInDir", () => {
	test("reports each server chunk that carries an inlined secret, by key name only", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "otta-secret-"));
		try {
			mkdirSync(path.join(dir, "chunks"));
			writeFileSync(
				path.join(dir, "chunks", "callback_X.mjs"),
				withInlinedEnv(`\tGITHUB_CLIENT_SECRET: "MARKER",\n\tCI: "true"`),
			);
			writeFileSync(path.join(dir, "chunks", "clean.mjs"), withInlinedEnv(`\tCI: "true"`));
			writeFileSync(path.join(dir, "notes.txt"), withInlinedEnv(`\tSTRIPE_SECRET_KEY: "MARKER"`));
			const found = findInlinedSecretsInDir(dir);
			expect(found).toEqual([`${path.join("chunks", "callback_X.mjs")}: GITHUB_CLIENT_SECRET`]);
			expect(found.join("\n")).not.toContain("MARKER");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const rebuildHint = "dist/ may predate the scrub — rebuild with `pnpm -C sites/staging build`";

describe.runIf(existsSync(dist) || process.env.CI !== undefined)("the built site (dist/)", () => {
	test("contains no absolute path from the build machine", () => {
		expect(existsSync(dist), "no sites/staging/dist — run `pnpm -r build` first").toBe(true);
		const needles = leakNeedles();
		const leaks: string[] = [];
		for (const file of filesUnder(dist)) {
			const text = shippedText(file);
			for (const needle of needles) {
				const at = text.indexOf(needle);
				if (at === -1) continue;
				leaks.push(`${path.relative(dist, file)}: …${text.slice(Math.max(0, at - 40), at + 80)}…`);
				break;
			}
		}
		expect(leaks, rebuildHint).toEqual([]);
	});

	test("inlines none of the shell's path variables into a server chunk", () => {
		expect(existsSync(dist), "no sites/staging/dist — run `pnpm -r build` first").toBe(true);
		const banned = new Set<string>(SHELL_PATH_ENV_KEYS);
		const inlined: string[] = [];
		for (const file of filesUnder(path.join(dist, "server"))) {
			if (!/\.m?js$/.test(file)) continue;
			for (const key of inlinedEnvKeys(readFileSync(file, "utf8"))) {
				if (banned.has(key)) inlined.push(`${path.relative(dist, file)}: ${key}`);
			}
		}
		expect(inlined, rebuildHint).toEqual([]);
	});

	test("inlines no secret into a server chunk (#584)", () => {
		expect(existsSync(dist), "no sites/staging/dist — run `pnpm -r build` first").toBe(true);
		expect(findInlinedSecretsInDir(path.join(dist, "server")), rebuildHint).toEqual([]);
	});
});
