/**
 * The host pin is an invariant, not a preference. Otta's commerce truth is
 * moving onto EmDash's conditional-write primitives, and the copy of `emdash`
 * that carries them is a vendored build (`vendor/`, see `vendor/README.md`)
 * held in place by the overrides in `pnpm-workspace.yaml`. Drop the
 * `@emdash-cms/cloudflare` override and a second, stock `emdash` resolves from
 * the registry: no install error, no type error, just a Worker bridge bound to
 * the copy WITHOUT the primitives. This suite is what makes that loud.
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

describe("the vendored EmDash host pin", () => {
	it("puts exactly one emdash in the store", () => {
		const copies = readdirSync(STORE).filter((entry) => entry.startsWith("emdash@"));
		expect(copies).toHaveLength(1);
	});

	it("exports the plugin-storage repository from the root entry", () => {
		expect(typeof PluginStorageRepository).toBe("function");
	});

	it("ends its migration list at the renumbered conditional-write migration", () => {
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
