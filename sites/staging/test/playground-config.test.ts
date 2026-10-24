/**
 * The playground build is the storefront's Otta registration on EmDash's
 * per-visitor database. It must not grow a sandbox runner (that binding is
 * the Workers Paid pivot ADR-0006 avoids) and it must not be the shared
 * staging D1.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildEmdashOptions } from "../src/emdash-options.js";
import { buildPlaygroundEmdashOptions, PLAYGROUND_DB_BINDING } from "../src/playground-options.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseJsonc(raw: string): Record<string, unknown> {
	const noComments = raw
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/([^:"])\/\/.*$/gm, "$1");
	return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
}

describe("buildPlaygroundEmdashOptions", () => {
	const options = buildPlaygroundEmdashOptions();

	test("registers the same Otta plugins as the storefront, with no sandbox", () => {
		expect(options.plugins).toEqual(buildEmdashOptions().plugins);
		expect(options).not.toHaveProperty("sandboxRunner");
		expect(options).not.toHaveProperty("sandboxed");
		expect(options.mcp).toBe(false);
	});

	test("uses the playground Durable Object, not D1", () => {
		expect(options.database).toMatchObject({
			entrypoint: "@emdash-cms/cloudflare/db/playground",
			config: { binding: PLAYGROUND_DB_BINDING },
		});
		expect(options.storage).toMatchObject({
			entrypoint: "@emdash-cms/cloudflare/db/playground",
		});
		expect(options.playground.middlewareEntrypoint).toBe(
			"@emdash-cms/cloudflare/db/playground-middleware",
		);
	});
});

describe("playground build files", () => {
	const config = parseJsonc(readFileSync(path.join(root, "wrangler.playground.jsonc"), "utf8"));

	test("the worker exports the Durable Object class and the storefront handler", () => {
		const worker = readFileSync(path.join(root, "src/playground-worker.ts"), "utf8");
		expect(worker).toContain(
			'export { EmDashPreviewDB } from "@emdash-cms/cloudflare/db/playground"',
		);
		expect(worker).toContain('export { default } from "./worker.js"');
		expect(config["main"]).toBe("./src/playground-worker.ts");
	});

	test("wrangler binds that class and no paid sandbox, and names try.otta.sh", () => {
		expect(config).not.toHaveProperty("worker_loaders");
		expect(config).not.toHaveProperty("d1_databases");
		expect(config).not.toHaveProperty("r2_buckets");
		expect(config).not.toHaveProperty("vars");
		expect(config["compatibility_flags"]).toEqual(["nodejs_compat"]);
		const objects = config["durable_objects"] as {
			bindings: { name: string; class_name: string }[];
		};
		expect(objects.bindings).toEqual([{ name: "PLAYGROUND_DB", class_name: "EmDashPreviewDB" }]);
		const migrations = config["migrations"] as { new_sqlite_classes?: string[] }[];
		expect(migrations[0]?.new_sqlite_classes).toEqual(["EmDashPreviewDB"]);
		const routes = config["routes"] as { pattern: string; custom_domain: boolean }[];
		expect(routes).toEqual([{ pattern: "try.otta.sh", custom_domain: true }]);
	});

	test("the playground config turns the flag on; the storefront config leaves it off", () => {
		const playground = readFileSync(path.join(root, "astro.config.playground.ts"), "utf8");
		const storefront = readFileSync(path.join(root, "astro.config.ts"), "utf8");
		expect(playground).toMatch(/emdash\(\s*buildPlaygroundEmdashOptions\(egress\)\s*\)/);
		expect(playground).toContain("wrangler.playground.jsonc");
		expect(playground).toContain('imageService: "passthrough"');
		expect(playground).toMatch(/__OTTA_PLAYGROUND__:\s*JSON\.stringify\(true\)/);
		expect(storefront).toMatch(/__OTTA_PLAYGROUND__:\s*JSON\.stringify\(false\)/);
		expect(storefront).toMatch(/emdash\(\s*buildEmdashOptions\(egress\)\s*\)/);
	});
});
