/**
 * `resolveAllowedHosts` — the plugin's egress allowlist, as a pure function so
 * it is unit-testable without a bundler (§5).
 *
 * INC-D3a retired the http/in-process mode branch: there is ONE list now, the
 * commerce service is gone, and `resolveAllowedHosts` no longer takes a mode
 * or a service base URL. ADR-0031 removed every email host: email goes through
 * `ctx.email`, never `ctx.http`. No deployment-supplied host is left, so the
 * list is a constant: Stripe's API host alone.
 */
import { describe, expect, test } from "vitest";
import {
	ALLOWED_HOSTS,
	OTTA_PLUGIN_CAPABILITIES,
	resolveAllowedHosts,
	STRIPE_API_HOST,
} from "../src/manifest.js";

/** The hosts granted in EVERY build: Stripe's API, and nothing else. */
const BASELINE = [STRIPE_API_HOST];

describe("resolveAllowedHosts — the egress set, EXACTLY", () => {
	test("with nothing configured, EXACTLY the Stripe API host", () => {
		// Stripe is the one host the in-process plugin always talks to itself
		// (`paymentIntents.create` / refunds). No email host at all (ADR-0031).
		expect(resolveAllowedHosts()).toEqual(BASELINE);
	});

	test("no email vendor host is ever granted (ADR-0031: email is ctx.email)", () => {
		for (const host of resolveAllowedHosts()) {
			expect(host).not.toMatch(/smtp|mail/i);
		}
	});

	test("STRIPE_API_HOST is the API host, never the browser-side Stripe.js host", () => {
		// `sandbox-clean-guard.test.ts` pins js.stripe.com's ABSENCE: Stripe.js runs
		// in the buyer's browser and is not plugin egress. api.stripe.com is the
		// server-side call the folded-in gateway makes, and is a different thing.
		expect(STRIPE_API_HOST).toBe("api.stripe.com");
		expect(resolveAllowedHosts()).not.toContain("js.stripe.com");
	});
});

describe("ALLOWED_HOSTS — the resolved constant for THIS bundle", () => {
	test("this build resolves to the baseline allowlist", () => {
		expect(ALLOWED_HOSTS).toEqual(BASELINE);
	});

	test("ALLOWED_HOSTS agrees with resolveAllowedHosts()", () => {
		expect(ALLOWED_HOSTS).toEqual(resolveAllowedHosts());
	});
});

describe("OTTA_PLUGIN_CAPABILITIES", () => {
	test("EXACTLY content:read, network:request and email:send (ADR-0031)", () => {
		expect([...OTTA_PLUGIN_CAPABILITIES]).toEqual([
			"content:read",
			"network:request",
			"email:send",
		]);
	});
});
