/**
 * The ADMIN composition root (work order 02, INC-B10b-i) — the console's twin of
 * `make-commerce-client.ts`, built to the same shape on purpose so the two
 * cut-overs read alike.
 *
 * Every admin console route obtains its clients from here rather than
 * constructing them, which is what made the tier a ONE-LINE change instead of a
 * diff spread across six route files with six chances to miss one.
 *
 * WHAT IS ROUTED THROUGH HERE: products, orders, rules and — since INC-B10c-ii —
 * reporting + settings. That is the WHOLE admin surface: no console route
 * constructs a commerce client of its own.
 *
 * NO ADMIN AUTH HERE, deliberately (ADR-0014 D3). The console routes are already
 * gated by EmDash's own admin auth and CSRF; the `X-Internal-Token` /
 * `X-Service-Token` pair authenticated a caller TO THE SERVICE, and there is no
 * service to authenticate to any more. INC-D3a therefore deleted both tokens
 * outright rather than leaving a check that could not fail.
 */

import { getTaxCalculator } from "../commerce/tax-calculator-slot.js";
import { resolvePaymentGateways } from "../payments/resolve-payment-gateways.js";
import type { PluginContext } from "../types.js";
import type { AdminOrdersSurface } from "./admin-orders-surface.js";
import type { AdminProductsSurface } from "./admin-products-surface.js";
import type { AdminRulesSurface } from "./admin-rules-surface.js";
import { InProcessAdminOrdersClient } from "./in-process-admin-orders-client.js";
import { InProcessAdminProductsClient } from "./in-process-admin-products-client.js";
import { InProcessAdminRulesClient } from "./in-process-admin-rules-client.js";
import { InProcessReportingSettingsClient } from "./in-process-reporting-settings-client.js";
import type { ReportingSettingsSurface } from "./reporting-settings-surface.js";

/**
 * The admin surfaces a console route may ask for.
 *
 * EVERY MEMBER IS NON-OPTIONAL. There is no surface a route can ask for and not
 * get, and the day a new one is added it belongs here or nowhere — a stub would
 * answer "no revenue" where the honest answer is "not wired yet".
 */
export interface AdminClients {
	products: AdminProductsSurface;
	orders: AdminOrdersSurface;
	rules: AdminRulesSurface;
	/** Reports (revenue, orders-by-status, top products, low stock) AND the
	 *  operational settings tier — one surface because one client serves both. */
	reporting: ReportingSettingsSurface;
}

/**
 * One set per invocation, matching the request-scoped lifecycle the console
 * routes already had: a client is cheap and its adapters are request-scoped
 * over `ctx`.
 *
 * `Promise`-shaped because the orders client needs the payment gateways, and
 * resolving them reads kv: they are resolved by the SAME function
 * `makeCommerceClient` uses (`resolvePaymentGateways`), so a console refund
 * reaches the provider checkout charged — over `ctx.http` — and a deployment with
 * no gateway for an order's method still answers `409 REFUND_GATEWAY_UNAVAILABLE`
 * (issue #303). A non-refundable gateway (x402) lets the console RECORD a manual,
 * off-platform refund.
 *
 * The clients construct every commerce adapter over `ctx.storage`, so a context
 * with no document store fails HERE, at construction, naming what is missing —
 * never several frames later inside a console render. That throw is still
 * SYNCHRONOUS, on the call itself: the three storage-only clients are built
 * before any kv read begins.
 */
export function makeAdminClients(ctx: PluginContext): Promise<AdminClients> {
	const products = new InProcessAdminProductsClient(ctx);
	// ADR-0031: a registered outside calculator reads as "already charges tax".
	const rules = new InProcessAdminRulesClient(ctx, {
		hasOutsideTaxCalculator: getTaxCalculator() !== undefined,
	});
	const reporting = new InProcessReportingSettingsClient(ctx);
	return resolvePaymentGateways(ctx).then((gateways) => ({
		products,
		orders: new InProcessAdminOrdersClient(ctx, { gateways }),
		rules,
		reporting,
	}));
}
