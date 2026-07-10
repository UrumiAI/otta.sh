// Public barrel of @urumi/domain — ports, use-cases, and branded types.
export { cents, currency, money, type Cents, type Currency, type Money } from "./money/cents.js";
export {
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	type IdempotencyKey,
	type OrderId,
	type ProductId,
	type ReservationId,
	type Sku,
} from "./money/ids.js";
export {
	AdjustReservationMismatchError,
	ReservationCommitLostError,
	ReservationNotHeldError,
	type AdoptInput,
	type AdoptResult,
	type InventoryStore,
	type ReserveResult,
} from "./ports/inventory-store.js";
export type {
	CreateOrderInput,
	CreateOrderLineInput,
	CreateOrderResult,
	OrderStore,
	OrderState,
	RecordPaymentInput,
} from "./ports/order-store.js";
export type {
	Entitlement,
	EntitlementQuery,
	EntitlementSource,
	EntitlementState,
	EntitlementStore,
	GrantEntitlementInput,
} from "./ports/entitlement-store.js";
export type {
	PaymentAnomalyKind,
	PaymentEventStore,
	RecordAnomalyInput,
} from "./ports/payment-event-store.js";
export type {
	ClientAction,
	ConfirmationResult,
	CreateIntentInput,
	PaymentGateway,
	PaymentIntentHandle,
	RawConfirmation,
	X402Proof,
} from "./ports/payment-gateway.js";
export type {
	FulfillmentKind,
	Order,
	OrderLine,
	OrderTotals,
	PaymentMethod,
} from "./orders/model.js";
export type { CreateOrderFailure, SettleFailure } from "./orders/errors.js";
export {
	createOrderFromCart,
	DEFAULT_CHECKOUT_TTL_MS,
	type CreateOrderCommand,
	type CreateOrderDeps,
	type CreateOrderFromCartResult,
} from "./orders/create-order-from-cart.js";
export { settleOrder, type SettleDeps, type SettleResult } from "./orders/settle-order.js";
export { expireOrders, type ExpireOrdersDeps } from "./orders/expire-orders.js";
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
