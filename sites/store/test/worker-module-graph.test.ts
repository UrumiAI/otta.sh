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

/** Relative specifiers in `import … from`, `export … from`, `import "…"` and
 *  `import(…)`, read with comments removed: so `import(/* @vite-ignore *\/ "./x")`
 *  is followed and a commented-out import is not. A template literal counts
 *  when it has no `${…}`; one that interpolates can't be resolved statically. */
function relativeImports(source: string): string[] {
	const code = stripComments(source);
	const specs: string[] = [];
	const patterns = [
		/\bfrom\s*(["'`])(\.{1,2}\/[^"'`$\n]+)\1/g,
		/\bimport\s*\(?\s*(["'`])(\.{1,2}\/[^"'`$\n]+)\1/g,
	];
	for (const re of patterns) for (const m of code.matchAll(re)) specs.push(m[2]!);
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

/**
 * The source with its comments removed and its string and template literals
 * kept, so a `/*` or `//` inside a string (`"/_emdash/*"`, `"https://…"`) is
 * not taken for a comment. A quoted string ends at its line's end at the
 * latest, which keeps a stray apostrophe in an `.astro` template's text from
 * swallowing the rest of the file. Regex literals are not recognised (none of
 * the Worker's modules has one containing a comment marker).
 */
function stripComments(source: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const c = source[i]!;
		const next = source[i + 1];
		if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		if (c === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			i = end === -1 ? source.length : end;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			let j = i + 1;
			for (; j < source.length; j += source[j] === "\\" ? 2 : 1) {
				if (source[j] === quote || (quote !== "`" && source[j] === "\n")) break;
			}
			out += source.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		out += c;
		i += 1;
	}
	return out;
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

describe("the scanner's own edge cases (#734)", () => {
	test("a `/*` inside a string literal does not start a comment", () => {
		const source = 'const route = "/_emdash/*";\nconst at = import.meta.url;\n/* a real comment */';
		expect(stripComments(source)).toContain("import.meta.url");
		expect(stripComments(source)).not.toContain("a real comment");
	});

	test("a `//` inside a string or template literal does not start a comment", () => {
		const source = "const a = '//x'; const b = `//y`; const at = import.meta.url; // gone";
		expect(stripComments(source)).toContain("import.meta.url");
		expect(stripComments(source)).not.toContain("gone");
	});

	test("a dynamic import with a comment before its specifier is followed", () => {
		expect(relativeImports('await import(/* @vite-ignore */ "./x.js");')).toEqual(["./x.js"]);
	});

	test("a template-literal dynamic import without interpolation is followed", () => {
		expect(relativeImports("await import(`./y.js`);")).toEqual(["./y.js"]);
	});

	test("a commented-out import is not followed", () => {
		expect(
			relativeImports('// import { a } from "./gone.js";\n/* import("./gone2.js") */'),
		).toEqual([]);
	});
});

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
