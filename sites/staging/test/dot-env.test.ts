/**
 * .env parser guard (review item 6): astro.config.ts falls back to
 * sites/staging/.env for COMMERCE_SERVICE_URL because Astro does NOT load
 * .env into process.env for the config module (verified: an .env-only
 * value never reached the define/allowedHosts). This pins the tiny parser
 * that closes that gap.
 */
import { describe, expect, test } from "vitest";
import { parseDotEnv } from "../src/lib/dot-env.js";

describe("parseDotEnv", () => {
	test("parses KEY=VALUE, comments, blanks, quotes", () => {
		const parsed = parseDotEnv(
			[
				"# comment",
				"",
				"COMMERCE_SERVICE_URL=http://127.0.0.1:3000",
				'QUOTED="https://svc.example.com"',
				"SINGLE='v'",
				"SPACED = padded ",
				"not-a-key=x",
				"=novalue",
			].join("\n"),
		);
		expect(parsed).toEqual({
			COMMERCE_SERVICE_URL: "http://127.0.0.1:3000",
			QUOTED: "https://svc.example.com",
			SINGLE: "v",
			SPACED: "padded",
		});
	});

	test("last occurrence wins", () => {
		expect(parseDotEnv("A=1\nA=2")).toEqual({ A: "2" });
	});
});
