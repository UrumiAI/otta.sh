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
	type UpsertProductCommerceInput,
} from "./product-commerce/commerce-client.js";
export { HttpCommerceClient } from "./product-commerce/http-commerce-client.js";
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
