// Public barrel of @otta-sh/domain — ports, use-cases, and branded types.
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
	CouponCodeConflictError,
	CouponIdCollisionError,
	foldCouponCode,
	isCouponCodeConflictError,
	isCouponIdCollisionError,
} from "./pricing/coupon-code.js";
export {
	parseCouponInstant,
	validateCoupon,
	type CouponValidationContext,
	type CouponValidationFailure,
	type ValidateCouponResult,
} from "./pricing/validate-coupon.js";
export {
	computeQuote,
	sumLineSubtotals,
	type QuoteCommand,
	type QuoteContext,
	type QuoteDeps,
	type QuoteFailure,
	type QuoteResult,
	type QuoteTax,
} from "./pricing/quote.js";
// ADR-0032: the store's tax options (WooCommerce's Tax tab).
export {
	effectiveTaxSettings,
	LEGACY_TAX_SETTINGS,
	NEW_STORE_TAX_SETTINGS,
	parseTaxSettings,
	readTaxSettings,
	TAX_DISABLED_CALCULATOR_ID,
	type ShippingTaxClassSetting,
	type TaxBaseAddress,
	type TaxSettings,
} from "./pricing/tax-settings.js";
// ADR-0030: the tax calculator hook, the built-in rate table, the order's frozen snapshot.
export {
	DEFAULT_TAX_CALCULATOR_TIMEOUT_MS,
	isValidCalculatorId,
	type TaxAddress,
	type TaxCalculator,
	type TaxLine,
	type TaxRefusal,
	type TaxRequest,
	type TaxRequestLine,
	type TaxResult,
} from "./pricing/tax-calculator.js";
export {
	createRateTableCalculator,
	RATE_TABLE_CALCULATOR_ID,
} from "./pricing/rate-table-calculator.js";
export { validateTaxResult } from "./pricing/validate-tax-result.js";
export {
	readOrderTaxSnapshot,
	type OrderTaxSnapshot,
	type OrderTaxSnapshotV0,
	type OrderTaxSnapshotV1,
} from "./orders/order-tax-snapshot.js";
// ADR-0028 Decision 1: one quote command for checkout, the order and the x402 gate.
export { quoteCommandFor, type PricedLine, type QuoteInput } from "./pricing/quote-input.js";
// ADR-0021: ISO 3166 codes (CLDR) and the zone derived from the address.
export { COUNTRY_CODES, SUBDIVISIONS } from "./pricing/iso-3166.generated.js";
export { CURRENCY_CODES, isIsoCurrencyCode } from "./pricing/iso-4217.js";
export {
	isCodeShapedRegion,
	normalizeCountryCode,
	normalizeSubdivision,
	parseZoneRegions,
	REGION_CODE_PATTERN,
	validateZoneRegionsInput,
	type NormalizeSubdivisionResult,
	type ValidateZoneRegionsResult,
} from "./pricing/region-codes.js";
export {
	resolveShippingZone,
	type ZoneDestination,
	type ZoneResolution,
} from "./pricing/zone-match.js";
export { quoteShippingOptions, type ShippingOption } from "./pricing/shipping-options.js";
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
	UpdateTaxClassInput,
	UpdateTaxClassResult,
	UpdateTaxRateInput,
	UpdateTaxRateResult,
} from "./ports/tax-rules-store.js";
// One tax rate per (class, zone): the refusal, and the rule for duplicates written before it.
export {
	appliedTaxRate,
	effectiveTaxRates,
	hasTaxRateDuplicateCode,
	isTaxRateDuplicateError,
	shadowedTaxRates,
	TaxRateDuplicateError,
	taxRateSlotOccupant,
	type TaxRateSlotted,
} from "./pricing/tax-rate-uniqueness.js";
export type {
	CouponListCursor,
	CouponListFilter,
	CouponListPage,
	CouponListResult,
	CouponRecord,
	CouponRedemption,
	CouponStore,
	CouponSummary,
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
	isEmailAddress,
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
	ReservationNotFoundError,
	ReservationNotHeldError,
	StockMovementMismatchError,
	assertStockMovementOptions,
	type AdoptInput,
	type AdoptManyInput,
	type AdoptManyResult,
	type AdoptResult,
	type CommitManyResult,
	type InventoryStore,
	type ReserveResult,
	type RestockResult,
	type StaleOnHandResult,
	type StockMovementApplied,
	type StockMovementOptions,
	type StockRemovalResult,
} from "./ports/inventory-store.js";
export type {
	CancelOrderInput,
	CancelOrderStoreResult,
	CompleteCancellationRestockInput,
	CompleteCancellationRestockResult,
	CapturedPayment,
	CreateOrderInput,
	CreateOrderLineInput,
	CreateOrderResult,
	CreateOrderTotalsInput,
	ExpiredOrder,
	OrderExpiryListOptions,
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
	OrderLedger,
	RefundRetry,
	RefundRetrySchedule,
	OrderNoticeInput,
	OutboxEmail,
	ReleaseEmailClaimOptions,
	PaymentIntentCancelOutcome,
	PaymentIntentCancelUpdate,
	PaymentIntentRecord,
	ClaimEmailForOrderOptions,
	RecordFulfillmentInput,
	RecordFulfillmentStoreResult,
	RecordPaymentInput,
	RecordPaymentIntentInput,
	RecordRefundInput,
	RecordRefundStoreResult,
	FinalizeRefundInput,
	FinalizeRefundStoreResult,
	RefundKind,
	RefundPurpose,
	RefundRecord,
	RefundStatus,
	ReconciliationFlagGuard,
	ResolveReconciliationInput,
	ResolveReconciliationStoreResult,
} from "./ports/order-store.js";
export {
	EmailSendTimeoutError,
	type EmailSendTimeoutLike,
	EmailTransportUnavailableError,
	isCutShortEmailTimeout,
	isEmailSendTimeoutError,
	isEmailTransportUnavailableError,
	type EmailSender,
	type EmailTemplate,
	type SendEmailInput,
} from "./ports/email-sender.js";
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
	PruneChallengesOptions,
	VerifyChallengeResult,
} from "./ports/credential-verifier.js";
export type { Address, AddressKind, Customer } from "./customers/model.js";
export { DuplicateCustomerEmailError, type LoginFailure } from "./customers/errors.js";
export {
	emailTemplateForNotice,
	emailTemplateForState,
	isLegalOrderTransition,
	legalNextStates,
	ORDER_EMAIL_TEMPLATE_FOR_STATE,
	ORDER_NOTICE_EMAIL_TEMPLATE,
	ORDER_STATE_MACHINE,
} from "./orders/state-machine.js";
// Template rendering lives beside `buildOrderEmailData` and `EmailTemplate`
// because every `EmailSender` adapter needs it, and they live outside the domain:
// today the plugin's `CtxEmailSender` over EmDash's `ctx.email` (ADR-0031). It is a PURE function
// of a template + explicit data — no IO, no store reach-back — so it does not
// widen the domain's purity contract by one byte.
export {
	customerSafeCancellationCopy,
	EMAIL_NOT_CALCULATED_LABEL,
	renderEmail,
	type EmailRenderContext,
	type RenderedEmail,
} from "./email/render.js";
// The shopper-facing name of an order (its products, never its id) — one pure
// function shared by the order emails and, through `@otta-sh/plugin`, the
// storefront, so the two cannot spell the same order differently.
export {
	ORDER_LABEL_FALLBACK,
	ORDER_LABEL_TITLE_MAX_LENGTH,
	orderLabel,
	type OrderLabelLine,
} from "./orders/order-label.js";
// What an order's total is called ("Paid" / "Total") and what the ledger shows
// refunded — shared by the order emails and, through `@otta-sh/plugin`, the
// storefront's order pages.
export { orderTotalLabel, recordedRefundTotal } from "./orders/order-total-label.js";
export {
	buildOrderEmailData,
	dispatchOrderEmails,
	dispatchOrderEmailsForOrder,
	orderHasEmailRecipient,
	MAX_UNCOUNTED_TIMEOUTS,
	TIMEOUT_BACKOFF_BASE_MS,
	TIMEOUT_BACKOFF_MAX_MS,
	TIMEOUT_FAILURE_REASON,
	timeoutBackoffMs,
	OUTBOX_EMAIL_MAX_AGE_MS,
	TRANSPORT_UNAVAILABLE_RETRY_MS,
	UNTRIED_RETRY_MS,
	adminNextStates,
	manualPaymentAllowed,
	markRefundedAllowed,
	markRefundedRefusal,
	transitionOrder,
	transitionOrderAsAdmin,
	unrefundedCapturedCents,
	type RefundLedgerFacts,
	type TransitionOrderAsAdminFailure,
	type TransitionOrderAsAdminResult,
	type DispatchOrderEmailsDeps,
	type DispatchOrderEmailsForOrderOptions,
	type DispatchOrderEmailsOptions,
	type TransitionOrderCommand,
	type TransitionOrderDeps,
	type TransitionOrderResult,
} from "./orders/transition.js";
export {
	resolveUnverifiedRefund,
	type ResolveFollowUp,
	type ResolveUnverifiedRefundCommand,
	type ResolveUnverifiedRefundDeps,
	type ResolveUnverifiedRefundResult,
} from "./orders/resolve-unverified-refund.js";
export {
	PROVIDER_PARTLY_REFUNDED_FLAG_PREFIX,
	PROVIDER_REFUNDED_FLAG_PREFIX,
	providerRefundedFlag,
} from "./orders/provider-refunded-flag.js";
export {
	requestLogin,
	verifyLogin,
	type RequestLoginDeps,
	type RequestLoginResult,
	type VerifyLoginDeps,
	type VerifyLoginResult,
} from "./customers/auth.js";
export {
	checkoutOwner,
	listCustomerOrders,
	type CheckoutOwnerDeps,
	type CustomerOrdersDeps,
} from "./customers/customer-orders.js";
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
export {
	PaymentIntentError,
	type CancelIntentInput,
	type CancelIntentResult,
	type ClientAction,
	type ConfirmationResult,
	type CreateIntentInput,
	type CreateIntentLine,
	type CreateIntentShipTo,
	type PaymentGateway,
	type PaymentIntentErrorInput,
	type PaymentIntentHandle,
	type RawConfirmation,
	type RefundFailureReason,
	type RefundInput,
	type RefundResult,
	type X402Proof,
} from "./ports/payment-gateway.js";
export type {
	X402DecodedPayment,
	X402DecodeResult,
	X402MalformedDetail,
	X402MatchResult,
	X402MismatchField,
	X402NotOfferedDetail,
	X402Offer,
	X402OfferResult,
	X402OpaquePayload,
	X402PaymentRequired,
	X402PaymentRequirements,
	X402Rail,
	X402SettleResult,
	X402UnavailableCause,
	X402UnconfirmedCause,
	X402VerifyResult,
} from "./ports/x402-rail.js";
export type {
	CancellationReason,
	CancellationRefund,
	CancellationRestockPending,
	FulfillmentKind,
	Order,
	OrderAddress,
	OrderCancellation,
	OrderFulfillment,
	OrderLine,
	OrderNotice,
	OrderTotals,
	PaymentMethod,
	ReconciliationOutcome,
	ReconciliationResolution,
} from "./orders/model.js";
export {
	findIllFormedText,
	isWellFormedText,
	repairIllFormedText,
	toWellFormedText,
} from "./text/well-formed.js";
export {
	normalizeOrderAddress,
	ORDER_ADDRESS_MAX_LENGTHS,
	type NormalizeOrderAddressResult,
	type OrderAddressInput,
} from "./orders/order-address.js";
export type { CreateOrderFailure, SettleFailure } from "./orders/errors.js";
export {
	createOrderFromCart,
	DEFAULT_CHECKOUT_TTL_MS,
	type CreateOrderCommand,
	type CreateOrderDeps,
	type CreateOrderFromCartResult,
} from "./orders/create-order-from-cart.js";
export { settleOrder, type SettleDeps, type SettleResult } from "./orders/settle-order.js";
export {
	computeRefundCeiling,
	refundOrder,
	sumCapturedPayments,
	sumFinalizedRefunds,
	sumRefunds,
	type RefundOrderCommand,
	type RefundOrderDeps,
	type RefundOrderFailure,
	type RefundOrderOutcome,
} from "./orders/refund-order.js";
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
	CANCELLATION_RESTOCK_BACKOFF_MAX_MS,
	CANCELLATION_RESTOCK_BACKOFF_MS,
	CANCELLATION_RESTOCK_FLAG_AFTER,
	cancellationRestockBackoffMs,
	cancelOrderWithRefund,
	finishCancellationRestock,
	type FinishCancellationRestockDeps,
	type FinishCancellationRestockOutcome,
	type RestockSkip,
	type CancelOrderWithRefundCommand,
	type CancelOrderWithRefundDeps,
	type CancelOrderWithRefundFailure,
	type CancelOrderWithRefundOutcome,
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
export {
	expireOrders,
	expireOrdersBatch,
	type ExpireOrdersBatchOptions,
	type ExpireOrdersDeps,
} from "./orders/expire-orders.js";
export { assertSweepLimit, type SweepBatchOptions, type SweepBatchResult } from "./sweep/batch.js";
export { UnitBackoff, type UnitBackoffOptions } from "./sweep/backoff.js";
export {
	cancelDueIntents,
	DEFAULT_INTENT_CANCEL_BATCH,
	DEFAULT_INTENT_CANCEL_MAX_ATTEMPTS,
	type CancelDueIntentsDeps,
	type CancelDueIntentsOptions,
} from "./orders/cancel-due-intents.js";
export {
	classifyLatePayment,
	escalateStaleLateRefunds,
	isUnpaidTerminalState,
	LATE_REFUND_GIVE_UP_MS,
	lateRefundRetryDelayMs,
	LATE_PAYMENT_REFUNDED_BY,
	latePaymentRefundKey,
	leftPendingUnpaid,
	providerRefOfLateRefundKey,
	readOrderWithLatePayment,
	refundLatePayment,
	retryLatePaymentRefunds,
	type LateCapture,
	type LatePaymentAnomaly,
	type LatePaymentDeps,
	type LatePaymentOutcome,
	type LatePaymentStatus,
	type LazyGateways,
	type RetryLatePaymentRefundsOptions,
} from "./orders/late-payment.js";
export type { Clock } from "./ports/clock.js";
export type { IdGen } from "./ports/id-gen.js";
export { commit, release, removeStock, reserve, restock } from "./inventory/use-cases.js";
export { isProductTaxStatus, PRODUCT_TAX_STATUSES } from "./ports/product-commerce-store.js";
export type {
	DownloadAsset,
	InventoryPolicy,
	ProductCommerce,
	ProductCommerceStore,
	ProductCommerceUpdateResult,
	ProductCommerceView,
	ProductKind,
	ProductTaxStatus,
	ProductListCursor,
	ProductListFilter,
	ProductListPage,
	ProductListResult,
	ProductSummary,
	ProductVariant,
	ProductVariantSummary,
	ProductVariantUpdateResult,
	UpdateProductCommerceFieldsInput,
	UpdateProductVariantFieldsInput,
	UpsertProductCommerceInput,
	UpsertProductVariantInput,
} from "./ports/product-commerce-store.js";
export {
	InvalidLowStockThresholdError,
	InvalidProductFieldError,
	isValidLowStockThreshold,
	MAX_LOW_STOCK_THRESHOLD,
	MissingProductIdError,
	MissingVariantKeyError,
	SkuConflictError,
	SkuHeldStockError,
	SkuStockConflictError,
} from "./product-commerce/errors.js";
export {
	activateProductCommerce,
	deactivateProductCommerce,
	deactivateProductVariant,
	getProductCommerce,
	listProductCommerceByIds,
	listProductVariants,
	softDeleteProductCommerce,
	updateProductCommerceFields,
	updateProductVariantFields,
	upsertProductCommerce,
	upsertProductVariant,
	type ProductCommerceDeps,
} from "./product-commerce/use-cases.js";
export { isProductLive } from "./product-commerce/sellable.js";
export {
	DOWNLOAD_FALLBACK_CONTENT_TYPE,
	DOWNLOAD_FALLBACK_FILENAME,
	DOWNLOAD_KEY_RANDOM_BYTES,
	downloadContentTypeFor,
	isDownloadAssetKeyFor,
	MAX_DOWNLOAD_FILENAME_LENGTH,
	mintDownloadAssetKey,
	sanitizeDownloadFilename,
	validateDownloadAsset,
} from "./product-commerce/download-asset.js";
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
	type ExpiryListOptions,
	type RecordedCartMutation,
	type ReservationLifecycle,
	type UpsertLineInput,
} from "./ports/cart-store.js";
export {
	addLine,
	createCart,
	DEFAULT_HOLD_TTL_MS,
	expireHolds,
	expireHoldsBatch,
	getCart,
	removeLine,
	replaceSpentCart,
	updateLine,
	type AddLineResult,
	type CartDeps,
	type CartFailure,
	type RemoveLineResult,
	type ReplaceSpentCartDeps,
	type ReplaceSpentCartResult,
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
export type {
	OperationalSettings,
	SettingsStore,
	SettingsUpdateOptions,
} from "./ports/settings-store.js";
export {
	DEFAULT_OPERATIONAL_SETTINGS,
	isSettingsPreconditionFailedError,
	SettingsPreconditionFailedError,
	settingsUpdateAllowed,
} from "./ports/settings-store.js";
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
export type { AttemptThrottle } from "./ports/attempt-throttle.js";
