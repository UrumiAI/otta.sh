// IO-free test utilities (in-memory fakes + contract suites).
export { CountingIdGen, FixedClock } from "./deterministic.js";
export {
	InMemoryInventoryStore,
	type InMemoryInventoryStoreOptions,
	type ReservationState,
} from "./in-memory-inventory-store.js";
