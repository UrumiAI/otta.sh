/**
 * The build-time email binding guard (ADR-0043): OTTA_EMAIL_FROM set requires
 * `send_email` with name "EMAIL" in the wrangler config the build uses, because
 * a selected provider with no binding burns counted attempts on every email.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	assertEmailBindingDeclared,
	assertEmailBindingForBuild,
} from "../src/lib/email-binding.js";
import { buildEmdashOptions } from "../src/emdash-options.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const WITH_BINDING = `// my store
{
	"name": "shop", // the Worker
	/* block comment */
	"send_email": [{ "name": "EMAIL" },],
}`;

const binding = (extra: string) => `{ "send_email": [{ "name": "EMAIL", ${extra} }] }`;

describe("assertEmailBindingDeclared", () => {
	test("an EMAIL send_email binding passes (comments and trailing commas tolerated)", () => {
		expect(() => assertEmailBindingDeclared(WITH_BINDING, "wrangler.local.jsonc")).not.toThrow();
	});

	const SENDER = "store@example.com";

	test.each([
		["destination_address", `"destination_address": "ops@example.com"`],
		["allowed_destination_addresses", `"allowed_destination_addresses": ["ops@example.com"]`],
	])("a binding with %s is refused (it blocks sends to buyers)", (key, extra) => {
		expect(() =>
			assertEmailBindingDeclared(binding(extra), "wrangler.local.jsonc", SENDER),
		).toThrow(new RegExp(`wrangler\\.local\\.jsonc.*${key}`, "s"));
	});

	test("allowed_sender_addresses must contain the sender (case-insensitive)", () => {
		const ok = binding(`"allowed_sender_addresses": ["Store@Example.com"]`);
		expect(() => assertEmailBindingDeclared(ok, "w.jsonc", SENDER)).not.toThrow();
		expect(() =>
			assertEmailBindingDeclared(ok, "w.jsonc", { email: SENDER, name: "Acme" }),
		).not.toThrow();
		const other = binding(`"allowed_sender_addresses": ["other@example.com"]`);
		expect(() => assertEmailBindingDeclared(other, "w.jsonc", SENDER)).toThrow(
			/allowed_sender_addresses.*store@example\.com/s,
		);
		// Cannot verify without a sender: refused rather than assumed.
		expect(() => assertEmailBindingDeclared(ok, "w.jsonc")).toThrow(/allowed_sender_addresses/);
	});

	test.each([
		["no send_email key", `{ "name": "shop" }`],
		["an empty list", `{ "send_email": [] }`],
		["another binding name", `{ "send_email": [{ "name": "MAILER" }] }`],
		["a commented-out binding", `{\n // "send_email": [{ "name": "EMAIL" }],\n "name": "x" }`],
		["a non-array", `{ "send_email": { "name": "EMAIL" } }`],
		["an empty document", ``],
	])("%s is refused, naming the file and the binding", (_n, text) => {
		expect(() => assertEmailBindingDeclared(text || "{}", "wrangler.local.jsonc")).toThrow(
			/OTTA_EMAIL_FROM.*wrangler\.local\.jsonc.*"EMAIL"/s,
		);
	});

	test("an unparseable file is refused naming the file", () => {
		expect(() => assertEmailBindingDeclared("{ nope", "wrangler.local.jsonc")).toThrow(
			/wrangler\.local\.jsonc could not be parsed/,
		);
	});

	test("the tracked template is refused (opt-in) until the block is uncommented", () => {
		const template = readFileSync(path.resolve(HERE, "../wrangler.jsonc"), "utf8");
		expect(() => assertEmailBindingDeclared(template, "wrangler.jsonc")).toThrow(/wrangler\.jsonc/);
	});
});

describe("assertEmailBindingForBuild (select + read + guard, fixture-driven)", () => {
	const SENDER = "store@example.com";
	const template = readFileSync(path.resolve(HERE, "../wrangler.jsonc"), "utf8");
	const withBinding = template.replace(/^(\s*)\/\/\s*("send_email")/m, "$1$2");

	test("no sender: nothing is checked", () => {
		expect(assertEmailBindingForBuild(undefined, { templateText: template })).toBeUndefined();
	});

	test("sender + template without the binding: refused, naming wrangler.jsonc", () => {
		expect(() => assertEmailBindingForBuild(SENDER, { templateText: template })).toThrow(
			/wrangler\.jsonc declares no send_email/,
		);
	});

	test("a local file wins over the template, in both directions", () => {
		expect(() =>
			assertEmailBindingForBuild(SENDER, { templateText: withBinding, localText: "{}" }),
		).toThrow(/wrangler\.local\.jsonc declares no send_email/);
		expect(
			assertEmailBindingForBuild(SENDER, { templateText: template, localText: withBinding }),
		).toBe("wrangler.local.jsonc");
	});

	test("happy path: valid sender + binding passes and the provider is registered", () => {
		expect(assertEmailBindingForBuild(SENDER, { templateText: withBinding })).toBe(
			"wrangler.jsonc",
		);
		expect(buildEmdashOptions({}, SENDER).plugins.map((p) => p.id)).toContain("cloudflare-email");
	});
});
