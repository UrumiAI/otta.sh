import { createPanelStateRouteHandler, PANEL_STATE_ROUTE } from "./admin/panel-state-route.js";
import {
	createProductCommerceRouteHandler,
	PRODUCT_COMMERCE_ROUTE,
} from "./admin/product-commerce-route.js";
import { createAfterDeleteHandler, createAfterSaveHandler } from "./sync/hooks.js";
import type { SandboxedPlugin } from "./types.js";

/**
 * The sandboxed plugin entry (plan §5/§6). Mirrors the real EmDash
 * sandboxed-plugin shape (`export default { hooks?, routes? } satisfies
 * SandboxedPlugin`, verified against `~/em-dash`'s
 * `packages/plugins/{sandboxed-test,webhook-notifier}/src/plugin.ts`) —
 * this is the module `sandbox-entry.ts` loads inside workerd.
 *
 * Declares ONLY the two hooks and two routes Phase 1 needs. No
 * `admin.fieldWidgets`/manifest declarations live here — those are a
 * separate wire-manifest concern (`emdash-plugin.jsonc` in a real deploy);
 * `admin/product-data-widget.ts` is the shared source of truth both a
 * manifest generator and `panel-state-route.ts` read from.
 */
const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterSave": { handler: createAfterSaveHandler() },
		"content:afterDelete": { handler: createAfterDeleteHandler() },
	},
	routes: {
		// Cast to the route record's erased `unknown`-input shape — each
		// handler validates its own input at runtime (mirrors em-dash's own
		// plugins, e.g. `packages/plugins/forms/src/index.ts`, which cast
		// route handlers `as never` for the same contravariance reason).
		[PRODUCT_COMMERCE_ROUTE]: {
			handler: createProductCommerceRouteHandler() as never,
			public: false,
		},
		[PANEL_STATE_ROUTE]: { handler: createPanelStateRouteHandler() as never, public: false },
	},
};

export default plugin;
