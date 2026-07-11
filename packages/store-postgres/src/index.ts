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
export { KyselyOrderStore, type KyselyOrderStoreOptions } from "./kysely-order-store.js";
export {
	KyselyEntitlementStore,
	type KyselyEntitlementStoreOptions,
} from "./kysely-entitlement-store.js";
export {
	KyselyPaymentEventStore,
	type KyselyPaymentEventStoreOptions,
} from "./kysely-payment-event-store.js";
export { KyselyCustomerStore, type KyselyCustomerStoreOptions } from "./kysely-customer-store.js";
export { KyselyAddressStore, type KyselyAddressStoreOptions } from "./kysely-address-store.js";
export {
	KyselySessionStore,
	DEFAULT_SESSION_TTL_MS,
	hashToken,
	type KyselySessionStoreOptions,
} from "./kysely-session-store.js";
export {
	KyselyCredentialVerifier,
	DEFAULT_CHALLENGE_TTL_MS,
	DEFAULT_MAX_ACTIVE_CHALLENGES,
	type KyselyCredentialVerifierOptions,
} from "./kysely-credential-verifier.js";
export { KyselyShippingRulesStore } from "./kysely-shipping-rules-store.js";
export { KyselyTaxRulesStore } from "./kysely-tax-rules-store.js";
export { KyselyCouponStore, type KyselyCouponStoreOptions } from "./kysely-coupon-store.js";
export {
	KyselyReportingStore,
	type KyselyReportingStoreOptions,
	type ReportingDialect,
} from "./kysely-reporting-store.js";
export { KyselySettingsStore, type KyselySettingsStoreOptions } from "./kysely-settings-store.js";
export { migrateToLatest, migrationProvider } from "./migrations/index.js";
export type {
	AddressesTable,
	CouponRedemptionsTable,
	CouponsTable,
	ShippingMethodsTable,
	ShippingRatesTable,
	ShippingZonesTable,
	TaxClassesTable,
	TaxRatesTable,
	CartLinesTable,
	CartMutationKind,
	CartMutationsTable,
	CartState,
	CartsTable,
	CustomerSessionsTable,
	CustomersTable,
	Database,
	EntitlementsTable,
	InventoryTable,
	LoginChallengesTable,
	OrderEmailsOutboxTable,
	OrderItemsTable,
	OrdersTable,
	OrderStateColumn,
	OrderTotalsTable,
	PaymentEventsTable,
	PaymentsTable,
	ProductCommerceTable,
	ReservationsTable,
	ReservationState,
	SettingsTable,
	SettingsMutationsTable,
} from "./schema.js";

/** Zero-dep collision-free id source for production adapters (risk R5). */
export const uuidIdGen: IdGen = {
	newId(): string {
		return crypto.randomUUID();
	},
};
