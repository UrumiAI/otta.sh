/**
 * The one JSONC reader both build guards share (issue #447): comments and
 * trailing commas go, a `//` inside a string stays, a BOM is tolerated, and a
 * parse error names the file and what was being checked.
 */
import { describe, expect, test } from "vitest";
import { jsoncToJson, parseWrangler } from "../src/lib/wrangler-jsonc.js";

describe("jsoncToJson", () => {
	test("drops line and block comments outside strings, keeps `//` inside one", () => {
		const text = `// head\n{ /* a */ "url": "https://x.test/a", // tail\n "n": 1, }`;
		expect(JSON.parse(jsoncToJson(text))).toEqual({ url: "https://x.test/a", n: 1 });
	});

	test("drops trailing commas before } and ]", () => {
		expect(JSON.parse(jsoncToJson(`{"a": [1, 2,], }`))).toEqual({ a: [1, 2] });
	});

	test("an escaped quote does not end a string early", () => {
		expect(JSON.parse(jsoncToJson(`{"a": "x\\" // not a comment"}`))).toEqual({
			a: 'x" // not a comment',
		});
	});
});

describe("parseWrangler", () => {
	test("strips a leading BOM", () => {
		expect(parseWrangler('﻿{"a": 1}', "w.jsonc", "its a")).toEqual({ a: 1 });
	});

	test("a non-object document reads as {}", () => {
		expect(parseWrangler("7", "w.jsonc", "its a")).toEqual({});
		expect(parseWrangler("null", "w.jsonc", "its a")).toEqual({});
	});

	test("a parse error names the file and what was being checked, and keeps its cause", () => {
		try {
			parseWrangler("{ nope", "wrangler.local.jsonc", "its r2_buckets");
			expect.unreachable();
		} catch (error) {
			expect((error as Error).message).toMatch(
				/^wrangler\.local\.jsonc could not be parsed as JSONC while checking its r2_buckets \(/,
			);
			expect((error as Error).cause).toBeInstanceOf(Error);
		}
	});
});
