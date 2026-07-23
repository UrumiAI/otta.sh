import type {
	AddressStore,
	CouponStore,
	CustomerCredentialVerifier,
	CustomerStore,
	EmailSender,
	EntitlementStore,
	IdGen,
	OrderNotesStore,
	OrderStore,
	PaymentEventStore,
	PaymentGateway,
	PaymentMethod,
	ProductCommerceStore,
	ReportingStore,
	SessionStore,
	SettingsStore,
	ShippingRulesStore,
	TaxRulesStore,
} from "@urumi/domain";
import { Hono } from "hono";
import { requireServiceToken } from "./auth.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { reportsRoutes } from "./routes/reports.js";
import { rulesAdminRoutes } from "./routes/rules-admin.js";
import { settingsRoutes } from "./routes/settings.js";
import { type CartRoutesDeps, cartRoutes, expireHoldsRoutes } from "./routes/carts.js";
import { catalogRoutes } from "./routes/catalog.js";
import { entitlementRoutes } from "./routes/entitlements.js";
import { internalEmailRoutes } from "./routes/internal-emails.js";
import { type InventoryDeps, inventoryRoutes } from "./routes/inventory.js";
import { meRoutes } from "./routes/me.js";
import { orderRoutes } from "./routes/orders.js";
import { productCommerceRoutes } from "./routes/product-commerce.js";
import { webhookRoutes } from "./routes/webhooks.js";

export type AppDeps = InventoryDeps &
	CartRoutesDeps & {
		productCommerce: ProductCommerceStore;
		// Phase 4 (§7): order/payment/entitlement stores + the payment gateways.
		orderStore: OrderStore;
		// Admin-UX Increment 0: append-only order notes.
		orderNotesStore: OrderNotesStore;
		entitlementStore: EntitlementStore;
		paymentEventStore: PaymentEventStore;
		// Phase 6 (§6): shipping / tax / coupon rules stores.
		shippingRules: ShippingRulesStore;
		taxRules: TaxRulesStore;
		couponStore: CouponStore;
		// Phase 7 (§6): read-only reporting + operational settings stores.
		reportingStore: ReportingStore;
		settingsStore: SettingsStore;
		idGen: IdGen;
		gateways: Partial<Record<PaymentMethod, PaymentGateway>>;
		/** Checkout hold TTL in ms; defaults to the domain's DEFAULT_CHECKOUT_TTL_MS. */
		checkoutTtlMs?: number;
		// Phase 5 (§7): storefront customer identity, address book, email.
		customerStore: CustomerStore;
		addressStore: AddressStore;
		sessionStore: SessionStore;
		credentialVerifier: CustomerCredentialVerifier;
		emailSender: EmailSender;
		/** Storefront base URL for the emailed magic link (optional). */
		storefrontBaseUrl?: string;
		/**
		 * SERVICE_API_TOKEN write gate (D9 / ADR-0007): when set, every non-GET/HEAD
		 * request must carry `X-Service-Token: <serviceToken>` (a dedicated header —
		 * NOT `Authorization: Bearer`, which is owned by customer session auth).
		 * Unset ⇒ fully open (exactly the pre-gate behavior — local dev and tests).
		 */
		serviceToken?: string;
	};

/**
 * Build the Hono app without listening (§0.6) so tests can mount it and the bin
 * (`index.ts`) can serve it. The concrete stores/clock are injected — the app
 * knows nothing about pg/sqlite.
 */
