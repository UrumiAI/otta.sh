/**
 * `resolveAllowedHosts` / `resolveInProcessEgress` — the plugin's egress
 * allowlist and the matching consumer-facing URLs, as pure functions so both
 * are unit-testable without a bundler (§5).
 *
 * INC-D3a retired the http/in-process mode branch: there is ONE list now, the
 * commerce service is gone, and `resolveAllowedHosts` no longer takes a mode
 * or a service base URL — it is always Stripe's API host plus whatever the
 * deployment's egress supplies (nothing today). ADR-0031 removed every email
 * host: email goes through `ctx.email`, never `ctx.http`.
 */
import { describe, expect, test } from "vitest";
import {
	ALLOWED_HOSTS,
	IN_PROCESS_EGRESS_URLS,
	OTTA_PLUGIN_CAPABILITIES,
	resolveAllowedHosts,
	resolveInProcessEgress,
	STRIPE_API_HOST,
} from "../src/manifest.js";

/** The hosts granted in EVERY build: Stripe's API, and nothing else. */
const BASELINE = [STRIPE_API_HOST];

describe("resolveAllowedHosts — the egress set, EXACTLY", () => {
	test("with nothing configured, EXACTLY the Stripe API host", () => {
		// Stripe is the one host the in-process plugin always talks to itself
		// (`paymentIntents.create` / refunds). No email host at all (ADR-0031).
		expect(resolveAllowedHosts()).toEqual(BASELINE);
		expect(resolveAllowedHosts({})).toEqual(BASELINE);
	});

	test("no email vendor host is ever granted (ADR-0031: email is ctx.email)", () => {
		for (const host of resolveAllowedHosts({})) {
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

describe("ALLOWED_HOSTS / IN_PROCESS_EGRESS_URLS — the resolved constants for THIS bundle", () => {
	test("this un-defined build (no bundler define) resolves to the baseline allowlist", () => {
		// vitest bundles without any egress define, so the module-level constants
		// must reflect an unconfigured deployment.
		expect(ALLOWED_HOSTS).toEqual(BASELINE);
		expect(IN_PROCESS_EGRESS_URLS).toEqual({});
	});

	test("ALLOWED_HOSTS agrees with resolveAllowedHosts() called with no egress", () => {
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

describe("resolveInProcessEgress — the CONSUMERS see the same URLs the gate grants", () => {
	test("with nothing configured a consumer is handed no egress URL", () => {
		expect(resolveInProcessEgress()).toEqual({});
		expect(resolveInProcessEgress({})).toEqual({});
	});
});
