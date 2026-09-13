/**
 * Packaging guard (work order 02, INC-A6 / R6): the plugin is about to start
 * importing `@otta-sh/domain` and `@otta-sh/store-emdash` (the in-process
 * commerce client), and both must be BUNDLED INTO the emitted plugin, never
 * emitted as bare specifiers.
 *
 * WHY THIS TEST ASSERTS ON BUILT OUTPUT. The twenty `*.sandbox.test.ts` suites
 * run the plugin inside workerd from a bundle, and workerd has no node
 * resolution: a surviving bare `@otta-sh/*` specifier does not fail like a
 * missing module in vitest, it fails at module instantiation inside the sandbox,
 * one indirection away from anything readable. Likewise a runtime `emdash`
 * import would break ADR-0018's "zero EmDash RUNTIME dependency" rule, which
 * depcruise enforces on source but cannot see in the emitted graph.
 *
 * HOW IT BUILDS. tsdown's programmatic `build()`, exactly as
 * `test/sandbox/harness.ts` does, into a `mkdtemp` directory — never `npx`, and
 * never the real `dist/`. Two reasons: a stale `dist/` somebody else left behind
 * would let this pass while the real bundle regressed, and writing into the
 * package's own `dist/` from a test would race `pnpm -r build` and leave the
 * checkout's artifacts in whatever state the last test run wanted.
 *
 * WHAT CONFIG IT BUILDS WITH. The package's OWN `tsdown.config.ts`, imported
 * rather than retyped, with only `outDir`/`dts`/`logLevel` overridden. A
 * hand-copied `noExternal`/`define` here would happily stay green while the
 * shipped config drifted — which is the entire failure this guard exists to
 * catch. (Entry paths are absolutized because tsdown resolves them against the
 * CWD, and `pnpm test` runs from the repo root.)
 *
 * ROLLDOWN CHUNKS. `plugin.mjs` re-exports a shared chunk, so every emitted
 * `*.mjs` is scanned. Asserting on the entry alone would read as green while
 * the chunk carried the bare import.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import tsdownConfig from "../tsdown.config.js";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * The ONLY bare specifier the emitted bundle may carry.
 * `@otta-sh/admin-presentation` is a real `dependencies` entry and is
 * deliberately left external — it is pure presentation helpers with no IO,
 * shared with `@otta-sh/admin-react`, and the consuming site resolves it from
 * the workspace while bundling `@otta-sh/plugin`. `@otta-sh/domain` and
 * `@otta-sh/store-emdash` are NOT on this list: they are marked `noExternal`
 * precisely so they land inside the bundle.
 */
const ALLOWED_BARE_SPECIFIERS = new Set(["@otta-sh/admin-presentation"]);

function isBare(spec: string): boolean {
	return !spec.startsWith(".") && !spec.startsWith("/");
}

/**
 * Every bare specifier the module graph of one emitted file names: static
 * `import`/`export … from`, bare side-effect `import "…"`, and DYNAMIC
 * `import("…")` with a literal argument — the last because a lazy admin or
 * reporting path (R6 explicitly contemplates lazy-importing them if the bundle
 * grows) would otherwise smuggle a bare specifier past a static-only scan.
 */
function bareSpecifiers(source: string): string[] {
	const found = new Set<string>();
	// Deliberately tight: no quote, semicolon or newline may sit between the
	// keyword and its `from`, so a `from` inside a string literal or a docblock
	// elsewhere in the chunk cannot be mistaken for an import.
	for (const m of source.matchAll(/\b(?:import|export)\b[^;'"\n]*?\bfrom\s*["']([^"']+)["']/g)) {
		const spec = m[1];
		if (spec !== undefined && isBare(spec)) found.add(spec);
	}
	for (const m of source.matchAll(/(?:^|[\s;}])import\s*["']([^"'\n]+)["']/g)) {
		const spec = m[1];
		if (spec !== undefined && isBare(spec)) found.add(spec);
	}
	// `import("spec")` / `await import( "spec" )` — a literal dynamic import.
	for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g)) {
		const spec = m[1];
		if (spec !== undefined && isBare(spec)) found.add(spec);
	}
	return [...found];
}

let outDir = "";
let emitted: Array<{ file: string; source: string; specifiers: string[] }> = [];

describe("emitted plugin bundle carries no un-bundled workspace or host import", () => {
	beforeAll(async () => {
		outDir = await mkdtemp(path.join(tmpdir(), "otta-plugin-bundle-"));
		const entry = (tsdownConfig.entry as string[]).map((e) => path.resolve(PKG_DIR, e));
		await build({
			...tsdownConfig,
			entry,
			outDir,
			// Types are irrelevant to what a specifier scan can see, and dts
			// generation is most of this build's wall clock.
			dts: false,
			logLevel: "silent",
		});
		const files = (await readdir(outDir)).filter((f) => f.endsWith(".mjs"));
		emitted = await Promise.all(
			files.map(async (file) => {
				const source = await readFile(path.join(outDir, file), "utf8");
				return { file, source, specifiers: bareSpecifiers(source) };
			}),
		);
	}, 180_000);

	afterAll(async () => {
		if (outDir.length > 0) await rm(outDir, { recursive: true, force: true });
	});

	test("the build emits at least the three declared entrypoints", () => {
		const names = emitted.map((e) => e.file);
		expect(names).toContain("index.mjs");
		expect(names).toContain("plugin.mjs");
		expect(names).toContain("sandbox-entry.mjs");
	});

	test("NO bare @otta-sh/domain or @otta-sh/store-emdash import survives", () => {
		for (const { file, specifiers } of emitted) {
			expect(specifiers, file).not.toContain("@otta-sh/domain");
			expect(specifiers, file).not.toContain("@otta-sh/store-emdash");
			expect(
				specifiers.filter((s) => s.startsWith("@otta-sh/domain/")),
				file,
			).toEqual([]);
			expect(
				specifiers.filter((s) => s.startsWith("@otta-sh/store-emdash/")),
				file,
			).toEqual([]);
		}
	});

	test("NO runtime `emdash` / `@emdash-cms/*` import survives (ADR-0018)", () => {
		for (const { file, specifiers } of emitted) {
			expect(
				specifiers.filter((s) => s === "emdash" || s.startsWith("emdash/")),
				file,
			).toEqual([]);
			expect(
				specifiers.filter((s) => s.startsWith("@emdash-cms/")),
				file,
			).toEqual([]);
		}
	});

	test("the only bare specifiers are the explicitly allowed ones", () => {
		for (const { file, specifiers } of emitted) {
			const unexpected = specifiers.filter((s) => !ALLOWED_BARE_SPECIFIERS.has(s));
			expect(unexpected, `${file} carries unexpected bare specifiers`).toEqual([]);
		}
	});

	test('the tsdown `define` reaches the bundle: the mode is baked as "http"', () => {
		// TRANSITIONAL (work order 02 D6) — deleted with the flag at INC-D3b.
		// Without this, `noExternal` could be right while the define silently
		// never applied, leaving `__OTTA_COMMERCE_MODE__` a free identifier in the
		// worker bundle. The `typeof` guard would keep that SAFE, so nothing would
		// fail — the mode would simply stop being something a build declares, and
		// the first site that wanted in-process would find the flag inert.
		const baked = emitted.filter((e) => e.source.includes('resolveCommerceModeFrom("http")'));
		expect(baked.length).toBeGreaterThan(0);
		for (const { file, source } of emitted) {
			// The un-substituted form must be gone, not merely accompanied.
			expect(source, file).not.toMatch(/resolveCommerceModeFrom\(\s*typeof\s/);
		}
	});
});
