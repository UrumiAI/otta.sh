/**
 * The build-time email binding guard (ADR-0043): OTTA_EMAIL_FROM set requires
 * `send_email` with name "EMAIL" in the wrangler config the build uses, because
 * a selected provider with no binding burns counted attempts on every email.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { assertEmailBindingDeclared } from "../src/lib/email-binding.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const WITH_BINDING = `// my store
{
	"name": "shop", // the Worker
	/* block comment */
	"send_email": [{ "name": "EMAIL" },],
}`;

describe("assertEmailBindingDeclared", () => {
	test("an EMAIL send_email binding passes (comments and trailing commas tolerated)", () => {
		expect(() => assertEmailBindingDeclared(WITH_BINDING, "wrangler.local.jsonc")).not.toThrow();
	});

	test("a binding with restrictions still passes", () => {
		const text = `{ "send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["a@b.co"] }] }`;
		expect(() => assertEmailBindingDeclared(text, "wrangler.local.jsonc")).not.toThrow();
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
