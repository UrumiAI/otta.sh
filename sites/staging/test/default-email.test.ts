/**
 * The reference site's default email provider (ADR-0043). Core ships no email
 * vendor code (ADR-0031); the SITE registers EmDash's first-party
 * `cloudflareEmail` provider when `OTTA_EMAIL_FROM` is set at build time, and
 * registers nothing otherwise (fail-closed "no provider").
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildEmdashOptions } from "../src/emdash-options.js";
import { assertEmailBindingDeclared } from "../src/lib/email-binding.js";
import { parseEmailFrom } from "../src/lib/email-from.js";
import { parseWrangler } from "../src/lib/wrangler-jsonc.js";
import { buildPlaygroundEmdashOptions } from "../src/playground-options.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_IMPORT_TIMEOUT_MS = 60_000;

describe("parseEmailFrom", () => {
	test("unset, empty and blank mean no provider", () => {
		expect(parseEmailFrom(undefined, undefined)).toBeUndefined();
		expect(parseEmailFrom("", undefined)).toBeUndefined();
		expect(parseEmailFrom("   ", undefined)).toBeUndefined();
	});

	test("a plain address is returned trimmed", () => {
		expect(parseEmailFrom(" store@example.com ", undefined)).toEqual("store@example.com");
	});

	test("apostrophes, plus tags and inner dots are valid (ASCII dot-atom)", () => {
		for (const ok of ["o'brien@example.com", "a.b+tag@mail.example.co.uk", "x_y-z@example.com"]) {
			expect(parseEmailFrom(ok, undefined)).toEqual(ok);
		}
	});

	test("the error says the address must be ASCII", () => {
		expect(() => parseEmailFrom("störe@example.com", undefined)).toThrow(/ASCII/);
	});

	test("a display name makes it { email, name }", () => {
		expect(parseEmailFrom("store@example.com", " Acme Goods ")).toEqual({
			email: "store@example.com",
			name: "Acme Goods",
		});
		expect(parseEmailFrom("store@example.com", "  ")).toEqual("store@example.com");
	});

	test.each([
		"store",
		"@example.com",
		"store@",
		"store@example",
		"a b@example.com",
		"Store <store@example.com>",
		"a@b@example.com",
		"store@example.com\r\nBcc: x@evil.com",
		"st\u0001ore@example.com",
		"store\u007f@example.com",
		".store@example.com",
		"store.@example.com",
		"sto..re@example.com",
		"störe@example.com",
		"store@exämple.com",
		"store@-example.com",
		"store@example..com",
	])("a malformed address %j throws, naming OTTA_EMAIL_FROM", (bad) => {
		expect(() => parseEmailFrom(bad, undefined)).toThrow(/OTTA_EMAIL_FROM/);
	});

	test.each(["Acme <x>", "Acme\r\nBcc: x@evil.com", 'Ac"me'])(
		"a malformed display name %j throws, naming OTTA_EMAIL_FROM_NAME",
		(bad) => {
			expect(() => parseEmailFrom("store@example.com", bad)).toThrow(/OTTA_EMAIL_FROM_NAME/);
		},
	);

	test("a name without an address is an error, not a silent no-provider", () => {
		expect(() => parseEmailFrom(undefined, "Acme")).toThrow(
			/OTTA_EMAIL_FROM_NAME.*OTTA_EMAIL_FROM/,
		);
	});
});

describe("buildEmdashOptions email provider", () => {
	test("unset: exactly [otta, otta-console], no email provider (as before)", () => {
		expect(buildEmdashOptions().plugins.map((p) => p.id)).toEqual(["otta", "otta-console"]);
		expect(buildEmdashOptions({}, undefined).plugins.map((p) => p.id)).toEqual([
			"otta",
			"otta-console",
		]);
	});

	test("set: cloudflare-email is APPENDED; plugins[0] is still the Otta descriptor", () => {
		const plugins = buildEmdashOptions({}, "store@example.com").plugins;
		expect(plugins.map((p) => p.id)).toEqual(["otta", "otta-console", "cloudflare-email"]);
		expect(plugins[0]).toEqual(buildEmdashOptions().plugins[0]);
	});

	test("set: the descriptor is EmDash's own, bound to EMAIL, with the given sender", () => {
		const d = buildEmdashOptions({}, "store@example.com").plugins[2];
		expect(d).toMatchObject({
			entrypoint: "@emdash-cms/cloudflare/plugins/cloudflare-email",
			format: "native",
			options: { from: "store@example.com", binding: "EMAIL" },
			capabilities: ["hooks.email-transport:register"],
		});
	});

	test("a { email, name } sender is passed through", () => {
		const d = buildEmdashOptions({}, { email: "store@example.com", name: "Acme" }).plugins[2];
		expect(d?.options).toMatchObject({ from: { email: "store@example.com", name: "Acme" } });
	});

	test("the email provider adds no allowed host to Otta (ADR-0031)", () => {
		expect(buildEmdashOptions({}, "store@example.com").plugins[0]?.allowedHosts).toEqual(
			buildEmdashOptions().plugins[0]?.allowedHosts,
		);
	});
});

describe("the playground gets NO default email (it is disposable)", () => {
	test("buildPlaygroundEmdashOptions never registers cloudflare-email", () => {
		expect(buildPlaygroundEmdashOptions().plugins.map((p) => p.id)).toEqual([
			"otta",
			"otta-console",
		]);
	});

	test("astro.config.playground.ts does not read OTTA_EMAIL_FROM", () => {
		const src = readFileSync(path.join(root, "astro.config.playground.ts"), "utf8");
		expect(src).not.toMatch(/OTTA_EMAIL_FROM/);
		const opts = readFileSync(path.join(root, "src/playground-options.ts"), "utf8");
		expect(opts).not.toMatch(/OTTA_EMAIL_FROM|cloudflareEmail/);
	});

	test("wrangler.playground.jsonc declares no send_email binding", () => {
		const cfg = parseWrangler(
			readFileSync(path.join(root, "wrangler.playground.jsonc"), "utf8"),
			"wrangler.playground.jsonc",
			"send_email",
		);
		expect(cfg).not.toHaveProperty("send_email");
	});
});

describe("wrangler.jsonc template", () => {
	const cfg = parseWrangler(
		readFileSync(path.join(root, "wrangler.jsonc"), "utf8"),
		"wrangler.jsonc",
		"send_email",
	);

	test("send_email is OPT-IN: not active in the template (ADR-0043)", () => {
		expect(cfg).not.toHaveProperty("send_email");
	});

	test("the commented opt-in block names the EMAIL binding and OTTA_EMAIL_FROM", () => {
		const raw = readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
		expect(raw).toMatch(/^\s*\/\/\s*"send_email": \[\{ "name": "EMAIL" \}\],\s*$/m);
		expect(raw).toMatch(/OTTA_EMAIL_FROM/);
		// Uncommenting it yields exactly an unrestricted binding the guard accepts.
		const uncommented = raw.replace(/^(\s*)\/\/\s*("send_email")/m, "$1$2");
		expect(() => assertEmailBindingDeclared(uncommented, "wrangler.jsonc")).not.toThrow();
		expect(parseWrangler(uncommented, "wrangler.jsonc", "send_email")["send_email"]).toEqual([
			{ name: "EMAIL" },
		]);
	});

	test("the sender address is not a vars entry (build-time, and not a secret)", () => {
		expect(JSON.stringify(cfg["vars"] ?? {})).not.toMatch(/OTTA_EMAIL_FROM/);
	});
});

describe("OTTA_EMAIL_FROM at config load", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	test(
		"a malformed value makes loading the site config THROW",
		async () => {
			vi.stubEnv("OTTA_EMAIL_FROM", "not-an-address");
			vi.resetModules();
			await expect(import("../astro.config.js")).rejects.toThrow(/OTTA_EMAIL_FROM/);
		},
		CONFIG_IMPORT_TIMEOUT_MS,
	);

	// Imports the REAL config, which reads a developer's gitignored
	// wrangler.local.jsonc if there is one, so it only runs where there is none.
	// The select + read + guard logic is covered by fixtures in email-binding-guard.test.ts.
	test.skipIf(existsSync(path.join(root, "wrangler.local.jsonc")))(
		"a valid value with no send_email binding in the selected wrangler config THROWS",
		async () => {
			vi.stubEnv("OTTA_EMAIL_FROM", "store@example.com");
			vi.resetModules();
			// The template has no active binding, so a valid sender with no binding
			// must be refused by the build guard (selected-but-unbound burns attempts).
			await expect(import("../astro.config.js")).rejects.toThrow(
				/declares no send_email binding named "EMAIL"/,
			);
		},
		CONFIG_IMPORT_TIMEOUT_MS,
	);

	test("astro.config.ts reads both variables through the process.env-then-.env pattern", () => {
		const src = readFileSync(path.join(root, "astro.config.ts"), "utf8");
		expect(src).toMatch(/process\.env\.OTTA_EMAIL_FROM\s*\?\?\s*readDotEnv\("OTTA_EMAIL_FROM"\)/);
		expect(src).toMatch(
			/process\.env\.OTTA_EMAIL_FROM_NAME\s*\?\?\s*readDotEnv\("OTTA_EMAIL_FROM_NAME"\)/,
		);
		expect(src).toMatch(/buildEmdashOptions\(egress,\s*emailFrom\)/);
	});
});
