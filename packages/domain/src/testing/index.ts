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
