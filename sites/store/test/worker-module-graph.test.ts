import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * The modules the built Worker loads must not touch `import.meta.url` (#732).
 *
 * In the bundled Worker `import.meta.url` is undefined, so a module that
 * resolves a path from it at load time (`new URL("…", import.meta.url)`)
 * throws `TypeError: Invalid URL string` before any request is served, and
 * every request answers 500. `astro dev` runs the same modules under Vite,
 * where `import.meta.url` is a real file URL, so the dev server and the e2e
 * suite never see it.
 *
 * #676 let it in through `src/lib/playground-commerce.ts`, which imported its
 * helpers from `scripts/seed-demo-commerce.ts`, which imports
 * `scripts/setup-claim-cookie.ts`, whose `DEV_VARS_PATH` is resolved from
 * `import.meta.url` at load. The `scripts/` directory is Node-only (it reads
 * files, reads `process.argv`, resolves paths); the Worker never needs it.
 *
 * This walks the relative imports from the Worker's entry points — the
 * middleware, the injected pages, the worker entries and the live config — and
 * holds two rules over every module it reaches:
 *  1. it lives under `src/`, never `scripts/`;
 *  2. it does not mention `import.meta.url` outside a comment.
 * The served-build CI step (`ci.yml`, "Serve the built staging worker") is the
 * end-to-end proof; this is the fast, local one.
 */
const STORE = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(STORE, "src");

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && /\.(ts|tsx|astro)$/.test(e.name))
		.map((e) => path.join(e.parentPath, e.name));
}

/** The modules Astro and the adapter load into the Worker directly. */
const ENTRY_POINTS = [
	path.join(SRC, "middleware.ts"),
	path.join(SRC, "worker.ts"),
	path.join(SRC, "playground-worker.ts"),
	path.join(SRC, "live.config.ts"),
	...filesUnder(path.join(SRC, "pages")),
];

/** Relative specifiers in `import … from`, `export … from` and `import(…)`. */
function relativeImports(source: string): string[] {
	const specs: string[] = [];
	const patterns = [
		/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g,
		/\bimport\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g,
	];
	for (const re of patterns) for (const m of source.matchAll(re)) specs.push(m[1]!);
	return specs;
}

/** A specifier as the bundler resolves it: `.js` is the `.ts` source. */
function resolveSpecifier(from: string, spec: string): string | undefined {
	const base = path.resolve(path.dirname(from), spec);
	const candidates = [
		base,
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.js$/, ".tsx"),
		`${base}.ts`,
		`${base}.tsx`,
		path.join(base, "index.ts"),
	];
	return candidates.find((c) => /\.(ts|tsx|astro)$/.test(c) && existsSync(c));
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every module reachable from the entry points, with the import that first
 *  reached it, so a failure names the chain. */
function workerModuleGraph(): Map<string, string | undefined> {
	const reached = new Map<string, string | undefined>();
	const queue: string[] = [];
	for (const entry of ENTRY_POINTS) {
		if (existsSync(entry) && !reached.has(entry)) {
			reached.set(entry, undefined);
			queue.push(entry);
		}
	}
	while (queue.length > 0) {
		const file = queue.shift()!;
		for (const spec of relativeImports(readFileSync(file, "utf8"))) {
			const target = resolveSpecifier(file, spec);
			if (target === undefined || reached.has(target)) continue;
			reached.set(target, file);
			queue.push(target);
		}
	}
	return reached;
}

function chain(graph: Map<string, string | undefined>, file: string): string {
	const links: string[] = [];
	for (let at: string | undefined = file; at !== undefined; at = graph.get(at)) {
		links.unshift(path.relative(STORE, at));
	}
	return links.join(" -> ");
}

describe("the Worker's module graph (#732)", () => {
	const graph = workerModuleGraph();

	test("the walk reaches the playground commerce module the middleware pulls in", () => {
		// Guards the walk itself: if it stopped following imports, both rules
		// below would pass over nothing.
		expect(graph.has(path.join(SRC, "lib", "playground-commerce.ts"))).toBe(true);
	});

	test("reaches nothing outside src/ (the Node-only scripts stay out of the Worker)", () => {
		const outside = [...graph.keys()]
			.filter((file) => !file.startsWith(SRC + path.sep))
			.map((file) => chain(graph, file));
		expect(outside).toEqual([]);
	});

	// `dirname`, `filename` and `resolve` are as unusable in the bundled Worker as `url`.
	test("no reachable module uses import.meta.url (or dirname, filename, resolve)", () => {
		const offenders = [...graph.keys()]
			.filter((file) =>
				/import\.meta\.(url|dirname|filename|resolve)\b/.test(
					stripComments(readFileSync(file, "utf8")),
				),
			)
			.map((file) => chain(graph, file));
		expect(offenders).toEqual([]);
	});
});
