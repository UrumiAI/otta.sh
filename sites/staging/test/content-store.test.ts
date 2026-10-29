/**
 * `contentTableAnswers` — the probe that tells a MISSING TABLE apart from a
 * missing row (issue #140).
 *
 * em-dash's live loader folds a missing-table fault into a valid-looking
 * negative answer (`loadEntry` → bare `return`, `loadCollection` →
 * `{ entries: [] }`), so a page that got "no product" / "no products" cannot
 * tell a dead content store from an absent row. The probe is the tell, and it
 * is tested here against a REAL EmDash schema: the host's own migrations plus
 * the content table its own SchemaRegistry creates, then that table renamed
 * away exactly as the issue's workerd reproduction did.
 */
import Database from "better-sqlite3";
import { SchemaRegistry } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, sql, SqliteDialect } from "kysely";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentTableAnswers, LOADER_TABLES } from "../src/lib/content-store.js";

let db: Parameters<typeof runMigrations>[0];
const openDb = async () => db;
const unconfigured = async (): Promise<never> => {
	throw new Error("EmDash database not configured.");
};

beforeEach(async () => {
	db = new Kysely({
		dialect: new SqliteDialect({ database: new Database(":memory:") }),
	}) as typeof db;
	await runMigrations(db);
	await new SchemaRegistry(db).createCollection({ slug: "products", label: "Products" });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await db?.destroy();
});

describe("the emdash version LOADER_TABLES was audited against", () => {
	it("is the installed one", () => {
		// `emdash` does not export its package.json; find it beside the entry.
		const entry = createRequire(import.meta.url).resolve("emdash");
		const manifest = path.join(entry.slice(0, entry.lastIndexOf("/dist/")), "package.json");
		const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
		expect(
			version,
			"emdash changed: re-audit LOADER_TABLES (src/lib/content-store.ts) against the tables loadEntry/loadCollection read in dist/loader-*.mjs, then update this pin",
		).toBe("1.3.1");
	});
});

describe("contentTableAnswers", () => {
	it("answers true for a collection whose table is there — even with no rows in it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		// An empty table is the brand-new store: a genuine empty state, not an outage.
		await expect(contentTableAnswers("products", openDb, "shop catalog")).resolves.toBe(true);
		expect(error).not.toHaveBeenCalled();
	});

	it("answers false, and tells the operator, when the content table is gone", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await sql`ALTER TABLE ec_products RENAME TO ec_products_gone`.execute(db);

		await expect(contentTableAnswers("products", openDb, "product page")).resolves.toBe(false);

		expect(error).toHaveBeenCalledTimes(1);
		const [message, cause] = error.mock.calls[0] ?? [];
		expect(message).toContain("[site-staging]");
		expect(message).toContain("product page");
		expect(message).toContain("ec_products");
		expect(String(cause)).toMatch(/no such table/i);
	});

	it.each(LOADER_TABLES)(
		"answers false when the loader's system table %s is gone (the loader swallows that too)",
		async (table) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			await sql`ALTER TABLE ${sql.table(table)} RENAME TO ${sql.table(`${table}_gone`)}`.execute(
				db,
			);

			await expect(contentTableAnswers("products", openDb, "shop catalog")).resolves.toBe(false);
			expect(error).toHaveBeenCalledTimes(1);
			expect(String(error.mock.calls[0]?.[1])).toMatch(/no such table/i);
		},
	);

	it("every table it probes exists on a fresh install, and it asks in ONE statement", async () => {
		// Probing a table a fresh install lacks would call every new store dead.
		const queries: string[] = [];
		const counted = new Kysely({
			dialect: new SqliteDialect({ database: new Database(":memory:") }),
			log: (event) => {
				queries.push(event.query.sql);
			},
		}) as typeof db;
		try {
			await runMigrations(counted);
			await new SchemaRegistry(counted).createCollection({ slug: "products", label: "Products" });
			queries.length = 0;

			await expect(
				contentTableAnswers("products", async () => counted, "home catalog"),
			).resolves.toBe(true);
			expect(queries).toHaveLength(1);
			for (const table of ["ec_products", ...LOADER_TABLES]) {
				expect(queries[0]).toContain(`"${table}"`);
			}
		} finally {
			await counted.destroy();
		}
	});

	it("answers false when the database handle itself cannot be had", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(contentTableAnswers("products", unconfigured, "home catalog")).resolves.toBe(
			false,
		);
		expect(error).toHaveBeenCalledTimes(1);
	});

	it("refuses a collection name that is not a plain identifier, without querying", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const open = vi.fn(openDb);

		await expect(
			contentTableAnswers("products; DROP TABLE ec_products", open, "shop catalog"),
		).resolves.toBe(false);
		expect(open).not.toHaveBeenCalled();
		// The real table is untouched.
		await expect(contentTableAnswers("products", openDb, "shop catalog")).resolves.toBe(true);
		expect(error).toHaveBeenCalledTimes(1);
	});
});
