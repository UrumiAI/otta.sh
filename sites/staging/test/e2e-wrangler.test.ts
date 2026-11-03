/**
 * The e2e stack's Worker config (ADR-0044 decision C1). Cash on delivery needs
 * the `RATE_LIMIT_WRITES` binding, which the template leaves commented out, so
 * the Playwright stack runs on `wrangler.e2e.jsonc`. Pinned here:
 *
 *  - it IS the template plus that one binding — nothing else may drift;
 *  - it binds only the writes class, at a limit no e2e run reaches;
 *  - it is selected only by `OTTA_E2E_WRITE_LIMIT=1`, and `astro build`
 *    refuses that, so it can never become a deploy's config.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	assertE2eWranglerNotBuilt,
	E2E_WRANGLER_CONFIG,
	E2E_WRITE_LIMIT_VAR,
	e2eWranglerConfig,
} from "../src/lib/e2e-wrangler.js";
import { RATE_LIMIT_BINDINGS } from "../src/lib/rate-limit.js";
import { parseWrangler } from "../src/lib/wrangler-jsonc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");

const template = parseWrangler(read("wrangler.jsonc"), "wrangler.jsonc", "the e2e pin");
const e2e = parseWrangler(read(E2E_WRANGLER_CONFIG), E2E_WRANGLER_CONFIG, "the e2e pin");

describe("wrangler.e2e.jsonc", () => {
	test("is the template plus ratelimits, and nothing else", () => {
		const { ratelimits, ...rest } = e2e;
		expect(rest).toEqual(template);
		expect(ratelimits).toBeDefined();
		// The template still binds none (production behaviour unchanged).
		expect(template["ratelimits"]).toBeUndefined();
	});

	test("binds the writes class only, far above any e2e run's traffic", () => {
		const limits = e2e["ratelimits"] as {
			name: string;
			simple: { limit: number; period: number };
		}[];
		expect(limits.map((entry) => entry.name)).toEqual([RATE_LIMIT_BINDINGS.writes]);
		expect(limits[0]?.simple.limit).toBeGreaterThanOrEqual(10_000);
		expect([10, 60]).toContain(limits[0]?.simple.period);
	});
});

describe("selecting it", () => {
	test("only OTTA_E2E_WRITE_LIMIT=1 selects it", () => {
		expect(E2E_WRITE_LIMIT_VAR).toBe("OTTA_E2E_WRITE_LIMIT");
		expect(e2eWranglerConfig("1")).toBe("wrangler.e2e.jsonc");
		for (const value of [undefined, "", "0", "true", "yes"]) {
			expect(e2eWranglerConfig(value), String(value)).toBeUndefined();
		}
	});

	test("astro build refuses it; astro dev takes it", () => {
		expect(() => assertE2eWranglerNotBuilt("build", "1")).toThrow(/OTTA_E2E_WRITE_LIMIT=1/);
		expect(() => assertE2eWranglerNotBuilt("dev", "1")).not.toThrow();
		expect(() => assertE2eWranglerNotBuilt("build", undefined)).not.toThrow();
	});

	test("astro.config.ts wires both halves, and the Playwright stack asks for it", () => {
		const config = read("astro.config.ts");
		expect(config).toContain("e2eWranglerConfig(process.env[E2E_WRITE_LIMIT_VAR])");
		expect(config).toContain("e2eWranglerIntegration(),");
		expect(read("../../playwright.config.ts")).toMatch(/OTTA_E2E_WRITE_LIMIT: "1"/);
	});
});
