/**
 * The payment gateways a context has configured, resolved ONCE per request and
 * shared by both composition roots: `makeCommerceClient` (checkout) and
 * `makeAdminClients` (console refunds).
 *
 * WHY ONE FUNCTION. Before issue #303 only the storefront root resolved them, and
 * the admin orders client was built with none — so every console refund, manual
 * ones included, answered `409 REFUND_GATEWAY_UNAVAILABLE` while checkout on the
 * same deployment took live Stripe payments. Resolving both maps here means the
 * two roots cannot disagree about which gateways a deployment has.
 *
 * A gateway resolves to `undefined` on an unconfigured deployment and is simply
 * omitted from the map; the domain refuses a method with no gateway loudly
 * (checkout) and the admin client answers `409 REFUND_GATEWAY_UNAVAILABLE`
 * (refunds) — fail-closed either way. Stripe reaches its provider only through
 * `ctx.http` (the sandbox rule): `api.stripe.com` is the constant entry
 * `resolveAllowedHosts` always grants. The map stays keyed by `PaymentMethod`
 * so a future gateway slots in beside it.
 */

import type { PaymentGateway, PaymentMethod } from "@otta-sh/domain";
import type { PluginContext } from "../types.js";
import { stripeGatewayFromCtx, type StripeGatewayOptions } from "./stripe-wiring.js";

export type PaymentGateways = Partial<Record<PaymentMethod, PaymentGateway>>;

export async function resolvePaymentGateways(
	ctx: PluginContext,
	options: StripeGatewayOptions = {},
): Promise<PaymentGateways> {
	const stripe = await stripeGatewayFromCtx(ctx, options);
	return stripe === undefined ? {} : { stripe };
}
