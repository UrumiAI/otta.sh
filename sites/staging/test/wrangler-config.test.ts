/**
 * wrangler.jsonc guard (plan §3.2): the deployment config is data, so the
 * paid-plan/footgun exclusions are pinned as tests:
 *  - NO `worker_loaders` (the LOADER binding is consumed only by the
 *    sandbox runner and flips the account onto Workers Paid — ADR-0006);
 *  - the DB/MEDIA binding SHAPE (the tracked file is a template — real
 *    resource ids live in the gitignored wrangler.local.jsonc, so only
 *    structure is pinned, never account-specific values);
 *  - `nodejs_compat` present (required by the emdash CF stack);
 *  - `global_fetch_strictly_public` ABSENT (issue #375). It was added for the
 *    site's ctx.http calls to a commerce-service Worker on *.workers.dev,
 *    which Cloudflare otherwise blocks and stubs 404; that service and the
 *    call are gone (ADR-0020, #288), and no remaining egress targets
 *    workers.dev or this Worker's own zone. Left in, it would only keep
 *    D1 read-replica sessions unusable (every SSR request hangs, silently —
 *    emdash issue #1273). If it ever comes back, the pairing invariant in
 *    site-config.test.ts still requires D1 `session` OFF alongside it;
 * *  - a cron trigger (scheduled publishing needs it on Workers);
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
	test("worker name is a non-empty string", () => {
		// Template value ("my-otta-store") — the real name lives in the
		// gitignored wrangler.local.jsonc.
		expect(typeof config["name"]).toBe("string");
		expect((config["name"] as string).length).toBeGreaterThan(0);
	});

	test("has NO worker_loaders (no sandbox runner → no Workers Paid)", () => {
		expect(config).not.toHaveProperty("worker_loaders");
	});

	test("exactly one D1 database, bound as DB, with name+id strings", () => {
		const d1 = config["d1_databases"] as {
			binding?: string;
			database_name?: string;
			database_id?: string;
		}[];
		expect(d1).toHaveLength(1);
		expect(d1[0]?.binding).toBe("DB");
		expect(typeof d1[0]?.database_name).toBe("string");
		expect(d1[0]?.database_name?.length).toBeGreaterThan(0);
		// Placeholder must still be a syntactically-valid id so
		// `wrangler deploy --dry-run` keeps working offline.
		expect(d1[0]?.database_id).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("exactly one R2 bucket, bound as MEDIA, with a bucket name", () => {
		const r2 = config["r2_buckets"] as { binding?: string; bucket_name?: string }[];
		expect(r2).toHaveLength(1);
		expect(r2[0]?.binding).toBe("MEDIA");
		expect(typeof r2[0]?.bucket_name).toBe("string");
		expect(r2[0]?.bucket_name?.length).toBeGreaterThan(0);
	});

	test("nodejs_compat on; global_fetch_strictly_public OFF (its workers.dev reason is gone)", () => {
		const flags = config["compatibility_flags"] as string[];
		expect(flags).toContain("nodejs_compat");
		// The flag existed only so the Worker's fetch to the commerce service on
		// *.workers.dev left Cloudflare instead of being stubbed 404. That service
		// is gone (ADR-0020): the plugin's egress is api.stripe.com plus the
		// deployment's email and x402 hosts (DEPLOYMENT.md §4), none of them on
		// workers.dev, and the site makes no fetch of its own. Re-adding the flag
		// is allowed only with D1 `session` off — the pairing invariant in
		// site-config.test.ts.
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
