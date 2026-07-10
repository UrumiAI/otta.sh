import type { Kysely } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import { migration0001PhaseInventory } from "./0001_phase0_inventory.js";
import { migration0002ProductCommerce } from "./0002_product_commerce.js";

/** Ordered, append-only migration list (forward-only). */
const migrations: Record<string, Migration> = {
	"0001_phase0_inventory": migration0001PhaseInventory,
	"0002_product_commerce": migration0002ProductCommerce,
};

export const migrationProvider: MigrationProvider = {
	getMigrations(): Promise<Record<string, Migration>> {
		return Promise.resolve(migrations);
	},
};

/** Run every pending migration to latest; throws on the first failure. */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<void> {
	const migrator = new Migrator({ db, provider: migrationProvider });
	const { error } = await migrator.migrateToLatest();
	if (error !== undefined) {
		throw error instanceof Error ? error : new Error(String(error));
	}
}
