// Public barrel of @urumi/domain — ports, use-cases, and branded types.
export { cents, currency, money, type Cents, type Currency, type Money } from "./money/cents.js";
export {
	idempotencyKey,
	productId,
	reservationId,
	sku,
	type IdempotencyKey,
	type ProductId,
	type ReservationId,
	type Sku,
} from "./money/ids.js";
export type { InventoryStore, ReserveResult } from "./ports/inventory-store.js";
export type { OrderStore } from "./ports/order-store.js";
export type { Clock } from "./ports/clock.js";
export type { IdGen } from "./ports/id-gen.js";
export { commit, release, reserve } from "./inventory/use-cases.js";
export type {
	ProductCommerce,
	ProductCommerceStore,
	ProductKind,
	UpsertProductCommerceInput,
} from "./ports/product-commerce-store.js";
export { MissingProductIdError, SkuConflictError } from "./product-commerce/errors.js";
export {
	getProductCommerce,
	softDeleteProductCommerce,
	upsertProductCommerce,
	type ProductCommerceDeps,
} from "./product-commerce/use-cases.js";
