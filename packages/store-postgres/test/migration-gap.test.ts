import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { expect, test } from "vitest";
import { makeSqliteDb, migrateToLatest, migrationProvider } from "../src/index.js";

// N2 — Phase 3 was developed in parallel with Phase 1 under a numbering
// contract (0002 reserved for product_commerce, 0003 for cart), relying on the
// Migrator running pending migrations in NAME ORDER without requiring
// contiguity. Post-merge the real list is contiguous again, but the tolerance
// property the parallel workflow depends on stays pinned here with a synthetic
// gapped provider — if a Kysely upgrade ever starts rejecting gaps, the next
// parallel-phase pair must know before they branch.

test("the real provider lists 0001…0017 in order and migrates cleanly", async () => {
	const provided = Object.keys(await migrationProvider.getMigrations());
	expect(provided).toEqual([
		"0001_phase0_inventory",
		"0002_product_commerce",
		"0003_cart",
		"0004_product_commerce_active_updated_at",
		"0005_orders",
		"0006_customers_sessions_outbox",
		"0007_shipping_tax_coupons",
		"0008_settings_and_reporting_indices",
		"0009_orders_admin_list_indices",
		"0010_order_notes",
		"0011_reconciliation_resolution",
		"0012_order_fulfillment",
		"0013_order_cancellation",
		"0014_order_events",
		"0015_product_commerce_admin_list_indices",
		"0016_inventory_stock_movements",
		"0017_product_commerce_data_model_adds",
	]);

	const db = makeSqliteDb(":memory:");
	try {
		await migrateToLatest(db);
		const ran = await sql<{
			name: string;
		}>`SELECT name FROM kysely_migration ORDER BY name`.execute(db);
		expect(ran.rows.map((r) => r.name)).toEqual([
			"0001_phase0_inventory",
			"0002_product_commerce",
			"0003_cart",
			"0004_product_commerce_active_updated_at",
			"0005_orders",
			"0006_customers_sessions_outbox",
			"0007_shipping_tax_coupons",
			"0008_settings_and_reporting_indices",
			"0009_orders_admin_list_indices",
			"0010_order_notes",
			"0011_reconciliation_resolution",
			"0012_order_fulfillment",
			"0013_order_cancellation",
			"0014_order_events",
			"0015_product_commerce_admin_list_indices",
			"0016_inventory_stock_movements",
			"0017_product_commerce_data_model_adds",
		]);

		// And the 0003 tables exist and accept rows (spot check the ledger).
		await db
			.insertInto("cart_mutations")
			.values({
				idempotency_key: "k1",
				cart_id: "cart-1",
				line_id: null,
				kind: "add",
				resulting_qty: null,
				completed: 0,
				created_at: "2026-07-10T00:00:00.000Z",
			})
			.execute();
		const row = await db
			.selectFrom("cart_mutations")
			.select("completed")
			.where("idempotency_key", "=", "k1")
			.executeTakeFirst();
		expect(row?.completed).toBe(0);
	} finally {
		await db.destroy();
	}
});

test("the Migrator tolerates a numbering gap in an ordered migration list", async () => {
	// Synthetic gapped list {0001, 0003}: the shape both parallel phases relied
	// on while 0002 lived in a sibling worktree.
	const gapped: Record<string, Migration> = {
		"0001_first": {
			async up(db: Kysely<unknown>): Promise<void> {
				await db.schema
					.createTable("gap_a")
					.addColumn("id", "text", (col) => col.primaryKey())
					.execute();
			},
		},
		"0003_third": {
			async up(db: Kysely<unknown>): Promise<void> {
				await db.schema
					.createTable("gap_b")
					.addColumn("id", "text", (col) => col.primaryKey())
					.execute();
			},
		},
	};

	const db = new Kysely<Record<string, Record<string, unknown>>>({
		dialect: new SqliteDialect({ database: new BetterSqlite3(":memory:") }),
	});
	try {
		const migrator = new Migrator({
			db,
			provider: { getMigrations: () => Promise.resolve(gapped) },
		});
		const { error, results } = await migrator.migrateToLatest();
		expect(error).toBeUndefined();
		expect(
			results?.map(
				(r: { migrationName: string; status: string }) => `${r.migrationName}:${r.status}`,
			),
		).toEqual(["0001_first:Success", "0003_third:Success"]);
	} finally {
		await db.destroy();
	}
});