export function createApp(deps: AppDeps): Hono {
	const app = new Hono();
	// The write gate is registered FIRST so no route — present or future — can
	// be mounted in front of it. Exemptions (exact method+path, each with its
	// OWN caller authentication — never an open hole):
	//  - POST /webhooks/stripe: called directly by Stripe (deliberately no
	//    plugin proxy — the sandbox bridge destroys the raw bytes the HMAC
	//    needs); authenticated by `Stripe-Signature` HMAC verification over the
	//    raw body inside settleOrder, with a freshness window and rotation-aware
	//    v1 checks. Stripe cannot carry our service token. Every other verb on
	//    the path stays gated.
	app.use(
		"*",
		requireServiceToken(deps.serviceToken, [{ method: "POST", path: "/webhooks/stripe" }]),
	);
	app.get("/health", (c) => c.json({ ok: true }));
	app.route("/inventory", inventoryRoutes(deps));
	app.route(
		"/products",
		productCommerceRoutes({ productCommerce: deps.productCommerce, inventory: deps.store }),
	);
	app.route("/catalog", catalogRoutes({ productCommerce: deps.productCommerce }));
	app.route("/carts", cartRoutes(deps));
	// Internal (non-public) sweep trigger — self-interval or plugin-cron hits this.
	app.route("/internal", expireHoldsRoutes(deps));

	// Phase 4 (§7): checkout + order read + internal order-expiry (mounted at "/"
	// with absolute paths: /checkout/orders, /orders/:id, /internal/expire-orders),
	// the public Stripe webhook receiver, and the entitlement grant/check surface.
	const orderDeps = { ...deps, checkoutTtlMs: deps.checkoutTtlMs };
	app.route("/", orderRoutes(orderDeps));
	app.route("/webhooks", webhookRoutes(orderDeps));
	app.route("/entitlements", entitlementRoutes(orderDeps));

	// Phase 5 (§7): storefront customer auth, the authenticated /me surface, the
	// admin transition, and the outbox dispatcher trigger.
	app.route(
		"/auth",
		authRoutes({
			credentialVerifier: deps.credentialVerifier,
			customerStore: deps.customerStore,
			sessionStore: deps.sessionStore,
			orderStore: deps.orderStore,
			emailSender: deps.emailSender,
			clock: deps.clock,
			...(deps.storefrontBaseUrl !== undefined
				? { storefrontBaseUrl: deps.storefrontBaseUrl }
				: {}),
		}),
	);
	app.route(
		"/me",
		meRoutes({
			sessionStore: deps.sessionStore,
			customerStore: deps.customerStore,
			orderStore: deps.orderStore,
			addressStore: deps.addressStore,
		}),
	);
	app.route(
		"/admin",
		adminRoutes({
			orderStore: deps.orderStore,
			orderNotesStore: deps.orderNotesStore,
			// Admin-UX Increment 1: the customer-context read on the order detail.
			customerStore: deps.customerStore,
			addressStore: deps.addressStore,
			sessionStore: deps.sessionStore,
			// Admin-UX Increment 2: the Products console (view-only enumerate + detail).
			productCommerce: deps.productCommerce,
			inventoryStore: deps.store,
			internalToken: deps.internalToken,
		}),
	);
	// Phase 6 admin CRUD (shipping/tax/coupon config) — mounted at /admin too; no
	// path collision with /admin/orders/:id/transition.
	app.route(
		"/admin",
		rulesAdminRoutes({
			shippingRules: deps.shippingRules,
			taxRules: deps.taxRules,
			couponStore: deps.couponStore,
			// Increment 3 closeout: the tax-class DELETE route's `deleteTaxClass`
			// use-case needs the product-reference guard.
			productCommerce: deps.productCommerce,
			...(deps.internalToken !== undefined ? { internalToken: deps.internalToken } : {}),
		}),
	);
	// Phase 7 (§6): read-only reports + operational settings. BOTH are admin
	// surface — /reports/* reads expose merchant financial/operational data and
	// PUT /settings is a privileged write, so both require the internal token
	// (review J5).
	app.route(
		"/reports",
		reportsRoutes({
			reportingStore: deps.reportingStore,
			settingsStore: deps.settingsStore,
			...(deps.internalToken !== undefined ? { internalToken: deps.internalToken } : {}),
		}),
	);
	app.route(
		"/settings",
		settingsRoutes({
			settingsStore: deps.settingsStore,
			...(deps.internalToken !== undefined ? { internalToken: deps.internalToken } : {}),
		}),
	);
	app.route(
		"/internal",
		internalEmailRoutes({
			orderStore: deps.orderStore,
			emailSender: deps.emailSender,
			customerStore: deps.customerStore,
			credentialVerifier: deps.credentialVerifier,
			clock: deps.clock,
			...(deps.internalToken !== undefined ? { internalToken: deps.internalToken } : {}),
		}),
	);

	// Consistent error envelope for anything thrown past the routes (e.g. a
	// domain error on commit/release of a non-`held`/unknown reservation, or a
	// DB fault). No internal message or stack is leaked to the client; the real
	// error is logged server-side.
	app.onError((err, c) => {
		console.error("[service] unhandled error:", err);
		return c.json({ ok: false, error: "internal_error" }, 500);
	});

	return app;
}
