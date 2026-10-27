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
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * Every `<root>/` becomes `/`. The trailing slash is part of the match, so a
 * sibling such as `<root>-other/` is left alone.
 */
export function scrubBuildPaths(code: string, root: string): string {
	const prefix = `${root.replace(/\/+$/, "")}/`;
	return code.split(prefix).join("/");
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
	return {
		name: BUILD_PATH_SCRUB_INTEGRATION,
		hooks: {
			"astro:config:done": ({ config }) => {
				serverDir = config.build.server;
			},
			"astro:build:done": async ({ logger }) => {
				if (serverDir === undefined || !existsSync(serverDir)) return;
				const changed = await scrubBuildPathsInDir(fileURLToPath(serverDir), root);
				logger.info(`removed the workspace root from ${changed} server file(s)`);
			},
		},
	};
}
