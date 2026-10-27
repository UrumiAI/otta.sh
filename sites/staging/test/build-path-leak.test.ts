/**
 * Issue #121: the production build must not carry the builder's absolute
 * filesystem paths. Astro's compiler embeds every `.astro` file's absolute path
 * (the `createComponent(…, "/home/…/X.astro")` id and `$$file`), and the
 * serialized SSR manifest carries `rootDir`/`srcDir`/… as `file:///home/…` URLs
 * plus `entryModules`/`componentMetadata` keyed by absolute module ids. All of
 * it shipped to Cloudflare in the worker bundle.
 *
 * Three layers: the scrub itself, the configs that wire it, and a scan of the
 * real `dist/`. The scan needs a build; CI runs `pnpm -r build` before
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
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	BUILD_PATH_SCRUB_INTEGRATION,
	buildPathScrub,
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
});

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

	test("the scrub runs only on astro:build:done (dev is untouched)", () => {
		const hooks = Object.keys(buildPathScrub("/r").hooks);
		expect(hooks.toSorted()).toEqual(["astro:build:done", "astro:config:done"]);
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

describe.runIf(existsSync(dist) || process.env.CI !== undefined)("the built site (dist/)", () => {
	test("contains no absolute path from the build machine", () => {
		expect(existsSync(dist), "no sites/staging/dist — run `pnpm -r build` first").toBe(true);
		const needles = [`${workspaceRoot()}/`, `${homedir()}/`];
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
		expect(leaks).toEqual([]);
	});
});
