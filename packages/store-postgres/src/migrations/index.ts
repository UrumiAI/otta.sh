import type { Kysely } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import { migration0001PhaseInventory } from "./0001_phase0_inventory.js";
import { migration0002ProductCommerce } from "./0002_product_commerce.js";
import { migration0003Cart } from "./0003_cart.js";
import { migration0004ProductCommerceActiveUpdatedAt } from "./0004_product_commerce_active_updated_at.js";
import { migration0005Orders } from "./0005_orders.js";

/** Ordered, append-only migration list (forward-only). */
const migrations: Record<string, Migration> = {
	"0001_phase0_inventory": migration0001PhaseInventory,
	"0002_product_commerce": migration0002ProductCommerce,
	"0003_cart": migration0003Cart,
	"0004_product_commerce_active_updated_at": migration0004ProductCommerceActiveUpdatedAt,
	"0005_orders": migration0005Orders,
};

export const migrationProvider: MigrationProvider = {
	getMigrations(): Promise<Record<string, Migration>> {
		return Promise.resolve(migrations);
	},
};

export interface MigrateToLatestOptions {
	/**
	 * Pin kysely's own `kysely_migration`/`kysely_migration_lock` tables to a
	 * named schema. REQUIRED for schema-isolated Postgres tests
	 * (`createIsolatedPgSchema` passes its schema): without it, kysely's
	 * `Migrator.#doesTableExist` matches the migration tables BY NAME ACROSS
	 * ALL SCHEMAS (`PostgresIntrospector.getTables` is not search_path-
	 * scoped), so whenever any other isolated schema is alive — a parallel
	 * test file, or leftovers from a killed run — the migrator skips creating
	 * the lock table in the new schema and its subsequent unqualified
	 * `SELECT … FROM kysely_migration_lock` fails with "relation does not
	 * exist". Leave unset for single-schema use (the service bin; sqlite has
	 * no schemas).
	 */
	migrationTableSchema?: string;
}

/** Run every pending migration to latest; throws on the first failure. */
export async function migrateToLatest<DB>(
	db: Kysely<DB>,
	options: MigrateToLatestOptions = {},
): Promise<void> {
	const migrator = new Migrator({
		db,
		provider: migrationProvider,
		...(options.migrationTableSchema !== undefined
			? { migrationTableSchema: options.migrationTableSchema }
			: {}),
	});
	const { error } = await migrator.migrateToLatest();
	if (error !== undefined) {
		throw error instanceof Error ? error : new Error(String(error));
	}
}
