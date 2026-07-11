/**
 * Manifest compile-time override (site task D4): a deploying site injects
 * the real commerce-service URL into the plugin bundle via a Vite `define`
 * of `__URUMI_COMMERCE_SERVICE_URL__`; without the define (plain tsdown
 * build, sandbox harness, this vitest run) the placeholder must survive
 * unchanged. The resolution is a pure exported function so both branches
 * are unit-testable — no bundler in the loop.
 */
import { describe, expect, test } from "vitest";
import {
	ALLOWED_HOSTS,
	COMMERCE_SERVICE_BASE_URL,
	resolveCommerceServiceBaseUrl,
} from "../src/manifest.js";

const PLACEHOLDER = "https://commerce.urumi.internal";

describe("manifest COMMERCE_SERVICE_BASE_URL resolution", () => {
	test("falls back to the placeholder when the compile-time define is absent", () => {
		expect(resolveCommerceServiceBaseUrl(undefined)).toBe(PLACEHOLDER);
	});

	test("empty-string define is treated as absent (never an unusable base URL)", () => {
		expect(resolveCommerceServiceBaseUrl("")).toBe(PLACEHOLDER);
	});

	test("prefers the compile-time override when present", () => {
		expect(resolveCommerceServiceBaseUrl("https://svc.example.com")).toBe(
			"https://svc.example.com",
		);
	});

	test("this un-defined build resolves to the placeholder", () => {
		// vitest bundles without the define, so the module-level constant
		// must be the placeholder here.
		expect(COMMERCE_SERVICE_BASE_URL).toBe(PLACEHOLDER);
	});

	test("ALLOWED_HOSTS stays derived from COMMERCE_SERVICE_BASE_URL", () => {
		expect(ALLOWED_HOSTS).toEqual([new URL(COMMERCE_SERVICE_BASE_URL).hostname]);
	});
});
