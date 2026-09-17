/**
 * Manifest compile-time override (site task D4): a deploying site injects
 * the real commerce-service URL into the plugin bundle via a Vite `define`
 * of `__OTTA_COMMERCE_SERVICE_URL__`; without the define (plain tsdown
 * build, sandbox harness, this vitest run) the placeholder must survive
 * unchanged. The resolution is a pure exported function so both branches
 * are unit-testable — no bundler in the loop.
 */
import { describe, expect, test } from "vitest";
import {
	ALLOWED_HOSTS,
	COMMERCE_SERVICE_BASE_URL,
	resolveAllowedHosts,
	resolveCommerceServiceBaseUrl,
	resolveInProcessEgress,
	STRIPE_API_HOST,
} from "../src/manifest.js";

const PLACEHOLDER = "https://commerce.otta.internal";

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

/**
 * INC-C3 — the per-mode egress allowlist, asserted as an EXACT SET.
 *
 * `toContain` is deliberately avoided throughout: it catches neither a host
 * that went missing (checkout silently stops reaching Stripe) nor a host that
 * leaked in (the ADR-0006 gate quietly widened). Both are the failures this
 * list exists to prevent, so every assertion here compares the whole sorted
 * array.
 */
/** Order-insensitive EXACT comparison: `toEqual` on both sides sorted catches a
 *  missing host AND a leaked extra one, which `toContain` cannot. */
const sorted = (hosts: readonly string[]): string[] => [...hosts].toSorted();

describe("resolveAllowedHosts — the per-mode egress sets, EXACTLY", () => {
	const SERVICE = "https://svc.example.com";
	const EMAIL = "https://api.email.example.com/v1/send";
	const FACILITATOR = "https://facilitator.example.com";

	test('"http" mode is EXACTLY the commerce service host — payments stay in the service', () => {
		expect(resolveAllowedHosts("http", SERVICE)).toEqual(["svc.example.com"]);
	});

	test('"http" mode ignores the in-process egress URLs entirely', () => {
		// The site may bake the email/facilitator defines unconditionally; in http
		// mode the service makes those calls, so the plugin must NOT be granted
		// them. Same input, same single-host answer.
		expect(
			resolveAllowedHosts("http", SERVICE, { emailApiUrl: EMAIL, facilitatorUrl: FACILITATOR }),
		).toEqual(["svc.example.com"]);
	});

	test('"in-process" mode is EXACTLY Stripe + email + facilitator, and NOT the service', () => {
		const hosts = resolveAllowedHosts("in-process", SERVICE, {
			emailApiUrl: EMAIL,
			facilitatorUrl: FACILITATOR,
		});
		expect(sorted(hosts)).toEqual(
			sorted([STRIPE_API_HOST, "api.email.example.com", "facilitator.example.com"]),
		);
		// The service host is GONE — that is the whole point of the fold-in.
		expect(hosts).not.toContain("svc.example.com");
	});

	test('"in-process" mode with nothing else configured is EXACTLY the Stripe API host', () => {
		// Stripe is the one host the in-process plugin always talks to itself
		// (`paymentIntents.create` / refunds). Email and the facilitator are
		// deployment-supplied, so an unconfigured deployment gets no egress for
		// them — absent, never a wildcard.
		expect(resolveAllowedHosts("in-process", SERVICE)).toEqual([STRIPE_API_HOST]);
	});

	test("STRIPE_API_HOST is the API host, never the browser-side Stripe.js host", () => {
		// `sandbox-clean-guard.test.ts` pins js.stripe.com's ABSENCE: Stripe.js runs
		// in the buyer's browser and is not plugin egress. api.stripe.com is the
		// server-side call the folded-in gateway makes, and is a different thing.
		expect(STRIPE_API_HOST).toBe("api.stripe.com");
		expect(resolveAllowedHosts("in-process", SERVICE)).not.toContain("js.stripe.com");
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
		expect(resolveAllowedHosts("in-process", SERVICE, { emailApiUrl: value })).toEqual([
			STRIPE_API_HOST,
		]);
	});

	test("duplicate hosts collapse — the list is a SET, not a bag", () => {
		expect(
			resolveAllowedHosts("in-process", SERVICE, {
				emailApiUrl: "https://api.stripe.com/mail",
				facilitatorUrl: "https://api.stripe.com/x402",
			}),
		).toEqual([STRIPE_API_HOST]);
	});
});

describe("resolveInProcessEgress — the CONSUMERS see the same arm the gate does", () => {
	const SERVICE = "https://svc.example.com";
	const EMAIL = "https://api.email.example.com/v1/send";
	const FACILITATOR = "https://facilitator.example.com";

	test('"http" mode resolves to NO egress URLs, whatever was baked', () => {
		// The bug this closes: `resolveAllowedHosts` ignores these URLs on the http
		// arm, but the cron sweep read the RAW define and built a live sender from
		// it. The first bundle built with an email URL while still on the http arm
		// would have pointed a real sender at a host the gate refuses — every send
		// failing, rows rescheduling and eventually parking `failed`, and the leg
		// reporting `count: 0` instead of the honest `skipped`. One resolver, so
		// the gate and every caller cannot disagree by construction.
		expect(
			resolveInProcessEgress("http", { emailApiUrl: EMAIL, facilitatorUrl: FACILITATOR }),
		).toEqual({});
	});

	test('"in-process" mode passes the baked URLs through unchanged', () => {
		expect(
			resolveInProcessEgress("in-process", { emailApiUrl: EMAIL, facilitatorUrl: FACILITATOR }),
		).toEqual({ emailApiUrl: EMAIL, facilitatorUrl: FACILITATOR });
	});

	test("every host the resolved egress names is a host the gate grants", () => {
		// The invariant stated as one assertion, over both arms: a consumer can
		// never hold a URL whose host is absent from ALLOWED_HOSTS.
		for (const mode of ["http", "in-process"] as const) {
			const granted = resolveAllowedHosts(mode, SERVICE, {
				emailApiUrl: EMAIL,
				facilitatorUrl: FACILITATOR,
			});
			const resolved = resolveInProcessEgress(mode, {
				emailApiUrl: EMAIL,
				facilitatorUrl: FACILITATOR,
			});
			for (const url of [resolved.emailApiUrl, resolved.facilitatorUrl]) {
				if (url === undefined) continue;
				expect(granted).toContain(new URL(url).hostname);
			}
		}
	});
});
