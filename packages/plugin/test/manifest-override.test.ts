/**
 * `resolveAllowedHosts` / `parseExtraAllowedHosts` — the plugin's egress
 * allowlist and its build-time validator, as pure functions so both
 * are unit-testable without a bundler (§5).
 *
 * INC-D3a retired the http/in-process mode branch: there is ONE list now, the
 * commerce service is gone, and `resolveAllowedHosts` no longer takes a mode
 * or a service base URL — it is always Stripe's API host plus whatever the
 * deployment's egress supplies (only `OTTA_EXTRA_ALLOWED_HOSTS` today). ADR-0031 removed every email
 * host: email goes through `ctx.email`, never `ctx.http`.
 */
import { describe, expect, test } from "vitest";
import {
	ALLOWED_HOSTS,
	normalizeExtraHost,
	OTTA_PLUGIN_CAPABILITIES,
	parseExtraAllowedHosts,
	resolveAllowedHosts,
	STRIPE_API_HOST,
} from "../src/manifest.js";

/** The hosts granted in EVERY build: Stripe's API, and nothing else. */
const BASELINE = [STRIPE_API_HOST];
/** Node major in use: four tests differ on Node 26+ (#478, #489). */
const nodeMajor = Number(process.versions.node.split(".")[0]);

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

describe("ALLOWED_HOSTS — the resolved constant for THIS bundle", () => {
	test("this un-defined build (no bundler define) resolves to the baseline allowlist", () => {
		// vitest bundles without any egress define, so the module-level constants
		// must reflect an unconfigured deployment.
		expect(ALLOWED_HOSTS).toEqual(BASELINE);
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

describe("extraAllowedHosts (OTTA_EXTRA_ALLOWED_HOSTS)", () => {
	test("valid extras are appended after Stripe, in given order", () => {
		expect(
			resolveAllowedHosts({
				extraAllowedHosts: "b.example.org, A.Example.com ,c-d.example.net",
			}),
		).toEqual(["api.stripe.com", "b.example.org", "a.example.com", "c-d.example.net"]);
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
				extraAllowedHosts: "x.example.com,X.EXAMPLE.COM,api.stripe.com,y.example.com,x.example.com",
			}),
		).toEqual(["api.stripe.com", "x.example.com", "y.example.com"]);
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
		["localhost.localdomain", "localhost.localdomain"],
		[".localdomain", "box.localdomain"],
		[".local (mDNS)", "printer.local"],
		[".internal", "metadata.google.internal"],
		["home.arpa", "home.arpa"],
		[".home.arpa", "router.home.arpa"],
		[".lan", "nas.lan"],
		["nip.io", "nip.io"],
		["nip.io wildcard-IP name", "127.0.0.1.nip.io"],
		["sslip.io wildcard-IP name", "10-0-0-1.sslip.io"],
		["xip.io wildcard-IP name", "app.192.168.1.1.xip.io"],
		// #478: public names whose every subdomain resolves to 127.0.0.1.
		["localtest.me (loopback DNS)", "localtest.me"],
		["localtest.me subdomain", "app.localtest.me"],
		["lvh.me (loopback DNS)", "lvh.me"],
		["lvh.me subdomain", "shop.lvh.me"],
		["Stripe.js CDN (ADR-0012)", "js.stripe.com"],
		["other Stripe host", "files.stripe.com"],
		["bare Stripe domain", "stripe.com"],
	])("REJECTED (%s): %s", (_why, entry) => {
		expect(normalizeExtraHost(entry)).toBeUndefined();
		// resolveAllowedHosts stays fail-closed and never throws...
		expect(resolveAllowedHosts({ extraAllowedHosts: entry })).toEqual(BASELINE);
		// ...while the build-time validator is loud and names the entry.
		expect(() => parseExtraAllowedHosts(`ok.example.com, ${entry}`)).toThrow(
			/OTTA_EXTRA_ALLOWED_HOSTS: invalid entry/,
		);
	});

	// Node 26's URL parser accepts `xn--localhost.com`, so this one entry is not
	// rejected there (#478, #489). Skipped on 26+ only; it runs on 22 and 24.
	test.skipIf(nodeMajor >= 26)("REJECTED (IDNA-invalid xn-- label): xn--localhost.com", () => {
		expect(normalizeExtraHost("xn--localhost.com")).toBeUndefined();
		expect(resolveAllowedHosts({ extraAllowedHosts: "xn--localhost.com" })).toEqual(BASELINE);
		expect(() => parseExtraAllowedHosts("ok.example.com, xn--localhost.com")).toThrow(
			/OTTA_EXTRA_ALLOWED_HOSTS: invalid entry/,
		);
	});

	test("the build-time error names every offending entry", () => {
		expect(() => parseExtraAllowedHosts("good.example.com,*.bad.com,x.local")).toThrow(
			/"\*\.bad\.com", "x\.local"/,
		);
	});

	test("listing the built-in Stripe API host is a no-op, not an error", () => {
		expect(parseExtraAllowedHosts("API.stripe.com")).toEqual(["api.stripe.com"]);
		expect(resolveAllowedHosts({ extraAllowedHosts: "api.stripe.com" })).toEqual(BASELINE);
	});

	test("refused suffixes match whole labels only: look-alike public names pass", () => {
		for (const host of [
			"mylocal.com",
			"internal.example.com",
			"nip.io.example.com",
			"mylvh.me",
			"notlocaltest.me",
			"notstripe.com",
		]) {
			expect(normalizeExtraHost(host)).toBe(host);
		}
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
