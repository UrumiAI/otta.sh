/**
 * `resolveCommerceMode` — the transitional build-time switch between the HTTP
 * transport and the in-process commerce client.
 *
 * TRANSITIONAL. `__OTTA_COMMERCE_MODE__`, `resolveCommerceMode`, the factory's
 * mode branch, `COMMERCE_SERVICE_BASE_URL`, `HttpCommerceClient` and the four
 * admin HTTP clients are ALL DELETED at INC-D3b. The flag exists only so the
 * client contract can be run against both implementations before the HTTP one
 * is removed — it is not permanent architecture.
 *
 * Tested through the pure `resolveCommerceModeFrom(override)` seam (the same
 * shape `resolveCommerceServiceBaseUrl` already uses in `manifest.ts`) so the
 * three branches are exercised with no bundler in the loop; the no-arg
 * `resolveCommerceMode()` reads the compile-time global, which is absent in
 * this vitest run and must therefore yield the `"http"` default.
 */

import { describe, expect, test } from "vitest";
import {
	COMMERCE_MODE_DEFAULT,
	resolveCommerceMode,
	resolveCommerceModeFrom,
} from "../src/commerce/commerce-mode.js";

describe("resolveCommerceMode", () => {
	test("an ABSENT define resolves to the http default — every existing test path is unchanged", () => {
		expect(resolveCommerceModeFrom(undefined)).toBe("http");
		// No bundler defines `__OTTA_COMMERCE_MODE__` under vitest, so the
		// no-arg reader must take the same branch. This is the assertion that
		// guarantees INC-A6 is behaviour-neutral for the whole existing suite.
		expect(resolveCommerceMode()).toBe("http");
		expect(COMMERCE_MODE_DEFAULT).toBe("http");
	});

	test("an EMPTY define resolves to the http default (a bundler baking \"\" is 'unset')", () => {
		expect(resolveCommerceModeFrom("")).toBe("http");
	});

	test('"http" resolves to http', () => {
		expect(resolveCommerceModeFrom("http")).toBe("http");
	});

	test('"in-process" resolves to in-process', () => {
		expect(resolveCommerceModeFrom("in-process")).toBe("in-process");
	});

	test("an UNRECOGNIZED define THROWS rather than falling back", () => {
		// DOCUMENTED CHOICE: throw, never fall back. The value is a build-time
		// define, so a typo is a build misconfiguration that can only be fixed
		// by rebuilding — and a silent fallback to `"http"` would deploy a site
		// that talks to a service the operator believed had been folded in.
		//
		// This throws at plugin IMPORT time, not on a request: `manifest.ts`
		// calls `resolveCommerceMode()` at module load to resolve
		// `ALLOWED_HOSTS`, so a bad define takes the whole plugin down —
		// storefront, sync hooks and admin screens alike. Deliberate for a
		// misconfigured build, but it is a boot failure, not a degraded one.
		expect(() => resolveCommerceModeFrom("inprocess")).toThrow(/__OTTA_COMMERCE_MODE__/);
		expect(() => resolveCommerceModeFrom("HTTP")).toThrow(/__OTTA_COMMERCE_MODE__/);
		expect(() => resolveCommerceModeFrom("in_process")).toThrow(/__OTTA_COMMERCE_MODE__/);
	});
});
