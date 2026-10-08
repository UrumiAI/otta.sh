/**
 * `resolveAllowedHosts` / `resolveInProcessEgress` — the plugin's egress
 * allowlist and the matching consumer-facing URLs, as pure functions so both
 * are unit-testable without a bundler (§5).
 *
 * INC-D3a retired the http/in-process mode branch: there is ONE list now, the
 * commerce service is gone, and `resolveAllowedHosts` no longer takes a mode
 * or a service base URL — it is always Stripe's API host plus the
 * deployment-supplied facilitator URL when it parses to a hostname. ADR-0031
 * removed every email host: email goes through `ctx.email`, never `ctx.http`.
 */
import { describe, expect, test } from "vitest";
import {
	ALLOWED_HOSTS,
	IN_PROCESS_EGRESS_URLS,
	normalizeExtraHost,
	OTTA_PLUGIN_CAPABILITIES,
	parseExtraAllowedHosts,
	resolveAllowedHosts,
	resolveInProcessEgress,
	STRIPE_API_HOST,
} from "../src/manifest.js";

/** The hosts granted in EVERY build: Stripe's API, and nothing else. */
const BASELINE = [STRIPE_API_HOST];

/** Order-insensitive EXACT comparison: `toEqual` on both sides sorted catches a
 *  missing host AND a leaked extra one, which `toContain` cannot. */
const sorted = (hosts: readonly string[]): string[] => [...hosts].toSorted();

