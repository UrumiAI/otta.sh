/**
 * One copy of the host is an invariant, not a preference. Otta's commerce truth
 * rides on EmDash's conditional-write primitives, which first shipped in `emdash@0.38.0`
 * (the repo runs on `1.5.0`).
 * The released `@emdash-cms/cloudflare` names `emdash` EXACTLY: through 1.3.1 as a
 * dependency, since 1.5.0 as a peer. With the dependency, a mismatch put a second
 * `emdash` in the store and the Worker bridge bound to the copy WITHOUT the
 * primitives: no install error, no type error. With the peer, npm refuses a
 * mismatch (`ERESOLVE`) and pnpm only warns and resolves the peer to the
 * workspace's copy (see `pnpm-workspace.yaml`). Either way this suite is what makes
 * a second copy loud. The fix, if it ever fires, is an exact `emdash` override in
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

	it("includes the conditional-write migration", () => {
		expect(typeof runMigrations).toBe("function");
		expect(MIGRATION_NAMES).toContain("077_plugin_storage_revisions");
	});

	// A tripwire, not a preference: a host release that adds migrations fails here,
	// so each new tail is reviewed (and DEPLOYMENT.md's backup note revisited)
	// before it ships. 1.0.1 added 078-089; 1.1 added 090-091 (unchanged through 1.4.0);
	// 1.5.0 added 092-097 (UPGRADING.md, "EmDash 1.3.1 to 1.5.0").
	it("ends at the reviewed migration tip", () => {
		expect(MIGRATION_NAMES.at(-1)).toBe("097_room_storage");
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
