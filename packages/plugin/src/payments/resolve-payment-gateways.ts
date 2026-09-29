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
 * Each gateway resolves independently to `undefined` on an unconfigured
 * deployment and is simply omitted from the map; the domain refuses a method
 * with no gateway loudly (checkout) and the admin client answers `409
 * REFUND_GATEWAY_UNAVAILABLE` (refunds) — fail-closed either way. Both gateways
 * reach their provider only through `ctx.http` (the sandbox rule): x402's
 * facilitator host is granted by `allowedHosts`, and `api.stripe.com` is the
 * constant entry `resolveAllowedHosts` always grants.
 */

import type { PaymentGateway, PaymentMethod } from "@otta-sh/domain";
import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import type { PluginContext } from "../types.js";
import { stripeGatewayFromCtx } from "./stripe-wiring.js";
import { x402GatewayFromCtx } from "./x402-wiring.js";

export type PaymentGateways = Partial<Record<PaymentMethod, PaymentGateway>>;

export async function resolvePaymentGateways(ctx: PluginContext): Promise<PaymentGateways> {
	const [x402, stripe] = await Promise.all([
		x402GatewayFromCtx(ctx, { facilitatorUrl: IN_PROCESS_EGRESS_URLS.facilitatorUrl }),
		stripeGatewayFromCtx(ctx),
	]);
	return {
		...(x402 === undefined ? {} : { x402 }),
		...(stripe === undefined ? {} : { stripe }),
	};
}
