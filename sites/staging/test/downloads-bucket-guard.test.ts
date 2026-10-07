/**
 * The build-time downloads-bucket guard (issue #376, increment 3): the wrangler
 * config the build actually uses must never point `DOWNLOADS` at the same bucket
 * as `MEDIA`.
 *
 * WHY A BUILD GUARD AND NOT ONLY THE CONFIG TEST. `wrangler-config.test.ts` pins
 * the tracked TEMPLATE. A deployment builds from its own gitignored
 * `wrangler.local.jsonc` (astro.config.ts selects it), which no test sees. EmDash
 * serves every key in the `MEDIA` bucket at `/_emdash/api/media/file/<key>` with
 * no auth, so a local config that names the media bucket for `DOWNLOADS` would
 * publish every paid file to anyone who learns its key — and nothing would fail
 * at deploy time. So the build refuses the pair instead, naming the file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	assertDownloadsBucketPrivate,
	DOWNLOADS_BINDING,
	r2BucketScopes,
} from "../src/lib/downloads-bucket.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(path.resolve(HERE, "..", relative), "utf8");

/** A local copy with comments (one with `//` inside a string), trailing commas,
 *  and two distinct buckets. */
const GOOD_LOCAL = `// my store
{
	"name": "shop", // the Worker
	"routes": [{ "pattern": "https://shop.example.com/*" }],
	/* block comment */
	"r2_buckets": [
		{ "binding": "MEDIA", "bucket_name": "shop-media", },
		{ "binding": "DOWNLOADS", "bucket_name": "shop-downloads" },
	],
}`;

const SAME_BUCKET = GOOD_LOCAL.replace('"shop-downloads"', '"shop-media"');

describe("assertDownloadsBucketPrivate", () => {
	test("two different buckets pass", () => {
		expect(() => assertDownloadsBucketPrivate(GOOD_LOCAL, "wrangler.local.jsonc")).not.toThrow();
	});

	test("DOWNLOADS on the MEDIA bucket is refused, naming the file and both bindings", () => {
		expect(() => assertDownloadsBucketPrivate(SAME_BUCKET, "wrangler.local.jsonc")).toThrow(
			/wrangler\.local\.jsonc.*"DOWNLOADS".*"shop-media".*"MEDIA"/s,
		);
	});

	test("a shared PREVIEW bucket is refused too — `wrangler dev --remote` would serve it publicly", () => {
		const text = `{
	"r2_buckets": [
		{ "binding": "MEDIA", "bucket_name": "m", "preview_bucket_name": "shared" },
		{ "binding": "DOWNLOADS", "bucket_name": "d", "preview_bucket_name": "shared" }
	]
}`;
		expect(() => assertDownloadsBucketPrivate(text, "wrangler.local.jsonc")).toThrow(/"shared"/);
	});

	test("DOWNLOADS' preview bucket naming MEDIA's real bucket is refused", () => {
		const text = `{
	"r2_buckets": [
		{ "binding": "MEDIA", "bucket_name": "m" },
		{ "binding": "DOWNLOADS", "bucket_name": "d", "preview_bucket_name": "m" }
	]
}`;
		expect(() => assertDownloadsBucketPrivate(text, "x.jsonc")).toThrow(/"m"/);
	});

	test("EVERY entry counts: a second DOWNLOADS, or a second MEDIA, cannot hide the clash", () => {
		const secondDownloads = `{
	"r2_buckets": [
		{ "binding": "MEDIA", "bucket_name": "m" },
		{ "binding": "DOWNLOADS", "bucket_name": "d" },
		{ "binding": "DOWNLOADS", "bucket_name": "m" }
	]
}`;
		expect(() => assertDownloadsBucketPrivate(secondDownloads, "x.jsonc")).toThrow(/"m"/);
		const secondMedia = `{
	"r2_buckets": [
		{ "binding": "MEDIA", "bucket_name": "m" },
		{ "binding": "MEDIA", "bucket_name": "d" },
		{ "binding": "DOWNLOADS", "bucket_name": "d" }
	]
}`;
		expect(() => assertDownloadsBucketPrivate(secondMedia, "x.jsonc")).toThrow(/"d"/);
	});

	test("an env block is checked on its own (r2_buckets do not inherit), and named", () => {
		const text = `{
	"r2_buckets": [
		{ "binding": "MEDIA", "bucket_name": "m" },
		{ "binding": "DOWNLOADS", "bucket_name": "d" }
	],
	"env": {
		"staging": {
			"r2_buckets": [
				{ "binding": "MEDIA", "bucket_name": "s-media" },
				{ "binding": "DOWNLOADS", "bucket_name": "s-media" }
			]
		}
	}
}`;
		expect(() => assertDownloadsBucketPrivate(text, "wrangler.local.jsonc")).toThrow(
			/wrangler\.local\.jsonc \(env\.staging\)/,
		);
	});

	test("no DOWNLOADS binding is not a build error — downloads are simply off (the endpoint 404s)", () => {
		const text = `{ "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "m" }] }`;
		expect(() => assertDownloadsBucketPrivate(text, "x.jsonc")).not.toThrow();
		expect(() => assertDownloadsBucketPrivate(`{}`, "x.jsonc")).not.toThrow();
	});

	test("a bucket's name in a comment does not count", () => {
		const text = `{
	// DOWNLOADS used to be "m" here
	"r2_buckets": [
		{ "binding": "MEDIA", "bucket_name": "m" },
		{ "binding": "DOWNLOADS", "bucket_name": "d" }
	]
}`;
		expect(() => assertDownloadsBucketPrivate(text, "x.jsonc")).not.toThrow();
	});

	test("a leading BOM is stripped; an unparsable file throws naming the file", () => {
		expect(() =>
			assertDownloadsBucketPrivate(`﻿${GOOD_LOCAL}`, "wrangler.local.jsonc"),
		).not.toThrow();
		expect(() => assertDownloadsBucketPrivate(`{ "r2_buckets": [`, "wrangler.local.jsonc")).toThrow(
			/wrangler\.local\.jsonc could not be parsed/,
		);
	});
});