describe("resolveAllowedHosts — the egress set, EXACTLY", () => {
	const FACILITATOR = "https://facilitator.example.com";

	test("with nothing configured, EXACTLY the Stripe API host", () => {
		// Stripe is the one host the in-process plugin always talks to itself
		// (`paymentIntents.create` / refunds). The facilitator is deployment-supplied,
		// so an unconfigured deployment gets no egress for it — absent, never a
		// wildcard. No email host at all (ADR-0031).
		expect(resolveAllowedHosts()).toEqual(BASELINE);
		expect(resolveAllowedHosts({})).toEqual(BASELINE);
	});

	test("EXACTLY Stripe + facilitator once the facilitator is configured", () => {
		const hosts = resolveAllowedHosts({ facilitatorUrl: FACILITATOR });
		expect(sorted(hosts)).toEqual(sorted([...BASELINE, "facilitator.example.com"]));
	});

	test("no email vendor host is ever granted (ADR-0031: email is ctx.email)", () => {
		for (const host of resolveAllowedHosts({ facilitatorUrl: FACILITATOR })) {
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

	test.each([
		["an empty string", ""],
		["undefined", undefined],
		["a non-URL", "not a url"],
		["a bare hostname with no scheme", "facilitator.example.com"],
	])("FAIL-CLOSED: %s for the facilitator URL grants NO host", (_why, value) => {
		// An unparseable define must not throw at module load (it would take the
		// whole plugin down) and must not silently widen the gate. It grants
		// nothing, which surfaces as a refused fetch — a legible failure.
		expect(resolveAllowedHosts({ facilitatorUrl: value })).toEqual(BASELINE);
	});

	test("duplicate hosts collapse — the list is a SET, not a bag", () => {
		expect(resolveAllowedHosts({ facilitatorUrl: "https://api.stripe.com/x402" })).toEqual(
			BASELINE,
		);
	});
});

describe("ALLOWED_HOSTS / IN_PROCESS_EGRESS_URLS — the resolved constants for THIS bundle", () => {
	test("this un-defined build (no bundler define) resolves to the baseline allowlist", () => {
		// vitest bundles without `__OTTA_X402_FACILITATOR_URL__`, so the
		// module-level constants must reflect an unconfigured deployment.
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
	const FACILITATOR = "https://facilitator.example.com";

	test("passes a baked URL through unchanged when it parses", () => {
		expect(resolveInProcessEgress({ facilitatorUrl: FACILITATOR })).toEqual({
			facilitatorUrl: FACILITATOR,
		});
	});

	test("an UNPARSEABLE define grants no host, so it resolves to no egress either", () => {
		// `resolveAllowedHosts` drops anything `hostnameOf` cannot parse — a bare
		// hostname, an empty define, garbage — so passing such a URL through
		// verbatim would hand a consumer a URL the gate refuses.
		expect(resolveInProcessEgress({ facilitatorUrl: "not a url at all" })).toEqual({});
		expect(resolveInProcessEgress({ facilitatorUrl: "" })).toEqual({});
	});

	test("every host the resolved egress names is a host the gate grants", () => {
		// The invariant stated as one assertion, over defines that do not parse
		// too: a consumer can never hold a URL whose host is absent from
		// ALLOWED_HOSTS. One resolver, so the gate and every caller cannot
		// disagree by construction.
		const bakes = [
			{ facilitatorUrl: FACILITATOR },
			{ facilitatorUrl: "not a url at all" },
			{ facilitatorUrl: "" },
		];
		for (const baked of bakes) {
			const granted = resolveAllowedHosts(baked);
			const url = resolveInProcessEgress(baked).facilitatorUrl;
			if (url === undefined) continue;
			expect(granted).toContain(new URL(url).hostname);
		}
	});
});

describe("extraAllowedHosts (OTTA_EXTRA_ALLOWED_HOSTS)", () => {
	const FACILITATOR = "https://facilitator.example.com";

	test("valid extras are appended after Stripe and the facilitator, in given order", () => {
		expect(
			resolveAllowedHosts({
				facilitatorUrl: FACILITATOR,
				extraAllowedHosts: "b.example.org, A.Example.com ,c-d.example.net",
			}),
		).toEqual([
			"api.stripe.com",
			"facilitator.example.com",
			"b.example.org",
			"a.example.com",
			"c-d.example.net",
		]);
	});

	test("accepts an array, trims, lowercases, drops empty entries", () => {
		expect(resolveAllowedHosts({ extraAllowedHosts: [" X.Example.com ", "", "  "] })).toEqual([
			...BASELINE,
			"x.example.com",
		]);
		expect(resolveAllowedHosts({ extraAllowedHosts: ",, ," })).toEqual(BASELINE);
		expect(resolveAllowedHosts({ extraAllowedHosts: "" })).toEqual(BASELINE);
	});

	test("duplicates collapse, including against the fixed hosts", () => {
		expect(
			resolveAllowedHosts({
				facilitatorUrl: FACILITATOR,
				extraAllowedHosts: "x.example.com,X.EXAMPLE.COM,api.stripe.com,facilitator.example.com",
			}),
		).toEqual(["api.stripe.com", "facilitator.example.com", "x.example.com"]);
	});

	test.each([
		["wildcard", "*"],
		["wildcard subdomain", "*.example.com"],
		["inner wildcard", "a.*.example.com"],
		["IPv4 literal", "192.168.1.1"],
		["public IPv4 literal", "8.8.8.8"],
		["IPv6 literal", "::1"],
		["bracketed IPv6", "[::1]"],
		["localhost", "localhost"],
		["subdomain of localhost", "app.localhost"],
		["single label", "intranet"],
		["scheme", "https://api.example.com"],
		["port", "api.example.com:8443"],
		["path", "api.example.com/v1"],
		["userinfo", "user@api.example.com"],
		["leading hyphen label", "-a.example.com"],
		["trailing hyphen label", "a-.example.com"],
		["empty label", "a..example.com"],
		["trailing dot", "example.com."],
		["underscore", "a_b.example.com"],
		["whitespace inside", "a b.example.com"],
		["hex IPv4 (127.0.0.1)", "0x7f.0.0.0x1"],
		["mixed hex IPv4 (1.2.3.4)", "1.2.3.0x4"],
		["two-label hex IPv4", "0x7f.0x1"],
		["hex last label", "a.0x10"],
		["empty-hex last label", "a.b.c.0x"],
		["single-hex IPv4 form", "0x7f000001.0x0"],
		["IDNA-invalid xn-- label", "xn--localhost.com"],
	])("REJECTED (%s): %s", (_why, entry) => {
		expect(normalizeExtraHost(entry)).toBeUndefined();
		// resolveAllowedHosts stays fail-closed and never throws...
		expect(resolveAllowedHosts({ extraAllowedHosts: entry })).toEqual(BASELINE);
		// ...while the build-time validator is loud and names the entry.
		expect(() => parseExtraAllowedHosts(`ok.example.com, ${entry}`)).toThrow(
			/OTTA_EXTRA_ALLOWED_HOSTS: invalid entry/,
		);
	});

	test("the build-time error names the offending entry", () => {
		expect(() => parseExtraAllowedHosts("good.example.com,*.bad.com")).toThrow(/"\*\.bad\.com"/);
	});

	test("one invalid entry in the list does not widen or poison the valid ones in resolveAllowedHosts", () => {
		expect(resolveAllowedHosts({ extraAllowedHosts: "good.example.com,*,10.0.0.1" })).toEqual([
			...BASELINE,
			"good.example.com",
		]);
	});

	test("parseExtraAllowedHosts normalizes, dedupes, keeps order; unset gives []", () => {
		expect(parseExtraAllowedHosts(undefined)).toEqual([]);
		expect(parseExtraAllowedHosts(" ")).toEqual([]);
		expect(parseExtraAllowedHosts("B.example.com, a.example.com,b.example.com")).toEqual([
			"b.example.com",
			"a.example.com",
		]);
	});

	test("capabilities are untouched: never network:request:unrestricted", () => {
		expect([...OTTA_PLUGIN_CAPABILITIES]).not.toContain("network:request:unrestricted");
	});
});
