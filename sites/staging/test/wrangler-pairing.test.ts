/**
 * The build-time pairing guard (issue #375, review round 1): the wrangler config
 * the build actually uses must never carry `global_fetch_strictly_public` while
 * D1 sessions are on. The tracked template no longer carries the flag, but every
 * deployment made before #375 copied it into its gitignored
 * `wrangler.local.jsonc` — which astro.config.ts builds from — so pulling the
 * sessions change would otherwise ship the emdash #1273 combination silently.
 */
import { describe, expect, test } from "vitest";
import {
	assertWranglerSessionPairing,
	violatesPairing,
	wranglerCompatibilityFlags,
} from "../src/lib/wrangler-pairing.js";

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
const UPGRADED_LOCAL = OLD_LOCAL.replace(', "global_fetch_strictly_public",', ",");

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

describe("assertWranglerSessionPairing", () => {
	test("flag + session on: throws, naming the file and telling the operator to delete the flag", () => {
		expect(() =>
			assertWranglerSessionPairing(OLD_LOCAL, "wrangler.local.jsonc", { session: "primary-first" }),
		).toThrow(
			/wrangler\.local\.jsonc.*global_fetch_strictly_public[\s\S]*Delete "global_fetch_strictly_public"/,
		);
	});

	test("flag absent: ok", () => {
		expect(() =>
			assertWranglerSessionPairing(UPGRADED_LOCAL, "wrangler.local.jsonc", {
				session: "primary-first",
			}),
		).not.toThrow();
	});

	test("session off + flag: ok", () => {
		expect(() => assertWranglerSessionPairing(OLD_LOCAL, "wrangler.local.jsonc", {})).not.toThrow();
		expect(() =>
			assertWranglerSessionPairing(OLD_LOCAL, "wrangler.local.jsonc", { session: "disabled" }),
		).not.toThrow();
		expect(() =>
			assertWranglerSessionPairing(OLD_LOCAL, "wrangler.local.jsonc", undefined),
		).not.toThrow();
	});
});