describe("r2BucketScopes", () => {
	test("reads the top level and each env block's buckets by binding", () => {
		const text = `{
	"r2_buckets": [{ "binding": "DOWNLOADS", "bucket_name": "d" }],
	"env": { "prod": { "r2_buckets": [{ "binding": "DOWNLOADS", "bucket_name": "p" }] } }
}`;
		expect(r2BucketScopes(text, "x.jsonc")).toEqual([
			{ scope: "", buckets: [{ binding: DOWNLOADS_BINDING, bucket_name: "d" }] },
			{ scope: "env.prod", buckets: [{ binding: DOWNLOADS_BINDING, bucket_name: "p" }] },
		]);
	});
});

describe("the tracked template, and the build wiring", () => {
	test("the template passes its own guard", () => {
		expect(() =>
			assertDownloadsBucketPrivate(read("wrangler.jsonc"), "wrangler.jsonc"),
		).not.toThrow();
	});

	test("astro.config.ts runs the guard on the wrangler file the BUILD selects", () => {
		const config = read("astro.config.ts");
		expect(config).toMatch(
			/import \{ assertDownloadsBucketPrivate \} from "\.\/src\/lib\/downloads-bucket\.js";/,
		);
		// The local file when it exists, else the template — the same choice the
		// adapter's `configPath` makes.
		expect(config).toMatch(
			/const selectedWranglerConfig = localWranglerConfig \?\? "wrangler\.jsonc";/,
		);
		expect(config).toMatch(
			/assertDownloadsBucketPrivate\(\s*readFileSync\(new URL\(selectedWranglerConfig, import\.meta\.url\), "utf8"\),\s*selectedWranglerConfig,?\s*\);/,
		);
	});
});
