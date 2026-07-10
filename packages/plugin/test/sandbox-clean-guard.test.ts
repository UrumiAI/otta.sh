import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * The plugin's ONE sanctioned ambient-fetch call site: `createHttpAccess`
 * in sandbox-entry.ts — the `ctx.http` implementation itself, which calls
 * `globalThis.fetch` only AFTER the allowedHosts check. Everything else in
 * src must go through the injected `ctx.http.fetch`.
 */
const SANCTIONED_FILE = "sandbox-entry.ts";

/** Direct invocation of a bare `fetch(` — not preceded by `.`, `#`, or a
 *  word char (so `ctx.http.fetch(`, `this.#fetch(`, `options.fetch` and the
 *  property-style type declaration don't match). */
const BARE_FETCH_CALL = /(?<![.\w$#])fetch\s*\(/;
const GLOBAL_THIS_FETCH = /globalThis\s*\.\s*fetch/g;
const XML_HTTP_REQUEST = /XMLHttpRequest/;

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listSourceFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/**
 * Review S4 — the complement to the `plugin-is-sandbox-clean`
 * dependency-cruiser rule: depcruise catches forbidden IMPORTS (pg, undici,
 * axios, ws, node:net, …) but cannot see AMBIENT globals — and workerd
 * provides a global `fetch` that would silently bypass the allowedHosts
 * check. This guard fails the build if any plugin source outside the
 * sanctioned `ctx.http` implementation invokes `fetch`/`globalThis.fetch`/
 * `XMLHttpRequest` directly.
 */
describe("sandbox-clean guard: no direct network egress in plugin src (S4)", () => {
	test("no direct fetch/globalThis.fetch/XMLHttpRequest usage outside the sanctioned ctx.http implementation", () => {
		const offenders: string[] = [];
		for (const file of listSourceFiles(SRC_DIR)) {
			if (path.basename(file) === SANCTIONED_FILE) continue;
			const content = readFileSync(file, "utf8");
			for (const [name, pattern] of [
				["bare fetch(", BARE_FETCH_CALL],
				["globalThis.fetch", GLOBAL_THIS_FETCH],
				["XMLHttpRequest", XML_HTTP_REQUEST],
			] as const) {
				if (pattern.test(content)) {
					offenders.push(`${path.relative(SRC_DIR, file)}: ${name}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the sanctioned ctx.http implementation contains exactly one globalThis.fetch call site, after the allowedHosts check", () => {
		const content = readFileSync(path.join(SRC_DIR, SANCTIONED_FILE), "utf8");
		const calls = content.match(GLOBAL_THIS_FETCH) ?? [];
		expect(calls).toHaveLength(1);
		// And it lives inside createHttpAccess (the allowedHosts-guarded path),
		// not loose in the dispatcher.
		const fnStart = content.indexOf("function createHttpAccess");
		const fnEnd = content.indexOf("function jsonResponse");
		const callSite = content.indexOf("globalThis.fetch");
		expect(fnStart).toBeGreaterThan(-1);
		expect(callSite).toBeGreaterThan(fnStart);
		expect(callSite).toBeLessThan(fnEnd);
	});
});
