/**
 * One copy of the host is an invariant, not a preference. Otta's commerce truth
 * rides on EmDash's conditional-write primitives, which ship in `emdash@0.38.0`.
 * The released `@emdash-cms/cloudflare` pins `emdash` EXACTLY, so if a future
 * release of it ever pins a version other than the one the manifests name, a
 * second `emdash` lands in the store and the Worker bridge binds to the copy
 * WITHOUT the primitives: no install error, no type error. This suite is what
 * makes that loud. The fix, if it ever fires, is an exact `emdash` override in
 * `pnpm-workspace.yaml`.
 */
import Database from "better-sqlite3";
import { PluginStorageRepository } from "emdash";
import { MIGRATION_NAMES, runMigrations } from "emdash/db";
import { Kysely, SqliteDialect } from "kysely";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const STORE = fileURLToPath(new URL("../../../node_modules/.pnpm", import.meta.url));

// The schema is the host's; name its own database type rather than restating it.
let db: Parameters<typeof runMigrations>[0];

beforeAll(async () => {
	db = new Kysely({
		dialect: new SqliteDialect({ database: new Database(":memory:") }),
	}) as typeof db;
	await runMigrations(db);
});

afterAll(async () => {
	await db?.destroy();
});

describe("the EmDash host pin", () => {
	it("puts exactly one emdash in the store", () => {
		const copies = readdirSync(STORE).filter((entry) => entry.startsWith("emdash@"));
		expect(copies).toHaveLength(1);
	});

	it("exports the plugin-storage repository from the root entry", () => {
		expect(typeof PluginStorageRepository).toBe("function");
	});

	it("ends its migration list at the conditional-write migration", () => {
		expect(typeof runMigrations).toBe("function");
		expect(MIGRATION_NAMES.at(-1)).toBe("077_plugin_storage_revisions");
	});

	it("exposes the four conditional-write primitives on a migrated database", () => {
		const repo = new PluginStorageRepository(db, "otta", "inventory", ["onHand"]);
		for (const method of [
			"updateIf",
			"getVersioned",
			"compareAndSet",
			"compareAndDelete",
		] as const) {
			expect(typeof repo[method], method).toBe("function");
		}
	});
});
