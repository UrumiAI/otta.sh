import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * Every import/require specifier in a source file, however it is spelled:
 * `import … from "x"`, `import "x"`, `export … from "x"`, `import("x")` and
 * `require("x")`. Matching the SPECIFIER rather than the whole statement is what
 * makes the assertion below immune to formatting — a multi-line import list, a
 * type-only import, a dynamic import inside a function all reduce to the same
 * captured string.
 */
const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*|\brequire\s*)\(?\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/gu;

/**
 * Node's builtins as dependency-cruiser reports them — BARE, with no `node:`
 * prefix. The plugin rule's own comment in `.dependency-cruiser.cjs` records why
 * this half matters: `import … from "node:fs"` is reported under the bare name
 * `fs`, so a `^node:`-only check silently permits every builtin it names. A grep
 * guard has the mirror-image hazard (it sees the literal source text, so it sees
 * `node:fs` but would miss a bare `import "fs"`), hence both spellings here.
 */
const NODE_BUILTINS = new Set([
	"assert",
	"buffer",
	"child_process",
	"cluster",
	"crypto",
	"dgram",
	"dns",
	"events",
	"fs",
	"http",
	"http2",
	"https",
	"net",
	"os",
	"path",
	"perf_hooks",
	"process",
	"querystring",
	"readline",
	"stream",
	"string_decoder",
	"timers",
	"tls",
	"tty",
	"url",
	"util",
	"v8",
	"vm",
	"worker_threads",
	"zlib",
]);

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listSourceFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function nodeImportsIn(file: string): string[] {
	const content = readFileSync(file, "utf8");
	const found: string[] = [];
	// A fresh regex per file: `SPECIFIER` carries `/g`, and a shared global regex
	// keeps a stateful `lastIndex` across calls, which under-reports offenders —
	// the same trap `packages/plugin/test/sandbox-clean-guard.test.ts` documents.
	const pattern = new RegExp(SPECIFIER.source, "gu");
	let match: RegExpExecArray | null = pattern.exec(content);
	while (match !== null) {
		const specifier = match[1] ?? match[2];
		if (specifier !== undefined) {
			const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
			if (specifier.startsWith("node:") || NODE_BUILTINS.has(bare.split("/")[0] ?? "")) {
				found.push(specifier);
			}
		}
		match = pattern.exec(content);
	}
	return found;
}

/**
 * The sandbox-clean perimeter, asserted for THIS package (INC-C1).
 *
 * `@otta-sh/payments-stripe` is constructed in-process by the plugin, so its
 * source is loaded inside the workerd sandbox — where a `node:` import is not
 * merely discouraged but unavailable. The adapter used to import
 * `node:crypto`'s `createHmac` + `timingSafeEqual`; both are now
 * `crypto.subtle`, an ambient global in Node ≥19 and in workerd alike.
 *
 * This is the grep half of the same two-part mechanism the plugin already uses
 * (`packages/plugin/test/sandbox-clean-guard.test.ts` beside the
 * `plugin-is-sandbox-clean` dependency-cruiser rule) rather than a new one:
 * depcruise's builtin clause enumerates specific IO builtins — `fs`,
 * `child_process`, `net`, `http`, … — and deliberately does NOT name `crypto`,
 * so the `node:crypto` import this increment removed would have cruised clean
 * forever. A grep guard bans the whole `node:` namespace instead of a list
 * someone has to remember to extend, which is exactly the acceptance criterion
 * for this increment: no `node:` import remains, not merely no `node:crypto`.
 *
 * Test code is exempt, as it is for every rule in `.dependency-cruiser.cjs` —
 * this very file reads its own package's sources with `node:fs`, and runs in
 * Node, outside the shipped surface.
 */
describe("sandbox-clean guard: payments-stripe src carries no node: import (INC-C1)", () => {
	test("src has at least one source file to check (the guard cannot pass vacuously)", () => {
		expect(listSourceFiles(SRC_DIR).length).toBeGreaterThan(0);
	});

	test("no source file imports a node: builtin, in either spelling", () => {
		const offenders = listSourceFiles(SRC_DIR).flatMap((file) =>
			nodeImportsIn(file).map((spec) => `${path.relative(SRC_DIR, file)}: ${spec}`),
		);
		expect(offenders).toEqual([]);
	});

	test("the guard actually detects a node: import (it is not a no-op regex)", () => {
		// Proves the matcher, not the sources: the assertion above is only worth
		// something if a planted import would have tripped it.
		const planted = [
			'import { createHmac } from "node:crypto";',
			'import "node:fs";',
			'const x = await import("node:os");',
			'export { join } from "node:path";',
			'import { readFile } from "fs";', // the bare spelling depcruise reports
		].join("\n");
		const pattern = new RegExp(SPECIFIER.source, "gu");
		const hits: string[] = [];
		let match: RegExpExecArray | null = pattern.exec(planted);
		while (match !== null) {
			const specifier = match[1] ?? match[2];
			if (specifier !== undefined) hits.push(specifier);
			match = pattern.exec(planted);
		}
		expect(hits).toEqual(["node:crypto", "node:fs", "node:os", "node:path", "fs"]);
	});
});
