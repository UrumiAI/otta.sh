/**
 * Base layout favicon (item 4 — no favicon means a 404 on every page load,
 * console noise). Weak-but-cheap source-text pin (mirrors json-ld-xss.test.ts's
 * pattern for asserting something about an .astro file's markup without
 * rendering it) — real confirmation is the Playwright pass (deferred, see
 * the PR).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const BASE_LAYOUT_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../src/layouts/Base.astro",
);

describe("Base layout favicon", () => {
	test("declares an inline SVG data-URI favicon link — no public/ asset, no 404", () => {
		const source = readFileSync(BASE_LAYOUT_PATH, "utf8");
		expect(source).toMatch(/<link\s+rel="icon"[^>]*>/);
		expect(source).toContain('type="image/svg+xml"');
		expect(source).toContain("data:image/svg+xml,");
	});
});
