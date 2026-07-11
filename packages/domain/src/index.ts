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
export {
	AdjustReservationMismatchError,
	ReservationNotHeldError,
	type InventoryStore,
	type ReserveResult,
} from "./ports/inventory-store.js";
export type { OrderStore } from "./ports/order-store.js";
export type { Clock } from "./ports/clock.js";
export type { IdGen } from "./ports/id-gen.js";
export { commit, release, reserve } from "./inventory/use-cases.js";
export type {
	ProductCommerce,
	ProductCommerceStore,
	ProductCommerceView,
	ProductKind,
	UpsertProductCommerceInput,
} from "./ports/product-commerce-store.js";
export { MissingProductIdError, SkuConflictError } from "./product-commerce/errors.js";
export {
	activateProductCommerce,
	deactivateProductCommerce,
	getProductCommerce,
	listProductCommerceByIds,
	softDeleteProductCommerce,
	upsertProductCommerce,
	type ProductCommerceDeps,
} from "./product-commerce/use-cases.js";
export {
	HoldExpiredError,
	type AdjustLineInput,
	type Cart,
	type CartLine,
	type CartMutationKind,
	type CartState,
	type CartStore,
	type ClaimMutationInput,
	type ClaimMutationResult,
	type ExpiredHold,
	type RecordedCartMutation,
	type ReservationLifecycle,
	type UpsertLineInput,
} from "./ports/cart-store.js";
export {
	addLine,
	createCart,
	DEFAULT_HOLD_TTL_MS,
	expireHolds,
	getCart,
	removeLine,
	updateLine,
	type AddLineResult,
	type CartDeps,
	type CartFailure,
	type RemoveLineResult,
	type UpdateLineResult,
} from "./cart/use-cases.js";
