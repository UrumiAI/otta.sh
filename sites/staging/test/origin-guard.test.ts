/**
 * Origin guard for the /cart/* POST endpoints.
 *
 * The reviewer-assumed CSRF story ("Astro checkOrigin defaults true") does
 * NOT hold on an emdash site: the emdash astro integration force-disables
 * Astro's built-in checkOrigin (`security: { checkOrigin: false }`,
 * em-dash integration/index.ts) and its replacement CSRF layer
 * (`checkPublicCsrf`) protects only `/_emdash/api/*` routes — never the
 * theme's own endpoints. Verified empirically in dev: a cross-origin form
 * POST to /cart/add sailed through. So the site enforces the same
 * origin-check semantics itself, and this test pins them.
 */
import { describe, expect, test } from "vitest";
import { isForbiddenCrossOrigin } from "../src/lib/origin-guard.js";

const SITE = "http://localhost:4321";

describe("isForbiddenCrossOrigin", () => {
	test("same-origin form POST is allowed", () => {
		expect(isForbiddenCrossOrigin(SITE, SITE)).toBe(false);
	});

	test("cross-origin form POST is forbidden", () => {
		expect(isForbiddenCrossOrigin("https://evil.example.com", SITE)).toBe(true);
	});

	test("subtle mismatches are forbidden (scheme, port, subdomain)", () => {
		expect(isForbiddenCrossOrigin("https://localhost:4321", SITE)).toBe(true);
		expect(isForbiddenCrossOrigin("http://localhost:9999", SITE)).toBe(true);
		expect(isForbiddenCrossOrigin("http://evil.localhost:4321", SITE)).toBe(true);
	});

	test("absent Origin (curl / server-to-server) is allowed — no ambient-credential vector", () => {
		// Browsers ALWAYS send Origin on cross-site form POSTs; a client that
		// omits it carries no cookies of its own accord. Mirrors em-dash's
		// checkPublicCsrf and Astro's own semantics for missing content-type.
		expect(isForbiddenCrossOrigin(null, SITE)).toBe(false);
	});

	test("'null' opaque origin is forbidden", () => {
		expect(isForbiddenCrossOrigin("null", SITE)).toBe(true);
	});
});
