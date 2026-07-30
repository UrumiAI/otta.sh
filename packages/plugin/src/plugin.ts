import { ADMIN_ROUTE, createAdminRouteHandler } from "./admin/admin-route.js";
// ── Phase 3 group E: cart routes (plan §7 step E1, shape per ADR-0003) ────
import {
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
} from "./storefront/cart-routes.js";
// ── end Phase 3 group E: cart routes ───────────────────────────────────────
// ── Phase 4: checkout routes (storefront-checkout plan §1.2, ADR-0012) ─────
import {
	createCheckoutPlaceRouteHandler,
	createCheckoutSummaryRouteHandler,
	createOrderRouteHandler,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
	STOREFRONT_CHECKOUT_SUMMARY_ROUTE,
	STOREFRONT_ORDER_ROUTE,
} from "./storefront/checkout-routes.js";
// ── end Phase 4 checkout routes ────────────────────────────────────────────
import {
	createEntitlementDownloadHandler,
	ENTITLEMENT_DOWNLOAD_ROUTE,
} from "./entitlements/download-route.js";
// ── Phase 5: storefront customer account routes (plan §9) ─────────────────
import {
	ACCOUNT_ADDRESSES_ROUTE,
	ACCOUNT_LOGIN_REQUEST_ROUTE,
	ACCOUNT_LOGIN_VERIFY_ROUTE,
	ACCOUNT_ORDER_ROUTE,
	ACCOUNT_ORDERS_ROUTE,
	createAccountAddressesHandler,
	createAccountLoginRequestHandler,
	createAccountLoginVerifyHandler,
	createAccountOrderHandler,
	createAccountOrdersHandler,
} from "./storefront/account-routes.js";
// ── end Phase 5 account routes ─────────────────────────────────────────────
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
 * follow-up, activating on publish and deactivating on unpublish). Since "one
 * home per field" (PR 1b) those hooks are LIFECYCLE + TITLE only: they keep a
 * `product_commerce` row in existence for every CMS product, project the
 * content's `data.title` into it, and drive activate/deactivate/soft-delete.
 * Pricing, stock and every other commercial field are owned by
 * `product_commerce` and edited from the admin's Pricing & inventory page.
 * Phase 2 (ADR-0003): the two PUBLIC storefront routes — PDP and PLP are
 * plugin-owned routes (`page:fragments` is trusted-only and unavailable to
 * this sandboxed plugin); `public: true` is the em-dash route flag that
 * skips auth/CSRF so the theme's public pages can invoke them.
 *
 * This plugin declares NO field widget. It used to export a "Product data"
 * Block Kit widget bound to a `commerce` json field on the products
 * collection; that made the CMS content document a second writer of the
 * commercial columns and every publish reverted the console's edits, so it was
 * deleted in PR 1b along with its seed field and descriptor entry.
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
		[STOREFRONT_PRODUCT_ROUTE]: { handler: createPdpRouteHandler() as never, public: true },
		[STOREFRONT_LIST_ROUTE]: { handler: createPlpRouteHandler() as never, public: true },
		// ── Phase 3 group E: cart (public — proxies over ctx.http only) ────
		[STOREFRONT_CART_CREATE_ROUTE]: {
			handler: createCartCreateRouteHandler() as never,
			public: true,
		},
		[STOREFRONT_CART_READ_ROUTE]: { handler: createCartReadRouteHandler() as never, public: true },
		[STOREFRONT_CART_LINE_ADD_ROUTE]: {
			handler: createCartLineAddRouteHandler() as never,
			public: true,
		},
		[STOREFRONT_CART_LINE_UPDATE_ROUTE]: {
			handler: createCartLineUpdateRouteHandler() as never,
			public: true,
		},
		[STOREFRONT_CART_LINE_REMOVE_ROUTE]: {
			handler: createCartLineRemoveRouteHandler() as never,
			public: true,
		},
		// ── end Phase 3 group E: cart ───────────────────────────────────────
		// ── Phase 4: checkout (public — proxies over ctx.http only) ─────────
		// The summary composes cart read + ONE commerce batch + quote; place is
		// the single POST /checkout/orders; order is the unauthenticated
		// capability read the confirmation page polls. No new capability and NO
		// allowedHosts change: Stripe's JS runs in the BUYER'S BROWSER, never
		// through ctx.http (ADR-0012 decision 3, pinned by sandbox-clean-guard).
		[STOREFRONT_CHECKOUT_SUMMARY_ROUTE]: {
			handler: createCheckoutSummaryRouteHandler() as never,
			public: true,
		},
		[STOREFRONT_CHECKOUT_PLACE_ROUTE]: {
			handler: createCheckoutPlaceRouteHandler() as never,
			public: true,
		},
		[STOREFRONT_ORDER_ROUTE]: { handler: createOrderRouteHandler() as never, public: true },
		// ── end Phase 4 checkout ────────────────────────────────────────────
		// Phase 4 (§6): PUBLIC download route — authorizes a digital delivery via
		// the service's entitlement check over ctx.http. There is deliberately NO
		// Stripe webhook proxy route (review G1): EmDash's handleSandboxedRoute
		// JSON-parses the request body before any route runs (the raw bytes a
		// Stripe HMAC needs are destroyed) and wraps the return `{success, data}`
		// at HTTP 200 (Stripe's retry logic keys on status), so a byte-exact proxy
		// is structurally impossible on the real host contract. Stripe posts
		// directly to the SERVICE's /webhooks/stripe — the plan's preferred
		// direct-to-service design (§9 Risk 1).
		[ENTITLEMENT_DOWNLOAD_ROUTE]: {
			handler: createEntitlementDownloadHandler() as never,
			public: true,
		},
		// Phase 5 (§9): PUBLIC storefront account routes — thin HTTP-only proxies
		// over ctx.http to the service's /auth + /me surface. No new capability
		// beyond network:request/allowedHosts; the plugin holds no session state
		// (the bearer token is threaded in as route input from the theme's
		// first-party cookie layer — see account-routes.ts's platform note).
		[ACCOUNT_LOGIN_REQUEST_ROUTE]: {
			handler: createAccountLoginRequestHandler() as never,
			public: true,
		},
		[ACCOUNT_LOGIN_VERIFY_ROUTE]: {
			handler: createAccountLoginVerifyHandler() as never,
			public: true,
		},
		[ACCOUNT_ORDERS_ROUTE]: { handler: createAccountOrdersHandler() as never, public: true },
		[ACCOUNT_ORDER_ROUTE]: { handler: createAccountOrderHandler() as never, public: true },
		[ACCOUNT_ADDRESSES_ROUTE]: { handler: createAccountAddressesHandler() as never, public: true },
		// Phase 7 (§6): the SINGLE `admin` dispatch route em-dash's admin shell
		// invokes (`POST /plugins/{id}/admin` with a BlockInteraction body). It
		// fans out on `type` + `page`/`action_id` to the Reports page and the
		// Settings form (see admin/admin-route.ts) — em-dash resolves admin pages
		// by the literal `"admin"` key, so per-page keys never dispatch. Non-public
		// (admin surface). Reports reads /reports/* over ctx.http; Settings uses
		// BOTH ctx.kv (display prefs + write-only admin token) and ctx.http
		// (operational settings) — no new capability (kv is ungated; egress stays
		// network:request + allowedHosts).
		[ADMIN_ROUTE]: { handler: createAdminRouteHandler() as never, public: false },
	},
};

export default plugin;
