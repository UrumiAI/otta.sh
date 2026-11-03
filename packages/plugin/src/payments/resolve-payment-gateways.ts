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
 * `resolveAllowedHosts` always grants. The map stays keyed by `PaymentMethod`.
 *
 * Cash on delivery (ADR-0044) is armed independently of Stripe, so a store with
 * only COD checks out with no Stripe keys. `cashOnDelivery` says when:
 *  - `"if-enabled"` (checkout, the default): only while the merchant has it on;
 *  - `"always"` (the admin root): an order placed with COD stays manageable (a
 *    manual refund recorded) after the toggle is turned off. The offline gateway
 *    moves no money, so arming it there grants nothing;
 *  - `"never"` (the sweep legs and the abandon-cancel): they withdraw intents and
 *    refund late payments, and a COD order has neither — so they pay no kv read.
 */

import type { PaymentGateway, PaymentMethod } from "@urumi.ai/otta-domain";
import type { PluginContext } from "../types.js";
import { codGatewayFromCtx } from "./cash-on-delivery.js";
import { stripeGatewayFromCtx, type StripeGatewayOptions } from "./stripe-wiring.js";

export type PaymentGateways = Partial<Record<PaymentMethod, PaymentGateway>>;

export interface ResolvePaymentGatewaysOptions extends StripeGatewayOptions {
	/** When cash on delivery is armed (see the module doc). Default `"if-enabled"`. */
	cashOnDelivery?: "if-enabled" | "always" | "never";
}

export async function resolvePaymentGateways(
	ctx: PluginContext,
	options: ResolvePaymentGatewaysOptions = {},
): Promise<PaymentGateways> {
	const { cashOnDelivery = "if-enabled", ...stripeOptions } = options;
	const [stripe, cod] = await Promise.all([
		stripeGatewayFromCtx(ctx, stripeOptions),
		cashOnDelivery === "never" ? undefined : codGatewayFromCtx(ctx, cashOnDelivery === "always"),
	]);
	return {
		...(stripe === undefined ? {} : { stripe }),
		...(cod === undefined ? {} : { cod }),
	};
}
