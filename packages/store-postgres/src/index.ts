// Barrel of @urumi/store-postgres — the Kysely inventory store, dialect
// factories, and the forward-only migrations (§0.4/§0.5).
import type { IdGen } from "@urumi/domain";

export { makePostgresDb, makePostgresPool, makeSqliteDb } from "./dialects.js";
export {
	KyselyInventoryStore,
	type KyselyInventoryStoreOptions,
} from "./kysely-inventory-store.js";
export {
	KyselyProductCommerceStore,
	type KyselyProductCommerceStoreOptions,
} from "./kysely-product-commerce-store.js";
export { KyselyCartStore, type KyselyCartStoreOptions } from "./kysely-cart-store.js";
export { migrateToLatest, migrationProvider } from "./migrations/index.js";
export type {
	CartLinesTable,
	CartMutationKind,
	CartMutationsTable,
	CartState,
	CartsTable,
	Database,
	InventoryTable,
	ProductCommerceTable,
	ReservationsTable,
	ReservationState,
} from "./schema.js";

/** Zero-dep collision-free id source for production adapters (risk R5). */
export const uuidIdGen: IdGen = {
	newId(): string {
		return crypto.randomUUID();
	},
};
