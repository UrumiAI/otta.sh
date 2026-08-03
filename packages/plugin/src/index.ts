// Public barrel of @otta-sh/plugin — the CommerceClient transport port, the
// admin/storefront page handlers, and the manifest constants the sandbox-
// clean guard test asserts against.
//
// The plugin exports NO field widget. Commercial fields live only in
// `product_commerce`, edited only from the admin's Pricing & inventory page
// ("one home per field", PR 1b); the CMS owns content and projects the title
// through the sync hooks. Re-adding a field widget here would recreate the
// second writer that change removed.
//
// The `FieldWidgetConfig` TYPE is still exported below. That is deliberate and
// is not a leftover: `types.ts` mirrors em-dash's Block Kit vocabulary in full
// so the plugin need not depend on the `emdash` package at runtime, and the
// type is part of that vocabulary. Nothing in this package constructs one.
// ── Phase 7: single `admin` dispatch route + Reports page + Settings form ────
export { ADMIN_ROUTE, createAdminRouteHandler } from "./admin/admin-route.js";
export {
	buildReportsBlocks,
	createReportsPageHandler,
	REPORTS_PAGE,
	type ReportsPageInput,
} from "./admin/reports-page.js";
export {
	createSettingsFormHandler,
	SETTINGS_PAGE,
	SETTINGS_SCHEMA,
	STORE_DISPLAY_NAME_KEY,
	type SettingsFormInput,
} from "./admin/settings-form.js";
export {
	ReportingSettingsClient,
	type LowStockWire,
	type OperationalSettingsWire,
	type RevenueBucketWire,
	type StatusCountWire,
	type TopProductWire,
	type UpdateSettingsResult,
} from "./admin/reporting-client.js";
// The Orders WRITE path (INC-R2, ADR-0015). It replaces the Block Kit Orders
// page handler this barrel used to export alongside `ORDERS_PAGE`: that screen
// was retired once the React console's writes moved off it, so `/orders` is
// served by the `otta-console` descriptor alone and there is no `AdminPageConfig`
// left to declare. The read path's relocated helpers (`orders-read.ts`) stay
// internal — only `orders-console-route.ts` consumes them. `OrdersStaged` and
// `OrdersDraft` were exported here too, for the two-step `-review` flow that has
// since been deleted as unreached; an outcome is now a notice and nothing else.
export {
	ORDERS_ACTION_IDS,
	dispatchOrdersAction,
	type OrdersActionPayload,
	type OrdersActionResult,
} from "./admin/orders-actions.js";
export {
	AdminOrdersClient,
	type OrderDetailResult,
	type OrderDetailWire,
	type OrderLineWire,
	type OrdersListFilter,
	type OrdersListResult,
	type OrderSummaryWire,
	type OrderTotalsWire,
	type TransitionOrderResult,
} from "./admin/admin-orders-client.js";
export {
	createProductsPageHandler,
	PRODUCTS_ACTION_IDS,
	PRODUCTS_PAGE,
	type ProductsPageInput,
} from "./admin/products-page.js";
export {
	AdminProductsClient,
	type ProductDetailWire,
	type ProductsListFilter,
	type ProductsListResult,
	type ProductSummaryWire,
} from "./admin/admin-products-client.js";
export {
	createTaxPageHandler,
	TAX_ACTION_IDS,
	TAX_PAGE,
	type TaxPageInput,
} from "./admin/tax-page.js";
export { formatBpsAsPercent, parsePercentToBps } from "./admin/percent-input.js";
export {
	createShippingPageHandler,
	SHIPPING_ACTION_IDS,
	SHIPPING_PAGE,
	type ShippingPageInput,
} from "./admin/shipping-page.js";
export {
	couponDiscountSummary,
	couponUsesSummary,
	couponWindowSummary,
	COUPONS_ACTION_IDS,
	COUPONS_PAGE,
	createCouponsPageHandler,
	type CouponsPageInput,
} from "./admin/coupons-page.js";
export { formatMinorUnitsInput, parseMinorUnitsInput } from "./admin/money-input.js";
export {
	AdminRulesClient,
	type AdminRulesClientOptions,
	type CouponEdit,
	type CouponInput,
	type CouponWire,
	type RulesCasUpdateResult,
	type RulesCreateResult,
	type RulesDeleteResult,
	type RulesUpdateResult,
	type ShippingMethodEdit,
	type ShippingMethodInput,
	type ShippingMethodWire,
	type ShippingRateEdit,
	type ShippingRateInput,
	type ShippingRateWire,
	type ShippingZoneEdit,
	type ShippingZoneInput,
	type ShippingZoneWire,
	type TaxClassInput,
	type TaxClassWire,
	type TaxRateEdit,
	type TaxRateInput,
	type TaxRateWire,
} from "./admin/admin-rules-client.js";
export {
	ALLOWED_HOSTS,
	COMMERCE_SERVICE_BASE_URL,
	SERVICE_TOKEN_KEY,
	serviceTokenFromKv,
	OTTA_PLUGIN_CAPABILITIES,
	OTTA_PLUGIN_ID,
	OTTA_PLUGIN_VERSION,
} from "./manifest.js";
export {
	CommerceClientError,
	type CartFailureReason,
	type CartLineWire,
	type CartResult,
	type CartWire,
	type CommerceClient,
	type CommerceMoney,
	type CommerceProductKind,
	type ProductCommerce,
	type ProductCommerceBatchItem,
	type UpsertProductCommerceInput,
} from "./product-commerce/commerce-client.js";
export { HttpCommerceClient } from "./product-commerce/http-commerce-client.js";
// ── Phase 2: catalog display (plan §7 steps 4–10, route shape per ADR-0003) ──
export {
	CommerceBatchLoader,
	DEFAULT_MAX_BATCH_SIZE,
	type CommerceBatchFetch,
	type CommerceBatchLoaderOptions,
} from "./catalog/commerce-batch-loader.js";
export { parseCommerceBatchItem, type CatalogProductCommerce } from "./catalog/commerce-view.js";
export { joinProduct, type CmsProductContent, type JoinedProduct } from "./catalog/join-product.js";
export { buildProductJsonLd } from "./catalog/product-json-ld.js";
export { formatMoney, majorUnits } from "./presentation/format-money.js";
export { cents, currency, type Cents, type Currency } from "./presentation/money.js";
export {
	createPdpRouteHandler,
	STOREFRONT_PRODUCT_ROUTE,
	type PdpRouteInput,
	type PdpRouteResult,
} from "./storefront/pdp-route.js";
export {
	createPlpRouteHandler,
	PLP_PAGE_SIZE_CAP,
	STOREFRONT_LIST_ROUTE,
	type PlpQuery,
	type PlpRouteInput,
	type PlpRouteResult,
} from "./storefront/plp-route.js";
export {
	buildProductViewModel,
	type AddToCartSlot,
	type AvailabilityToken,
	type ProductPriceViewModel,
	type ProductViewModel,
} from "./storefront/product-view-model.js";
// ── end Phase 2 catalog display ──────────────────────────────────────────────
// ── Phase 3 group E: cart (plan §7 step E1, shape per ADR-0003) ─────────────
export {
	CART_COOKIE_NAME,
	createCartCreateRouteHandler,
	createCartLineAddRouteHandler,
	createCartLineRemoveRouteHandler,
	createCartLineUpdateRouteHandler,
	createCartReadRouteHandler,
	STOREFRONT_CART_CREATE_ROUTE,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
	STOREFRONT_CART_READ_ROUTE,
	totalQty,
	type CartCookieDescriptor,
	type CartCreateRouteInput,
	type CartCreateRouteResult,
	type CartLineAddRouteInput,
	type CartLineMutationRouteResult,
	type CartLineRemoveRouteInput,
	type CartLineRemoveRouteResult,
	type CartLineUpdateRouteInput,
	type CartReadRouteInput,
	type CartReadRouteResult,
} from "./storefront/cart-routes.js";
export {
	type CartLinePricing,
	type CartMoneyWire,
	type CartPricingWire,
} from "./storefront/cart-pricing.js";
// ── end Phase 3 group E: cart ────────────────────────────────────────────────
// ── Phase 4: checkout (storefront-checkout plan §1.2, ADR-0012) ──────────────
export {
	createCheckoutPlaceRouteHandler,
	createCheckoutSummaryRouteHandler,
	createOrderRouteHandler,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
	STOREFRONT_CHECKOUT_SUMMARY_ROUTE,
	STOREFRONT_ORDER_ROUTE,
	type CheckoutPlaceRouteInput,
	type CheckoutPlaceRouteResult,
	type CheckoutSummaryRouteInput,
	type CheckoutSummaryRouteResult,
	type OrderRouteInput,
	type OrderRouteResult,
} from "./storefront/checkout-routes.js";
export {
	buildCheckoutLines,
	buildCheckoutTotals,
	buildOrderView,
	checkoutIdempotencyKey,
	isAlreadyPlaced,
	NOT_APPLICABLE_LABEL,
	NOT_CALCULATED_LABEL,
	stripeClientSecret,
	type CheckoutAmountView,
	type CheckoutLineView,
	type CheckoutTotalsView,
	type OrderLineView,
	type PublicOrderView,
} from "./storefront/checkout-view-model.js";
export {
	type CheckoutFailureReason,
	type CheckoutResult,
	type ClientActionWire,
	type PaymentIntentWire,
	type PublicOrderResult,
	type PublicOrderWire,
	type QuoteBreakdownWire,
	type QuoteFailureReason,
	type QuoteRequestWire,
	type QuoteResult,
	type ShippingAddressWire,
} from "./product-commerce/commerce-client.js";
// ── end Phase 4 checkout ─────────────────────────────────────────────────────
export {
	deriveDeleteIdempotencyKey,
	derivePublishIdempotencyKey,
	deriveSaveIdempotencyKey,
	deriveUnpublishIdempotencyKey,
} from "./sync/derive-idempotency-key.js";
export {
	createAfterDeleteHandler,
	createAfterPublishHandler,
	createAfterSaveHandler,
	createAfterUnpublishHandler,
	PRODUCTS_COLLECTION,
} from "./sync/hooks.js";
export type {
	AdminPageConfig,
	Block,
	BlockResponse,
	ContentDeleteEvent,
	ContentHookEvent,
	ContentStateChangeEvent,
	Element,
	FieldWidgetConfig,
	HttpAccess,
	KvAccess,
	PluginContext,
	SandboxedPlugin,
	SettingsFieldSpec,
} from "./types.js";
export { default as plugin } from "./plugin.js";
