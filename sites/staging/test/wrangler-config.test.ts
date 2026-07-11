/**
 * wrangler.jsonc guard (plan §3.2): the deployment config is data, so the
 * paid-plan/footgun exclusions are pinned as tests:
 *  - NO `worker_loaders` (the LOADER binding is consumed only by the
 *    sandbox runner and flips the account onto Workers Paid — ADR-0004);
 *  - the real staging resource ids (D1 urumi-cms, R2 urumi-media);
 *  - `nodejs_compat` present (required by the emdash CF stack);
 *  - NO `global_fetch_strictly_public` (deadlocks D1 session:"auto" —
 *    em-dash docs deployment/cloudflare.mdx, issue #1273);
 *  - a cron trigger (scheduled publishing needs it on Workers);
 *  - no secret-shaped keys under `vars` (secrets go via `wrangler secret`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const WRANGLER_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../wrangler.jsonc",
);

/** Minimal JSONC → JSON: strips // and both-slash block comments and
 *  trailing commas. Good enough for our own config file. */
function parseJsonc(raw: string): Record<string, unknown> {
	const noComments = raw
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/([^:"])\/\/.*$/gm, "$1");
	const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(noTrailingCommas) as Record<string, unknown>;
}

const config = parseJsonc(readFileSync(WRANGLER_PATH, "utf8"));

describe("wrangler.jsonc", () => {
	test("worker name is urumi-store-staging (must not overwrite other Workers)", () => {
		expect(config["name"]).toBe("urumi-store-staging");
	});

	test("has NO worker_loaders (no sandbox runner → no Workers Paid)", () => {
		expect(config).not.toHaveProperty("worker_loaders");
	});

	test("D1 binding DB → urumi-cms with the real database id", () => {
		expect(config["d1_databases"]).toEqual([
			{
				binding: "DB",
				database_name: "urumi-cms",
				database_id: "0a7c4962-bc2a-46cb-8c7e-8227b0f00433",
			},
		]);
	});

	test("R2 binding MEDIA → urumi-media", () => {
		expect(config["r2_buckets"]).toEqual([{ binding: "MEDIA", bucket_name: "urumi-media" }]);
	});

	test("nodejs_compat is on; global_fetch_strictly_public is absent", () => {
		const flags = config["compatibility_flags"] as string[];
		expect(flags).toContain("nodejs_compat");
		expect(flags).not.toContain("global_fetch_strictly_public");
	});

	test("cron trigger present (scheduled publishing on Workers)", () => {
		const triggers = config["triggers"] as { crons?: string[] };
		expect(triggers.crons?.length).toBeGreaterThan(0);
	});

	test("worker entry is the emdash worker re-export", () => {
		expect(config["main"]).toBe("./src/worker.ts");
	});

	test("no secret-shaped vars committed", () => {
		const vars = (config["vars"] ?? {}) as Record<string, unknown>;
		for (const key of Object.keys(vars)) {
			expect(key).not.toMatch(/SECRET|KEY|TOKEN|PASSWORD/i);
		}
	});
});
