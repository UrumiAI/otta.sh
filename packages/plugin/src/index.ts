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
	type LowStockWire,
	type OperationalSettingsWire,
	// The surface the Reports page, the Settings form and the Products console
	// hold (work order 02, INC-B10c-ii). Exported from the
	// entry point because a parameter type a consumer cannot name is not a usable
	// signature.
	type ReportingSettingsSurface,
	type RevenueBucketWire,
	type StatusCountWire,
	type TopProductWire,
	// WHY a settings save failed, structurally — the field a caller branches on
	// before falling back to the HTTP tier's legacy `status`.
	type UpdateSettingsFailureReason,
	type UpdateSettingsResult,
} from "./admin/reporting-settings-surface.js";
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
	type OrderDetailResult,
	type OrderDetailWire,
	type OrderLineWire,
	type OrdersListFilter,
	type OrdersListResult,
	type OrderSummaryWire,
	type OrderTotalsWire,
	type TransitionOrderResult,
} from "./admin/admin-orders-surface.js";
// `PRODUCTS_PAGE`, `ProductsPageInput` and the page handler this barrel used to
// export are gone (INC-R3, ADR-0015): that Block Kit screen was retired once the
// React console's writes moved off it, so `/products` is served by the
// `otta-console` descriptor alone and there is no `AdminPageConfig` left to
// declare. The read path's relocated helpers (`products-read.ts`) stay internal —
// only `products-console-route.ts` consumes them.
export {
	PRODUCTS_ACTION_IDS,
	dispatchProductsAction,
	type ProductsActionPayload,
	type ProductsActionResult,
} from "./admin/products-actions.js";
// INC-D1 — the console's two interaction types and the products resource prefix,
// exported so an OUT-OF-BROWSER caller can drive the admin route without
// restating its wire strings. The staging quickstart seeder is the first: with
// commerce in-process there is no service REST API to seed through any more, so
// the seeder posts the same `otta_console_read` / `otta_console_act` envelopes
// the React console posts. A literal copy of "otta_console_act" in a script is a
// string that fails by being SILENTLY UNROUTED — `admin-route.ts` dispatches on
// exactly these values, and a stale copy produces a refusal, not an error.
//
// EXACTLY THE THREE THE SEEDER USES. `CONSOLE_INTERACTIONS` (the set both
// discriminators belong to) and `ConsoleFailure` (the route's internal refusal
// shape) were exported alongside them and have no consumer outside this package;
// a barrel entry with no caller is API surface bought with nothing, and this
// barrel is `@otta-sh/plugin`'s public one.
export { CONSOLE_ACT_INTERACTION, CONSOLE_READ_INTERACTION } from "./admin/console-transport.js";
export { PRODUCTS_CONSOLE_RESOURCE_PREFIX } from "./admin/products-console-route.js";
export {
	// The surface, and the type `dispatchProductsAction`'s third
	// parameter now has (work order 02, INC-B10b-i). Exported from the entry point
	// because a parameter type a consumer cannot name is not a usable signature.
	type AdminProductsSurface,
	type ProductDetailWire,
	type ProductsListFilter,
	type ProductsListResult,
	type ProductSummaryWire,
} from "./admin/admin-products-surface.js";
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
	// The surface the three rules console pages hold (work
	// order 02, INC-B10c-i). Exported from the entry point because a parameter
	// type a consumer cannot name is not a usable signature.
	type AdminRulesSurface,
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
} from "./admin/admin-rules-surface.js";
export {
	ALLOWED_HOSTS,
	IN_PROCESS_EGRESS_URLS,
	type InProcessEgressUrls,
	resolveAllowedHosts,
	SMTP2GO_API_HOSTS,
	STRIPE_API_HOST,
	OTTA_PLUGIN_CAPABILITIES,
	OTTA_PLUGIN_ID,
	OTTA_PLUGIN_VERSION,
} from "./manifest.js";
// INC-D1 — the storage layout commerce truth lives in, exported so the DEPLOYING
// SITE's plugin descriptor can declare it without restating a single collection
// name or index list. `commerce-storage.ts` was written for exactly this moment
// ("the descriptor WILL import it when the deployment flips to this transport");
// until now its only consumers were this package's own test tiers, which reach the
// module directly, so it never needed to be on the barrel.
//
// A DECLARED INDEX IS A READ CONTRACT, not a performance knob: the host refuses a
// `where`/`orderBy` on an undeclared field at RUNTIME. A site that declared a
// subset of this map would not run slower — it would throw. That is why the map is
// exported whole and must be spread, never transcribed.
export {
	COMMERCE_STORAGE_COLLECTIONS,
	COMMERCE_STORAGE_COLLECTION_NAMES,
	type CommerceCollectionDeclaration,
	type CommerceStorageLayout,
} from "./commerce/commerce-storage.js";
// INC-C4 — the scheduled commerce sweep. The task name and schedule are exported
// so a deploying site can assert what the plugin registers without restating the
// strings, and `runCommerceSweeps` so a trigger can drive one tick on demand.
export {
	createActivateHandler,
	createCronHandler,
	ensureSweepTaskScheduled,
	MAINTENANCE_LEG_INTERVAL_MS,
	MAINTENANCE_LEGS,
	runCommerceSweeps,
	SWEEP_EMAIL_SEND_TIMEOUT_MS,
	SWEEP_HOOK_TIMEOUT_MS,
	SWEEP_LEGS,
	SWEEP_SCHEDULE,
	SWEEP_TASK_NAME,
	SWEEP_TICK_BUDGET_MS,
	SWEEP_TICK_QUERY_BUDGET,
	SWEEP_TICK_RESERVE_MS,
	type CommerceSweepOptions,
	type CommerceSweepSummary,
	type SweepLeg,
	type SweepLegOutcome,
	type SweepScheduleOutcome,
} from "./cron/index.js";
// The "Background work per minute" setting — the sweep's per-tick query budget,
// chosen per Cloudflare plan. Exported so a site or an ops script can read or
// pre-set the same key the Settings screen writes.
export {
	BACKGROUND_WORK_KEY,
	BACKGROUND_WORK_PRESETS,
	DEFAULT_BACKGROUND_WORK,
	MAX_BACKGROUND_WORK,
	MIN_BACKGROUND_WORK,
	validateBackgroundWork,
} from "./cron/background-work-setting.js";
// INC-C3 — the write-only payment/email secret keys and their fail-closed
// readers. Exported so a deploying site can assert what the plugin stores, and
// so INC-C1b's settle route can reach the Stripe webhook secret, without either
// restating the key strings.
export {
	constantTimeEquals,
	emailApiKeyFromKv,
	EMAIL_API_KEY_KEY,
	type PaymentSecretKey,
	type PaymentSecrets,
	PAYMENT_SECRET_KEYS,
	readPaymentSecrets,
	readWriteOnlySecret,
	stripeSecretKeyFromKv,
	STRIPE_SECRET_KEY_KEY,
	stripeWebhookSecretFromKv,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_HEADER,
	WEBHOOK_EDGE_TOKEN_KEY,
	webhookEdgeTokenFromKv,
	x402FacilitatorSecretFromKv,
	X402_FACILITATOR_API_KEY_KEY,
} from "./payment-secrets.js";
// INC-C5 — email dispatch and the x402 wiring, in-process. Both are
// exported so a deploying site can name the kv settings keys it provisions
// (`settings:emailFrom`, `settings:x402PayTo`, `settings:x402Accepts`) without
// restating the strings, and so a suite can build either adapter directly.
export {
	CtxHttpEmailSender,
	DEFAULT_EMAIL_FROM,
	EMAIL_FROM_KEY,
	makeEmailSender,
	type CtxHttpEmailSenderOptions,
	type EmailSenderEgress,
} from "./email/ctx-http-email-sender.js";
// The "Email provider" choice (Resend-shaped default, or SMTP2GO) and the
// SMTP2GO sender, so a deploying site can name the kv keys it provisions.
export {
	DEFAULT_EMAIL_PROVIDER,
	DEFAULT_SMTP2GO_REGION,
	EMAIL_PROVIDER_KEY,
	EMAIL_PROVIDERS,
	type EmailProviderId,
	SMTP2GO_REGION_KEY,
	SMTP2GO_REGIONS,
	type Smtp2goRegion,
} from "./email/email-provider.js";
export { EmailProviderError, type EmailProviderErrorKind } from "./email/http-email-sender.js";
export {
	Smtp2goEmailSender,
	type Smtp2goEmailSenderOptions,
} from "./email/smtp2go-email-sender.js";
export {
	DEFAULT_X402_ACCEPTS,
	wireX402Gateway,
	X402_ACCEPTS_KEY,
	X402_PAYTO_KEY,
	x402GatewayFromCtx,
	type WireX402Options,
	type X402Egress,
} from "./payments/x402-wiring.js";
// INC-C1b — the PUBLIC Stripe webhook settle route. The constant and the result
// shape are exported because the calling site has to name the route and
// reconstruct Stripe's expected status from the response.
export {
	createStripeWebhookSettleHandler,
	settleResultToResponse,
	STRIPE_WEBHOOK_SETTLE_ROUTE,
	type StripeWebhookSettleInput,
	type StripeWebhookSettleReason,
	type StripeWebhookSettleResult,
} from "./webhooks/stripe-settle-route.js";
// Issue #376 — the PUBLIC download gate. The site's download endpoint names the
// route and reads its answer: the file to stream, or the refusal it maps to a
// status. Only the constant and the shapes; the handler stays internal.
export {
	ENTITLEMENT_DOWNLOAD_ROUTE,
	type EntitlementDownloadInput,
	type EntitlementDownloadResult,
} from "./entitlements/download-route.js";
export { type DownloadAssetWire } from "./admin/admin-products-surface.js";
// Issue #376 increment 4 — the site's admin upload endpoint mints the key and
// coerces the filename and type with the SAME rules the admin save validates,
// so what it uploads is always a descriptor the save accepts.
export {
	DOWNLOAD_FALLBACK_CONTENT_TYPE,
	DOWNLOAD_KEY_RANDOM_BYTES,
	downloadContentTypeFor,
	mintDownloadAssetKey,
	sanitizeDownloadFilename,
} from "@otta-sh/domain";
export {
	CommerceClientError,
	type CartFailureReason,
	type CartLineWire,
	type CartResult,
	type CartWire,
	type ReplaceCartResult,
	type CommerceClient,
	type CommerceMoney,
	type CommerceProductKind,
	type ProductCommerce,
	type ProductCommerceBatchItem,
	type UpsertProductCommerceInput,
} from "./product-commerce/commerce-client.js";
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
	type RenderBusy,
	type RenderGuardFailure,
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
	CART_COOKIE_PATH,
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
	createOrderAbandonRouteHandler,
	createOrderResumeRouteHandler,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
	STOREFRONT_CHECKOUT_SUMMARY_ROUTE,
	STOREFRONT_ORDER_ROUTE,
	STOREFRONT_ORDER_ABANDON_ROUTE,
	STOREFRONT_ORDER_RESUME_ROUTE,
	type CheckoutPlaceRouteInput,
	type CheckoutLockedOrderView,
	type CheckoutPlaceRouteResult,
	type CheckoutSelectionErrors,
	type CheckoutSelectionView,
	type CheckoutShippingView,
	type CheckoutSummaryRouteInput,
	type CheckoutSummaryRouteResult,
	type CheckoutSummaryView,
	type OrderRouteInput,
	type OrderRouteResult,
	type OrderAbandonRouteInput,
	type OrderAbandonRouteResult,
	type OrderResumeRouteInput,
	type OrderResumeRouteResult,
} from "./storefront/checkout-routes.js";
// ── Phase 5: storefront customer account (ADR-0004, issue #306) ─────────────
export {
	ACCOUNT_ADDRESSES_ROUTE,
	ACCOUNT_LOGIN_PATH,
	ACCOUNT_LOGIN_REQUEST_ROUTE,
	ACCOUNT_LOGIN_VERIFY_ROUTE,
	ACCOUNT_LOGOUT_ROUTE,
	ACCOUNT_ME_ROUTE,
	ACCOUNT_ORDER_ROUTE,
	ACCOUNT_ORDERS_PATH,
	ACCOUNT_ORDERS_ROUTE,
	SESSION_COOKIE_NAME,
	type AccountAddressesResult,
	type AccountLoginRequestResult,
	type AccountLoginVerifyResult,
	type AccountLogoutResult,
	type AccountMeResult,
	type AccountOrderResult,
	type AccountOrdersResult,
	type SessionCookieDescriptor,
} from "./storefront/account-routes.js";
export {
	ACCOUNT_VERIFY_PATH,
	isValidLoginLinkUrl,
	LOGIN_LINK_TTL_MS,
	LOGIN_LINK_URL_KEY,
} from "./storefront/login-link.js";
export {
	buildCheckoutLines,
	buildCheckoutTotals,
	buildOrderView,
	checkoutIdempotencyKey,
	isAlreadyPlaced,
	NOT_APPLICABLE_LABEL,
	NOT_CALCULATED_LABEL,
	orderTotalsFlags,
	stripeClientSecret,
	type CheckoutAmountView,
	type CheckoutLineView,
	type CheckoutTotalsView,
	type CouponSelectionReason,
	type DestinationSelectionReason,
	type LockedCheckoutPhase,
	type OrderLineView,
	type PublicOrderView,
	type ShippingOptionView,
	type ShippingSelectionReason,
	type UncalculatedReason,
} from "./storefront/checkout-view-model.js";
// The storefront's one locale — the site's `SITE_LOCALE` and the order emails share it.
export { STOREFRONT_LOCALE } from "./storefront/route-input.js";
// ADR-0021: the ISO 3166 codes (CLDR) and the one region SHAPE rule, for a
// site that builds the country picker and pre-checks a typed region code the
// way the routes do. Membership is still the domain's call.
export { COUNTRY_CODES, isCodeShapedRegion, REGION_CODE_PATTERN } from "@otta-sh/domain";
// The shopper-facing name of an order — its products, never its id. The site
// names an order on its confirmation and account pages; the order emails name
// it through the same function in the domain, so the site takes THAT one rather
// than a copy that could spell the same order differently.
export { ORDER_LABEL_FALLBACK, orderLabel, type OrderLabelLine } from "@otta-sh/domain";
// "Paid" / "Total" for an order's figure — the domain's one rule, shared with the
// order emails.
export { orderTotalLabel } from "@otta-sh/domain";
// The sign-in link's per-address cap and lifetime, as the in-process verifier
// enforces them (its defaults — `createInProcessCommerceStores` passes no
// override), so a storefront's copy about them cannot drift from the truth.
//
// Declared HERE as plugin constants rather than re-exported from
// `@otta-sh/store-emdash`: a re-export makes the emitted declarations reach into
// that package's types, and through them the host's toolchain (vite, postcss,
// typescript), which the declaration bundler cannot bundle — the plugin build
// fails. Same values; the store's defaults stay the one source.
// The lifetime is `storefront/login-link.ts`'s LOGIN_LINK_TTL_MS (exported
// above), the one value the verifier is built with and the sign-in email states.
import { DEFAULT_MAX_ACTIVE_CHALLENGES as STORE_MAX_ACTIVE_CHALLENGES } from "@otta-sh/store-emdash";
export const LOGIN_LINK_MAX_ACTIVE: number = STORE_MAX_ACTIVE_CHALLENGES;
// The ship-to's per-field length bounds the domain enforces, for a site that
// bounds its address inputs and refuses an over-long field as the address
// error it is rather than a generic one.
export { ORDER_ADDRESS_MAX_LENGTHS } from "@otta-sh/domain";
// The shopper-facing cart quantity cap the routes enforce, for a site that
// bounds its quantity field and names the limit instead of a generic failure.
export { CART_LINE_MAX_QTY } from "./commerce/commerce-input.js";
// The checkout email's (buyerRef's) bound the place route enforces, for a
// site's email field.
export { BUYER_REF_MAX } from "./commerce/commerce-input.js";
export {
	createShopperStateHandler,
	STOREFRONT_SHOPPER_STATE_ROUTE,
	type ShopperStateInput,
	type ShopperStateResult,
} from "./storefront/shopper-state-route.js";
export {
	type AccountOrderWire,
	type CheckoutFailureReason,
	type CheckoutResult,
	type ClientActionWire,
	type PaymentIntentWire,
	type PublicOrderResult,
	type ResumeOrderPaymentResult,
	type ResumeProof,
	type PublicOrderWire,
	type QuoteBreakdownWire,
	type QuoteDestinationWire,
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
