// Public barrel of @urumi/domain — ports, use-cases, and branded types.
export { cents, currency, money, type Cents, type Currency, type Money } from "./money/cents.js";
// Phase 6 pricing engines (pure, IO-free): the totals pipeline + its components.
export { divRoundHalfUp } from "./pricing/round.js";
export { allocateCents } from "./pricing/allocate.js";
export { computeLineTax } from "./pricing/tax.js";
export { computeCouponDiscount } from "./pricing/coupon.js";
export { resolveShippingRate } from "./pricing/shipping.js";
export { computeTotals } from "./pricing/compute-totals.js";
export { CouponCurrencyMismatchError } from "./pricing/errors.js";
export {
	validateCoupon,
	type CouponValidationContext,
	type CouponValidationFailure,
	type ValidateCouponResult,
} from "./pricing/validate-coupon.js";
export {
	computeQuote,
	sumLineSubtotals,
	type QuoteCommand,
	type QuoteDeps,
	type QuoteFailure,
	type QuoteResult,
} from "./pricing/quote.js";
export {
	deleteTaxClass,
	type DeleteTaxClassDeps,
	type DeleteTaxClassResult,
} from "./pricing/delete-tax-class.js";
export {
	DEFAULT_COUPON_GRACE_MS,
	reconcileCouponRedemptions,
	type ReconcileCouponsDeps,
	type ReconcileCouponsOptions,
} from "./pricing/reconcile-coupons.js";
export type {
	Coupon,
	CouponType,
	FixedAmountCoupon,
	PercentageCoupon,
	RulesSnapshot,
	ShippingMethodSnapshot,
	ShippingMethodType,
	TaxClassId,
	TotalsBreakdown,
	TotalsInput,
	TotalsLineBreakdown,
	TotalsLineInput,
} from "./pricing/types.js";
export type {
	CreateShippingMethodInput,
	CreateShippingRateInput,
	CreateShippingZoneInput,
	DeleteShippingMethodResult,
	DeleteShippingRateResult,
	DeleteShippingZoneResult,
	ShippingMethod,
	ShippingRate,
	ShippingRulesStore,
	ShippingZone,
	UpdateShippingMethodInput,
	UpdateShippingMethodResult,
	UpdateShippingRateInput,
	UpdateShippingRateResult,
	UpdateShippingZoneInput,
	UpdateShippingZoneResult,
} from "./ports/shipping-rules-store.js";
export type {
	CreateTaxClassInput,
	CreateTaxRateInput,
	DeleteTaxClassStoreResult,
	DeleteTaxRateResult,
	TaxClass,
	TaxRate,
	TaxRulesStore,
	UpdateTaxRateInput,
	UpdateTaxRateResult,
} from "./ports/tax-rules-store.js";
export type {
	CouponRecord,
	CouponRedemption,
	CouponStore,
	CreateCouponInput,
	DeleteCouponResult,
	RedeemCouponInput,
	RedeemResult,
	UpdateCouponInput,
	UpdateCouponResult,
} from "./ports/coupon-store.js";
export {
	customerId,
	email,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	type CustomerId,
	type Email,
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
	StockMovementMismatchError,
	type AdoptInput,
	type AdoptManyInput,
	type AdoptManyResult,
	type AdoptResult,
	type CommitManyResult,
	type InventoryStore,
	type ReserveResult,
	type RestockResult,
	type StockRemovalResult,
} from "./ports/inventory-store.js";
export type {
	CancelOrderInput,
	CancelOrderStoreResult,
	CreateOrderInput,
	CreateOrderLineInput,
	CreateOrderResult,
	CreateOrderTotalsInput,
	OrderCustomerKey,
	OrderEvent,
	OrderEventKind,
	OrderListCursor,
	OrderListFilter,
	OrderListPage,
	OrderListResult,
	OrderStore,
	OrderState,
	OrderSummary,
	OrderTransitionInput,
	OrderTransitionResult,
	OutboxEmail,
	RecordFulfillmentInput,
	RecordFulfillmentStoreResult,
	RecordPaymentInput,
	ResolveReconciliationInput,
	ResolveReconciliationStoreResult,
} from "./ports/order-store.js";
export type { EmailSender, EmailTemplate, SendEmailInput } from "./ports/email-sender.js";
export type {
	CreateCustomerInput,
	CustomerStore,
	UpdateCustomerInput,
} from "./ports/customer-store.js";
export type {
	AddressStore,
	CreateAddressInput,
	UpdateAddressInput,
} from "./ports/address-store.js";
export type { Session, SessionStore, SessionSummary } from "./ports/session-store.js";
export type {
	CustomerCredentialVerifier,
	IssueChallengeResult,
	VerifyChallengeResult,
} from "./ports/credential-verifier.js";
export type { Address, AddressKind, Customer } from "./customers/model.js";
export { DuplicateCustomerEmailError, type LoginFailure } from "./customers/errors.js";
export {
	emailTemplateForState,
	isLegalOrderTransition,
	legalNextStates,
	ORDER_EMAIL_TEMPLATE_FOR_STATE,
	ORDER_STATE_MACHINE,
} from "./orders/state-machine.js";
export {
	buildOrderEmailData,
	dispatchOrderEmails,
	transitionOrder,
	type DispatchOrderEmailsDeps,
	type DispatchOrderEmailsOptions,
	type TransitionOrderCommand,
	type TransitionOrderDeps,
	type TransitionOrderResult,
} from "./orders/transition.js";
export {
	requestLogin,
	verifyLogin,
	type RequestLoginDeps,
	type RequestLoginResult,
	type VerifyLoginDeps,
	type VerifyLoginResult,
} from "./customers/auth.js";
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
	CancellationReason,
	FulfillmentKind,
	Order,
	OrderCancellation,
	OrderFulfillment,
	OrderLine,
	OrderTotals,
	PaymentMethod,
	ReconciliationOutcome,
	ReconciliationResolution,
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
export type {
	AppendOrderNoteInput,
	AppendOrderNoteResult,
	OrderNote,
	OrderNotesStore,
} from "./ports/order-notes-store.js";
export {
	appendOrderNote,
	listOrderNotes,
	type AppendNoteFailure,
	type AppendNoteOutcome,
	type AppendOrderNoteCommand,
	type AppendOrderNoteDeps,
} from "./orders/append-order-note.js";
export {
	resolveReconciliation,
	type ResolveReconciliationCommand,
	type ResolveReconciliationDeps,
	type ResolveReconciliationFailure,
	type ResolveReconciliationOutcome,
} from "./orders/resolve-reconciliation.js";
export {
	recordFulfillment,
	type RecordFulfillmentCommand,
	type RecordFulfillmentDeps,
	type RecordFulfillmentFailure,
	type RecordFulfillmentOutcome,
} from "./orders/record-fulfillment.js";
export {
	cancelOrder,
	type CancelOrderCommand,
	type CancelOrderDeps,
	type CancelOrderFailure,
	type CancelOrderOutcome,
} from "./orders/cancel-order.js";
export {
	DEFAULT_RECENT_ORDERS_LIMIT,
	getOrderCustomerContext,
	type CustomerLinkage,
	type OrderCustomerContext,
	type OrderCustomerContextDeps,
	type OrderCustomerIdentity,
} from "./orders/customer-context.js";
export {
	getOrderTimeline,
	type OrderTimeline,
	type OrderTimelineDeps,
	type OrderTimelineEntry,
} from "./orders/order-timeline.js";
export { expireOrders, type ExpireOrdersDeps } from "./orders/expire-orders.js";
export type { Clock } from "./ports/clock.js";
export type { IdGen } from "./ports/id-gen.js";
export { commit, release, removeStock, reserve, restock } from "./inventory/use-cases.js";
export type {
	InventoryPolicy,
	ProductCommerce,
	ProductCommerceStore,
	ProductCommerceUpdateResult,
	ProductCommerceView,
	ProductKind,
	ProductListCursor,
	ProductListFilter,
	ProductListPage,
	ProductListResult,
	ProductSummary,
	UpdateProductCommerceFieldsInput,
	UpsertProductCommerceInput,
} from "./ports/product-commerce-store.js";
export {
	InvalidProductFieldError,
	MissingProductIdError,
	SkuConflictError,
} from "./product-commerce/errors.js";
export {
	activateProductCommerce,
	deactivateProductCommerce,
	getProductCommerce,
	listProductCommerceByIds,
	softDeleteProductCommerce,
	updateProductCommerceFields,
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
// Phase 7: reporting (read-only) + settings tiering.
export type {
	DateRange,
	LowStockRow,
	PeriodBucket,
	ReportInterval,
	ReportingStore,
	StatusCount,
	TopProduct,
	TopProductsMetric,
} from "./ports/reporting-store.js";
export { REVENUE_COUNTING_STATES } from "./ports/reporting-store.js";
export type { OperationalSettings, SettingsStore } from "./ports/settings-store.js";
export { DEFAULT_OPERATIONAL_SETTINGS } from "./ports/settings-store.js";
export {
	getLowStockReport,
	getOrdersByStatusReport,
	getRevenueReport,
	getTopProductsReport,
	MAX_REPORT_RANGE_DAYS,
	ReportRangeTooWideError,
	type LowStockReportDeps,
} from "./reporting/use-cases.js";
export {
	getSettings,
	InvalidSettingsError,
	MAX_HOLD_TTL_MINUTES,
	updateSettings,
} from "./settings/use-cases.js";
