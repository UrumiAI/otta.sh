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
	buildPathScrub,
	dropShellPathEnv,
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

/** Runs the scrub integration's `astro:config:setup` hook for `command`. */
function runConfigSetup(command: string): void {
	const hook = buildPathScrub("/r").hooks["astro:config:setup"] as (o: { command: string }) => void;
	hook({ command });
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

	describe("astro:config:setup drops the shell's path variables for a build only", () => {
		const saved = { _: process.env._, EDITOR: process.env.EDITOR };
		afterEach(() => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		});

		test("build: removed before Astro reads the env", () => {
			process.env._ = "/home/x/.bin/pnpm";
			process.env.EDITOR = "/home/x/vim";
			runConfigSetup("build");
			expect(process.env._).toBeUndefined();
			expect(process.env.EDITOR).toBeUndefined();
		});

		test("dev: untouched (open-in-editor still reads EDITOR)", () => {
			process.env._ = "/home/x/.bin/pnpm";
			process.env.EDITOR = "/home/x/vim";
			runConfigSetup("dev");
			expect(process.env._).toBe("/home/x/.bin/pnpm");
			expect(process.env.EDITOR).toBe("/home/x/vim");
		});
	});
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

/**
 * Astro inlines private env into a server module that uses a bare
 * `import.meta.env` as `Object.assign({ …, "SSR": true }, { KEY: "value", … })`.
 * Returns the keys of every such inlined object in `code`.
 */
function inlinedEnvKeys(code: string): string[] {
	const keys: string[] = [];
	for (const match of code.matchAll(/"SSR": (?:true|false)\s*\}, (\{[^{}]*\})\)/g)) {
		for (const key of match[1]?.matchAll(/(?:^|[{,\s])"?([A-Za-z_$][\w$]*)"?\s*:/g) ?? []) {
			if (key[1] !== undefined) keys.push(key[1]);
		}
	}
	return keys;
}

describe("inlinedEnvKeys", () => {
	test("reads the keys of Astro's inlined env object", () => {
		const code = `(Object.assign({\n\t"BASE_URL": "/",\n\t"SSR": true\n}, {\n\tCI: "true",\n\t_: "/home/runner/pnpm"\n})?.PROD)`;
		expect(inlinedEnvKeys(code)).toEqual(["CI", "_"]);
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
});
