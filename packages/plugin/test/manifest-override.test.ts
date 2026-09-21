/**
 * `resolveAllowedHosts` / `resolveInProcessEgress` — the plugin's egress
 * allowlist and the matching consumer-facing URLs, as pure functions so both
 * are unit-testable without a bundler (§5).
 *
 * INC-D3a retired the http/in-process mode branch: there is ONE list now, the
 * commerce service is gone, and `resolveAllowedHosts` no longer takes a mode
 * or a service base URL — it is always Stripe's API host plus whichever of the
 * deployment-supplied email/facilitator URLs parse to a hostname. `ALLOWED_HOSTS`
 * is that in-process list, not the (now-deleted) service host.
 */
import { describe, expect, test } from "vitest";
import {
	ALLOWED_HOSTS,
	IN_PROCESS_EGRESS_URLS,
	resolveAllowedHosts,
	resolveInProcessEgress,
	STRIPE_API_HOST,
} from "../src/manifest.js";

/** Order-insensitive EXACT comparison: `toEqual` on both sides sorted catches a
 *  missing host AND a leaked extra one, which `toContain` cannot. */
const sorted = (hosts: readonly string[]): string[] => [...hosts].toSorted();

describe("resolveAllowedHosts — the egress set, EXACTLY", () => {
	const EMAIL = "https://api.email.example.com/v1/send";
	const FACILITATOR = "https://facilitator.example.com";

	test("with nothing configured, EXACTLY the Stripe API host", () => {
		// Stripe is the one host the in-process plugin always talks to itself
		// (`paymentIntents.create` / refunds). Email and the facilitator are
		// deployment-supplied, so an unconfigured deployment gets no egress for
		// them — absent, never a wildcard.
		expect(resolveAllowedHosts()).toEqual([STRIPE_API_HOST]);
		expect(resolveAllowedHosts({})).toEqual([STRIPE_API_HOST]);
	});

	test("EXACTLY Stripe + email + facilitator once both are configured", () => {
		const hosts = resolveAllowedHosts({ emailApiUrl: EMAIL, facilitatorUrl: FACILITATOR });
		expect(sorted(hosts)).toEqual(
			sorted([STRIPE_API_HOST, "api.email.example.com", "facilitator.example.com"]),
		);
	});

	test("STRIPE_API_HOST is the API host, never the browser-side Stripe.js host", () => {
		// `sandbox-clean-guard.test.ts` pins js.stripe.com's ABSENCE: Stripe.js runs
		// in the buyer's browser and is not plugin egress. api.stripe.com is the
		// server-side call the folded-in gateway makes, and is a different thing.
		expect(STRIPE_API_HOST).toBe("api.stripe.com");
		expect(resolveAllowedHosts()).not.toContain("js.stripe.com");
	});

	test.each([
		["an empty string", ""],
		["undefined", undefined],
		["a non-URL", "not a url"],
		["a bare hostname with no scheme", "api.email.example.com"],
	])("FAIL-CLOSED: %s for the email URL grants NO email host", (_why, value) => {
		// An unparseable define must not throw at module load (it would take the
		// whole plugin down) and must not silently widen the gate. It grants
		// nothing, which surfaces as a refused fetch — a legible failure.
		expect(resolveAllowedHosts({ emailApiUrl: value })).toEqual([STRIPE_API_HOST]);
	});

	test("duplicate hosts collapse — the list is a SET, not a bag", () => {
		expect(
			resolveAllowedHosts({
				emailApiUrl: "https://api.stripe.com/mail",
				facilitatorUrl: "https://api.stripe.com/x402",
			}),
		).toEqual([STRIPE_API_HOST]);
	});
});

describe("ALLOWED_HOSTS / IN_PROCESS_EGRESS_URLS — the resolved constants for THIS bundle", () => {
	test("this un-defined build (no bundler define) resolves to the Stripe-only allowlist", () => {
		// vitest bundles without `__OTTA_EMAIL_API_URL__` / `__OTTA_X402_FACILITATOR_URL__`,
		// so the module-level constants must reflect an unconfigured deployment.
		expect(ALLOWED_HOSTS).toEqual([STRIPE_API_HOST]);
		expect(IN_PROCESS_EGRESS_URLS).toEqual({});
	});

	test("ALLOWED_HOSTS agrees with resolveAllowedHosts() called with no egress", () => {
		expect(ALLOWED_HOSTS).toEqual(resolveAllowedHosts());
	});
});

describe("resolveInProcessEgress — the CONSUMERS see the same URLs the gate grants", () => {
	const EMAIL = "https://api.email.example.com/v1/send";
	const FACILITATOR = "https://facilitator.example.com";

	test("passes baked URLs through unchanged when both parse", () => {
		expect(resolveInProcessEgress({ emailApiUrl: EMAIL, facilitatorUrl: FACILITATOR })).toEqual({
			emailApiUrl: EMAIL,
			facilitatorUrl: FACILITATOR,
		});
	});

	test("an UNPARSEABLE define grants no host, so it resolves to no egress either", () => {
		// `resolveAllowedHosts` drops anything `hostnameOf` cannot parse — a bare
		// hostname, an empty define, garbage — so passing such a URL through
		// verbatim would hand a consumer a URL the gate refuses: sender built, every
		// send refused, rows rescheduling, `count: 0` where `skipped` is the truth.
		expect(
			resolveInProcessEgress({
				emailApiUrl: "api.email.example.com", // no scheme ⇒ not a URL
				facilitatorUrl: "not a url at all",
			}),
		).toEqual({});
		// And the valid sibling still survives on its own.
		expect(resolveInProcessEgress({ emailApiUrl: "", facilitatorUrl: FACILITATOR })).toEqual({
			facilitatorUrl: FACILITATOR,
		});
	});

	test("every host the resolved egress names is a host the gate grants", () => {
		// The invariant stated as one assertion, over defines that do not parse
		// too: a consumer can never hold a URL whose host is absent from
		// ALLOWED_HOSTS. One resolver, so the gate and every caller cannot
		// disagree by construction.
		const bakes = [
			{ emailApiUrl: EMAIL, facilitatorUrl: FACILITATOR },
			{ emailApiUrl: "api.email.example.com", facilitatorUrl: "not a url at all" },
			{ emailApiUrl: "", facilitatorUrl: FACILITATOR },
		];
		for (const baked of bakes) {
			const granted = resolveAllowedHosts(baked);
			const resolved = resolveInProcessEgress(baked);
			for (const url of [resolved.emailApiUrl, resolved.facilitatorUrl]) {
				if (url === undefined) continue;
				expect(granted).toContain(new URL(url).hostname);
			}
		}
	});
});
