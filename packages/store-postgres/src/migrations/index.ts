import type { Kysely } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import { migration0001PhaseInventory } from "./0001_phase0_inventory.js";
import { migration0002ProductCommerce } from "./0002_product_commerce.js";
import { migration0003Cart } from "./0003_cart.js";
import { migration0004ProductCommerceActiveUpdatedAt } from "./0004_product_commerce_active_updated_at.js";
import { migration0005Orders } from "./0005_orders.js";
import { migration0006CustomersSessionsOutbox } from "./0006_customers_sessions_outbox.js";
import { migration0007ShippingTaxCoupons } from "./0007_shipping_tax_coupons.js";
import { migration0008SettingsAndReportingIndices } from "./0008_settings_and_reporting_indices.js";
import { migration0009OrdersAdminListIndices } from "./0009_orders_admin_list_indices.js";
import { migration0010OrderNotes } from "./0010_order_notes.js";
import { migration0011ReconciliationResolution } from "./0011_reconciliation_resolution.js";
import { migration0012OrderFulfillment } from "./0012_order_fulfillment.js";
import { migration0013OrderCancellation } from "./0013_order_cancellation.js";
import { migration0014OrderEvents } from "./0014_order_events.js";
import { migration0015ProductCommerceAdminListIndices } from "./0015_product_commerce_admin_list_indices.js";
import { migration0016InventoryStockMovements } from "./0016_inventory_stock_movements.js";
import { migration0017ProductCommerceDataModelAdds } from "./0017_product_commerce_data_model_adds.js";
import { migration0018CouponsAdminList } from "./0018_coupons_admin_list.js";
import { migration0019OrderShippingAddress } from "./0019_order_shipping_address.js";
import { migration0020Refunds } from "./0020_refunds.js";
import { migration0021CartOrderId } from "./0021_cart_order_id.js";
import { migration0022OrderLookupIndices } from "./0022_order_lookup_indices.js";
import { migration0023ProductVariants } from "./0023_product_variants.js";

/** Ordered, append-only migration list (forward-only). */
const migrations: Record<string, Migration> = {
	"0001_phase0_inventory": migration0001PhaseInventory,
	"0002_product_commerce": migration0002ProductCommerce,
	"0003_cart": migration0003Cart,
	"0004_product_commerce_active_updated_at": migration0004ProductCommerceActiveUpdatedAt,
	"0005_orders": migration0005Orders,
	"0006_customers_sessions_outbox": migration0006CustomersSessionsOutbox,
	"0007_shipping_tax_coupons": migration0007ShippingTaxCoupons,
	"0008_settings_and_reporting_indices": migration0008SettingsAndReportingIndices,
	"0009_orders_admin_list_indices": migration0009OrdersAdminListIndices,
	"0010_order_notes": migration0010OrderNotes,
	"0011_reconciliation_resolution": migration0011ReconciliationResolution,
	"0012_order_fulfillment": migration0012OrderFulfillment,
	"0013_order_cancellation": migration0013OrderCancellation,
	"0014_order_events": migration0014OrderEvents,
	"0015_product_commerce_admin_list_indices": migration0015ProductCommerceAdminListIndices,
	"0016_inventory_stock_movements": migration0016InventoryStockMovements,
	"0017_product_commerce_data_model_adds": migration0017ProductCommerceDataModelAdds,
	"0018_coupons_admin_list": migration0018CouponsAdminList,
	"0019_order_shipping_address": migration0019OrderShippingAddress,
	"0020_refunds": migration0020Refunds,
	"0021_cart_order_id": migration0021CartOrderId,
	"0022_order_lookup_indices": migration0022OrderLookupIndices,
	"0023_product_variants": migration0023ProductVariants,
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
