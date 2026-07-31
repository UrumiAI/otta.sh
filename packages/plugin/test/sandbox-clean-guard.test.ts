import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ALLOWED_HOSTS, OTTA_PLUGIN_CAPABILITIES } from "../src/manifest.js";

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
 *  property-style type declaration don't match). NOTE: no `/g` flag on the
 *  detection patterns — a global regex used with `.test()` in a loop keeps
 *  a stateful `lastIndex` and under-reports offenders (review N1). */
const BARE_FETCH_CALL = /(?<![.\w$#])fetch\s*\(/;
const AMBIENT_FETCH = /(?:globalThis|self|window)\s*\.\s*fetch/;
const XML_HTTP_REQUEST = /XMLHttpRequest/;
/** Counting variant — `/g` is correct with `.match()`; sanctioned file only. */
const GLOBAL_THIS_FETCH_ALL = /globalThis\s*\.\s*fetch/g;

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
				["ambient globalThis/self/window fetch", AMBIENT_FETCH],
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
		const calls = content.match(GLOBAL_THIS_FETCH_ALL) ?? [];
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

/**
 * B5 (storefront-checkout plan §3 / ADR-0012 decision 3) — the checkout feature
 * makes the buyer's browser talk to Stripe, and the tempting-but-wrong
 * follow-through is "we talk to Stripe now, so add `js.stripe.com` to
 * `allowedHosts`".
 *
 * `allowedHosts` gates `ctx.http.fetch` — SERVER-SIDE PLUGIN EGRESS ONLY. The
 * `<script src="https://js.stripe.com/v3/">` on `/checkout/pay` and the
 * `stripe.confirmPayment()` call it makes both run in the buyer's browser,
 * which never passes through the plugin. Adding the host would be useless AND a
 * real widening of the gate ADR-0006 exists to keep at exactly one host — so
 * `js.stripe.com`'s ABSENCE is asserted here, deliberately, rather than left as
 * an unstated assumption a future edit can quietly violate.
 */
describe("sandbox-clean guard: the checkout feature widens NOTHING (ADR-0012)", () => {
	test("capabilities are still exactly content:read + network:request", () => {
		expect([...OTTA_PLUGIN_CAPABILITIES]).toEqual(["content:read", "network:request"]);
	});

	test("ALLOWED_HOSTS still holds exactly ONE host (the commerce service)", () => {
		expect(ALLOWED_HOSTS).toHaveLength(1);
	});

	test("js.stripe.com is NOT in allowedHosts — browser→Stripe is not plugin egress", () => {
		expect(ALLOWED_HOSTS).not.toContain("js.stripe.com");
		expect(ALLOWED_HOSTS.some((host) => host.includes("stripe"))).toBe(false);
	});

	test("no plugin source references js.stripe.com — Stripe.js is loaded by the THEME page, never the plugin", () => {
		const offenders = listSourceFiles(SRC_DIR).filter((file) =>
			readFileSync(file, "utf8").includes("js.stripe.com"),
		);
		expect(offenders).toEqual([]);
	});
});
