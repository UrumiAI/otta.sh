import { createPanelStateRouteHandler, PANEL_STATE_ROUTE } from "./admin/panel-state-route.js";
import {
	createProductCommerceRouteHandler,
	PRODUCT_COMMERCE_ROUTE,
} from "./admin/product-commerce-route.js";
import { createPdpRouteHandler, STOREFRONT_PRODUCT_ROUTE } from "./storefront/pdp-route.js";
import { createPlpRouteHandler, STOREFRONT_LIST_ROUTE } from "./storefront/plp-route.js";
import {
	createAfterDeleteHandler,
	createAfterPublishHandler,
	createAfterSaveHandler,
	createAfterUnpublishHandler,
} from "./sync/hooks.js";
import type { SandboxedPlugin } from "./types.js";

/**
 * The sandboxed plugin entry (plan §5/§6). Mirrors the real EmDash
 * sandboxed-plugin shape (`export default { hooks?, routes? } satisfies
 * SandboxedPlugin`, verified against `~/em-dash`'s
 * `packages/plugins/{sandboxed-test,webhook-notifier}/src/plugin.ts`) —
 * this is the module `sandbox-entry.ts` loads inside workerd.
 *
 * Phase 1: the four content-sync hooks (`afterSave`/`afterDelete`/
 * `afterPublish`/`afterUnpublish` — the last two are the publish-gate
 * follow-up, activating on publish and deactivating on unpublish) and two
 * non-public admin routes.
 * Phase 2 (ADR-0003): the two PUBLIC storefront routes — PDP and PLP are
 * plugin-owned routes (`page:fragments` is trusted-only and unavailable to
 * this sandboxed plugin); `public: true` is the em-dash route flag that
 * skips auth/CSRF so the theme's public pages can invoke them. No
 * `admin.fieldWidgets`/manifest declarations live here — those are a
 * separate wire-manifest concern (`emdash-plugin.jsonc` in a real deploy);
 * `admin/product-data-widget.ts` is the shared source of truth both a
 * manifest generator and `panel-state-route.ts` read from.
 */
const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterSave": { handler: createAfterSaveHandler() },
		"content:afterDelete": { handler: createAfterDeleteHandler() },
		"content:afterPublish": { handler: createAfterPublishHandler() },
		"content:afterUnpublish": { handler: createAfterUnpublishHandler() },
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
		[STOREFRONT_PRODUCT_ROUTE]: { handler: createPdpRouteHandler() as never, public: true },
		[STOREFRONT_LIST_ROUTE]: { handler: createPlpRouteHandler() as never, public: true },
	},
};

export default plugin;
