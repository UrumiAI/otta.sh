// Public barrel of @urumi/plugin — the CommerceClient transport port, the
// widget's pure element-builder, and the manifest constants the sandbox-
// clean guard test asserts against.
export { buildProductDataElements, productDataWidget } from "./admin/product-data-widget.js";
export { PANEL_STATE_ROUTE } from "./admin/panel-state-route.js";
export { PRODUCT_COMMERCE_ROUTE } from "./admin/product-commerce-route.js";
export type { ProductCommerceRouteInput } from "./admin/product-commerce-route.js";
export {
	ALLOWED_HOSTS,
	COMMERCE_SERVICE_BASE_URL,
	URUMI_PLUGIN_CAPABILITIES,
	URUMI_PLUGIN_ID,
	URUMI_PLUGIN_VERSION,
} from "./manifest.js";
export {
	CommerceClientError,
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
	type AvailabilityToken,
	type ProductPriceViewModel,
	type ProductViewModel,
} from "./storefront/product-view-model.js";
// ── end Phase 2 catalog display ──────────────────────────────────────────────
export {
	deriveDeleteIdempotencyKey,
	deriveSaveIdempotencyKey,
} from "./sync/derive-idempotency-key.js";
export {
	createAfterDeleteHandler,
	createAfterSaveHandler,
	PRODUCTS_COLLECTION,
} from "./sync/hooks.js";
export type {
	ContentDeleteEvent,
	ContentHookEvent,
	Element,
	FieldWidgetConfig,
	HttpAccess,
	PluginContext,
	SandboxedPlugin,
} from "./types.js";
export { default as plugin } from "./plugin.js";
