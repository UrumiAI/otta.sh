import type {
	EntitlementStore,
	IdGen,
	OrderStore,
	PaymentEventStore,
	PaymentGateway,
	PaymentMethod,
	ProductCommerceStore,
} from "@urumi/domain";
import { Hono } from "hono";
import { type CartRoutesDeps, cartRoutes, expireHoldsRoutes } from "./routes/carts.js";
import { catalogRoutes } from "./routes/catalog.js";
import { entitlementRoutes } from "./routes/entitlements.js";
import { type InventoryDeps, inventoryRoutes } from "./routes/inventory.js";
import { orderRoutes } from "./routes/orders.js";
import { productCommerceRoutes } from "./routes/product-commerce.js";
import { webhookRoutes } from "./routes/webhooks.js";

export type AppDeps = InventoryDeps &
	CartRoutesDeps & {
		productCommerce: ProductCommerceStore;
		// Phase 4 (§7): order/payment/entitlement stores + the payment gateways.
		orderStore: OrderStore;
		entitlementStore: EntitlementStore;
		paymentEventStore: PaymentEventStore;
		idGen: IdGen;
		gateways: Partial<Record<PaymentMethod, PaymentGateway>>;
		/** Checkout hold TTL in ms; defaults to the domain's DEFAULT_CHECKOUT_TTL_MS. */
		checkoutTtlMs?: number;
	};

/**
 * Build the Hono app without listening (§0.6) so tests can mount it and the bin
 * (`index.ts`) can serve it. The concrete stores/clock are injected — the app
 * knows nothing about pg/sqlite.
 */
export function createApp(deps: AppDeps): Hono {
	const app = new Hono();
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
