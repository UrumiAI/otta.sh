// IO-free test utilities (in-memory fakes + contract suites).
export { CountingIdGen, FixedClock } from "./deterministic.js";
export {
	InMemoryInventoryStore,
	type InMemoryInventoryStoreOptions,
	type ReservationState,
} from "./in-memory-inventory-store.js";
export {
	inventoryStoreContract,
	type InventoryStoreHarness,
	type InventoryStoreContractOptions,
} from "./inventory-store-contract.js";
export {
	InMemoryProductCommerceStore,
	type InMemoryProductCommerceStoreOptions,
} from "./in-memory-product-commerce-store.js";
export {
	productCommerceStoreContract,
	type ProductCommerceStoreHarness,
	type ProductCommerceStoreContractOptions,
} from "./product-commerce-store-contract.js";
export { InMemoryCartStore, type InMemoryCartStoreOptions } from "./in-memory-cart-store.js";
export {
	cartStoreContract,
	type CartStoreHarness,
	type CartStoreContractOptions,
} from "./cart-store-contract.js";
export { InMemoryOrderStore, type SeedOrderSummaryRow } from "./in-memory-order-store.js";
export { InMemoryEntitlementStore } from "./in-memory-entitlement-store.js";
export {
	InMemoryPaymentEventStore,
	type RecordedAnomaly,
} from "./in-memory-payment-event-store.js";
export { FakePaymentGateway, type FakeGatewayEvent } from "./fake-payment-gateway.js";
export {
	orderStoreContract,
	type OrderStoreHarness,
	type OrderStoreContractOptions,
} from "./order-store-contract.js";
export {
	orderTransitionContract,
	type OrderTransitionHarness,
	type OrderTransitionContractOptions,
} from "./order-transition-contract.js";
export { InMemoryOrderNotesStore } from "./in-memory-order-notes-store.js";
export {
	orderNotesStoreContract,
	type OrderNotesStoreHarness,
	type OrderNotesStoreContractOptions,
} from "./order-notes-store-contract.js";
export { InMemoryCustomerStore } from "./in-memory-customer-store.js";
export { InMemoryAddressStore } from "./in-memory-address-store.js";
export { InMemorySessionStore, DEFAULT_SESSION_TTL_MS } from "./in-memory-session-store.js";
export {
	InMemoryCredentialVerifier,
	DEFAULT_CHALLENGE_TTL_MS,
	DEFAULT_MAX_ACTIVE_CHALLENGES,
} from "./in-memory-credential-verifier.js";
export { FakeEmailSender } from "./fake-email-sender.js";
export {
	customerStoreContract,
	type CustomerStoreHarness,
	type CustomerStoreContractOptions,
} from "./customer-store-contract.js";
export {
	addressBookContract,
	type AddressBookHarness,
	type AddressBookContractOptions,
} from "./address-book-contract.js";
export {
	sessionContract,
	type SessionHarness,
	type SessionContractOptions,
} from "./session-contract.js";
export {
	credentialVerifierContract,
	type CredentialVerifierHarness,
	type CredentialVerifierContractOptions,
} from "./credential-verifier-contract.js";
export {
	entitlementStoreContract,
	type EntitlementStoreHarness,
	type EntitlementStoreContractOptions,
} from "./entitlement-store-contract.js";
export {
	paymentGatewayContract,
	type PaymentGatewayContractOptions,
} from "./payment-gateway-contract.js";
export {
	buildGatewayHarness,
	type GatewayConfirmInput,
	type GatewayHarnessConfig,
	type PaymentGatewayHarness,
} from "./gateway-harness.js";
// Phase 6: shipping / tax / coupon fakes + contract suites.
export { InMemoryShippingRulesStore } from "./in-memory-shipping-rules-store.js";
export { InMemoryTaxRulesStore } from "./in-memory-tax-rules-store.js";
export { InMemoryCouponStore } from "./in-memory-coupon-store.js";
export {
	shippingRulesStoreContract,
	type ShippingRulesStoreHarness,
	type ShippingRulesStoreContractOptions,
} from "./shipping-rules-store-contract.js";
export {
	taxRulesStoreContract,
	type TaxRulesStoreHarness,
	type TaxRulesStoreContractOptions,
} from "./tax-rules-store-contract.js";
export {
	couponStoreContract,
	type CouponStoreHarness,
	type CouponStoreContractOptions,
} from "./coupon-store-contract.js";
// Phase 7: reporting + settings fakes, contract suites, and the shared fixture.
export {
	InMemoryReportingStore,
	truncateToBucket,
	type SeedInventoryRow,
	type SeedOrderItemRow,
	type SeedOrderRow,
} from "./in-memory-reporting-store.js";
export { InMemorySettingsStore } from "./in-memory-settings-store.js";
export {
	reportingStoreContract,
	type ReportingStoreHarness,
	type ReportingStoreContractOptions,
} from "./reporting-store-contract.js";
export {
	settingsStoreContract,
	type SettingsStoreHarness,
	type SettingsStoreContractOptions,
} from "./settings-store-contract.js";
export {
	EXPECTED_ORDERS_BY_STATUS,
	EXPECTED_REVENUE_BY_DAY,
	EXPECTED_SUM_ALL,
	EXPECTED_SUM_EXCLUDING_CANCELLED_REFUNDED,
	EXPECTED_TOP_BY_QUANTITY,
	EXPECTED_TOP_BY_REVENUE,
	EXPECTED_TOTAL_REVENUE,
	FIXTURE_INVENTORY,
	FIXTURE_ITEMS,
	FIXTURE_ORDERS,
	REPORTING_WINDOW,
} from "./reporting-fixture.js";
