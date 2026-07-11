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
export { InMemoryOrderStore } from "./in-memory-order-store.js";
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
