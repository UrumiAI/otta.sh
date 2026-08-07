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

describe("behind a TLS-terminating proxy", () => {
	// The edge speaks https to the browser and http to the pod, so the app's
	// own origin differs from the browser's Origin BY SCHEME ONLY. Without
	// this, every add-to-cart 403s for real users while curl (no Origin) sails
	// through — broken in browsers, green from a terminal.
	const APP = "http://shop.example";

	test("same host, https Origin, edge reports https ⇒ allowed", () => {
		expect(isForbiddenCrossOrigin("https://shop.example", APP, "https")).toBe(false);
	});

	test("takes the CLIENT-facing hop when proxies are chained", () => {
		expect(isForbiddenCrossOrigin("https://shop.example", APP, "https, http")).toBe(false);
	});

	test("a DIFFERENT host is still forbidden, whatever the edge reports", () => {
		expect(isForbiddenCrossOrigin("https://evil.example", APP, "https")).toBe(true);
	});

	test("the header only relaxes the SCHEME — a junk value changes nothing", () => {
		expect(isForbiddenCrossOrigin("https://shop.example", APP, "javascript")).toBe(true);
		expect(isForbiddenCrossOrigin("https://shop.example", APP, "")).toBe(true);
	});

	test("absent header keeps the original strict comparison", () => {
		expect(isForbiddenCrossOrigin("https://shop.example", APP)).toBe(true);
		expect(isForbiddenCrossOrigin("http://shop.example", APP)).toBe(false);
	});
});
