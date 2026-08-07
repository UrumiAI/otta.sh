/**
 * The `node` build target (root `Dockerfile`, DEPLOYMENT.md §3bis) — the
 * container shape, where content lives in Postgres and media in S3.
 *
 * site-config.test.ts pins the Cloudflare target and is the reason the default
 * is asserted here too: `buildEmdashOptions(url)` with no target argument must
 * keep producing D1 + R2, or the live Worker deploy changes shape without a
 * single call site changing.
 */
import { describe, expect, test } from "vitest";
import { applyPostgresEnv, postgresEnvFrom } from "../server/pg-env.mjs";
import {
	buildEmdashOptions,
	DEFAULT_SITE_TARGET,
	resolveSiteTarget,
} from "../src/emdash-options.js";

const SERVICE_URL = "https://svc.example.com";

describe("resolveSiteTarget", () => {
	test("defaults to cloudflare when unset or empty", () => {
		expect(resolveSiteTarget(undefined)).toBe("cloudflare");
		expect(resolveSiteTarget("")).toBe("cloudflare");
		expect(DEFAULT_SITE_TARGET).toBe("cloudflare");
	});

	test("accepts the two known targets", () => {
		expect(resolveSiteTarget("cloudflare")).toBe("cloudflare");
		expect(resolveSiteTarget("node")).toBe("node");
	});

	test("THROWS on anything else rather than falling back", () => {
		// A silent fallback would build a Cloudflare image bound to D1 and R2
		// bindings that do not exist in a container — a runtime failure at the
		// first request, from a typo at build time.
		expect(() => resolveSiteTarget("nodejs")).toThrow(/OTTA_SITE_TARGET/);
		expect(() => resolveSiteTarget("NODE")).toThrow(/OTTA_SITE_TARGET/);
	});
});

describe("buildEmdashOptions(node)", () => {
	const options = buildEmdashOptions(SERVICE_URL, "node");

	test("content database is Postgres, not the template's file-backed sqlite", () => {
		// A store pod has no persistent volume: sqlite would be lost on every
		// restart, and each replica would hold a private copy.
		expect(options.database).toMatchObject({ entrypoint: "emdash/db/postgres" });
	});

	test("media storage is S3, not the template's local directory", () => {
		expect(options.storage).toMatchObject({ entrypoint: "emdash/storage/s3" });
	});

	test("registers exactly the same two trusted descriptors as the Worker target", () => {
		// The plugin half of the deployment is target-agnostic by design — it
		// only ever talks HTTP. If these ever diverge, the container store and
		// the Worker store are two different products.
		expect(options.plugins).toEqual(buildEmdashOptions(SERVICE_URL, "cloudflare").plugins);
	});

	test("still has NO sandboxed / sandboxRunner / marketplace keys", () => {
		expect(options).not.toHaveProperty("sandboxed");
		expect(options).not.toHaveProperty("sandboxRunner");
		expect(options).not.toHaveProperty("marketplace");
	});
});

describe("buildEmdashOptions default target", () => {
	test("omitting the target argument keeps the Cloudflare D1/R2 pair", () => {
		expect(buildEmdashOptions(SERVICE_URL).database).toMatchObject({
			entrypoint: "@emdash-cms/cloudflare/db/d1",
		});
		expect(buildEmdashOptions(SERVICE_URL).storage).toMatchObject({
			entrypoint: "@emdash-cms/cloudflare/storage/r2",
		});
	});
});

describe("postgresEnvFrom", () => {
	test("translates a DATABASE_URL into the PG* variables pg falls back to", () => {
		expect(postgresEnvFrom("postgres://otta:s3cret@db.internal:5433/otta_qa")).toEqual({
			PGHOST: "db.internal",
			PGPORT: "5433",
			PGUSER: "otta",
			PGPASSWORD: "s3cret",
			PGDATABASE: "otta_qa",
		});
	});

	test("defaults the port and carries sslmode through", () => {
		const env = postgresEnvFrom("postgres://u:p@host/db?sslmode=no-verify");
		expect(env["PGPORT"]).toBe("5432");
		// RDS presents a chain the container's trust store does not carry, so
		// this is the only lever that keeps the connection openable.
		expect(env["PGSSLMODE"]).toBe("no-verify");
	});

	test("decodes percent-encoded credentials", () => {
		// pg reads these variables literally: an encoded password would
		// otherwise authenticate with the escape sequence still in it.
		const env = postgresEnvFrom("postgres://us%40er:p%40ss%2Fword@host:5432/db");
		expect(env["PGUSER"]).toBe("us@er");
		expect(env["PGPASSWORD"]).toBe("p@ss/word");
	});

	test("returns nothing for a missing or unparseable URL", () => {
		expect(postgresEnvFrom(undefined)).toEqual({});
		expect(postgresEnvFrom("")).toEqual({});
		expect(postgresEnvFrom("not a url")).toEqual({});
	});
});

describe("applyPostgresEnv", () => {
	test("fills the gaps and reports what it set", () => {
		const env: Record<string, string | undefined> = {
			DATABASE_URL: "postgres://u:p@host:5432/db",
		};
		const applied = applyPostgresEnv(env);
		expect(env["PGHOST"]).toBe("host");
		expect(applied).toContain("PGHOST");
	});

	test("an explicit PGHOST wins — the whole translation is skipped", () => {
		// Someone who set PG* by hand has configured this deliberately;
		// DATABASE_URL must not quietly override half of it.
		const env: Record<string, string | undefined> = {
			PGHOST: "chosen.example",
			DATABASE_URL: "postgres://u:p@other.example:5432/db",
		};
		expect(applyPostgresEnv(env)).toEqual([]);
		expect(env["PGHOST"]).toBe("chosen.example");
		expect(env["PGDATABASE"]).toBeUndefined();
	});
});
