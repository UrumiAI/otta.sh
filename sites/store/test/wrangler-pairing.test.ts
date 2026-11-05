/**
 * The pairing rule (issue #375): `global_fetch_strictly_public` must never ship
 * beside a D1 session mode. site-config.test.ts applies it to the tracked
 * template; this pins the predicate and the flag reader. (The build-time guard on
 * a deployment's own `wrangler.local.jsonc` was removed in #455.)
 */
import { describe, expect, test } from "vitest";
import { violatesPairing, wranglerCompatibilityFlags } from "../src/lib/wrangler-pairing.js";

/** A pre-#375 local copy: comments (one with `//` inside a string), the flag,
 *  trailing commas. */
const OLD_LOCAL = `// my store
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "shop", // the Worker
	"routes": [{ "pattern": "https://shop.example.com/*" }],
	/* block comment */
	"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public",],
}`;

describe("violatesPairing", () => {
	const flag = ["nodejs_compat", "global_fetch_strictly_public"];

	test("the flag beside any session mode is a violation", () => {
		expect(violatesPairing(flag, "auto")).toBe(true);
		expect(violatesPairing(flag, "primary-first")).toBe(true);
	});

	test("session off — absent, empty or disabled, as EmDash's isSessionEnabled reads it — is fine", () => {
		expect(violatesPairing(flag, undefined)).toBe(false);
		expect(violatesPairing(flag, "")).toBe(false);
		expect(violatesPairing(flag, "disabled")).toBe(false);
	});

	test("no flag is fine with any session mode", () => {
		expect(violatesPairing(["nodejs_compat"], "primary-first")).toBe(false);
		expect(violatesPairing([], "auto")).toBe(false);
	});
});

describe("wranglerCompatibilityFlags", () => {
	test("reads the array through comments, a `//` inside a string, and trailing commas", () => {
		expect(wranglerCompatibilityFlags(OLD_LOCAL)).toEqual([
			"nodejs_compat",
			"global_fetch_strictly_public",
		]);
	});

	test("the flag's name in a comment does not count", () => {
		const text = `{
	// we used to set "global_fetch_strictly_public" here
	"compatibility_flags": ["nodejs_compat"]
}`;
		expect(wranglerCompatibilityFlags(text)).toEqual(["nodejs_compat"]);
	});

	test("no compatibility_flags key is no flags", () => {
		expect(wranglerCompatibilityFlags(`{ "name": "x" }`)).toEqual([]);
	});
});

describe("BOM and parse errors (review round 2)", () => {
	test("a leading UTF-8 BOM is stripped before parsing", () => {
		expect(wranglerCompatibilityFlags(`\uFEFF${OLD_LOCAL}`, "wrangler.local.jsonc")).toEqual([
			"nodejs_compat",
			"global_fetch_strictly_public",
		]);
	});

	test("a config that does not parse: the error names the file", () => {
		expect(() => wranglerCompatibilityFlags(`{ "name": "x" `, "wrangler.local.jsonc")).toThrow(
			/wrangler\.local\.jsonc could not be parsed as JSONC/,
		);
	});
});
