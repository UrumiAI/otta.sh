import { describe, expect, test } from "vitest";
import { parseHoldTtlMs, resolveServiceConfig } from "../src/config.js";

// Pure env-parsing unit tests (no DB, no server) — the exact semantics the bin
// entry (`index.ts`) has always had, now extracted so the Worker entry shares
// them (D4).
describe("parseHoldTtlMs", () => {
	test("undefined stays undefined (the domain default applies downstream)", () => {
		expect(parseHoldTtlMs(undefined)).toBeUndefined();
	});

	test("a valid numeric string parses to a number", () => {
		expect(parseHoldTtlMs("900000")).toBe(900_000);
		expect(parseHoldTtlMs("1")).toBe(1);
	});

	test.each(["0", "-5", "abc", ""])('invalid value "%s" throws naming CART_HOLD_TTL_MS', (raw) => {
		expect(() => parseHoldTtlMs(raw)).toThrowError(/CART_HOLD_TTL_MS must be a positive number/);
	});
});

describe("resolveServiceConfig", () => {
	test("empty env resolves to all-undefined (defaults apply, endpoints disabled)", () => {
		expect(resolveServiceConfig({})).toEqual({
			ttlMs: undefined,
			internalToken: undefined,
			serviceToken: undefined,
		});
	});

	test("passes INTERNAL_API_TOKEN through verbatim (empty string included — the route layer decides)", () => {
		expect(resolveServiceConfig({ INTERNAL_API_TOKEN: "secret" }).internalToken).toBe("secret");
		expect(resolveServiceConfig({ INTERNAL_API_TOKEN: "" }).internalToken).toBe("");
	});

	test("passes SERVICE_API_TOKEN through verbatim", () => {
		expect(resolveServiceConfig({ SERVICE_API_TOKEN: "svc-token" }).serviceToken).toBe("svc-token");
		expect(resolveServiceConfig({}).serviceToken).toBeUndefined();
	});

	test("parses CART_HOLD_TTL_MS and rethrows its validation error", () => {
		expect(resolveServiceConfig({ CART_HOLD_TTL_MS: "60000" }).ttlMs).toBe(60_000);
		expect(() => resolveServiceConfig({ CART_HOLD_TTL_MS: "nope" })).toThrowError(
			/CART_HOLD_TTL_MS/,
		);
	});
});
