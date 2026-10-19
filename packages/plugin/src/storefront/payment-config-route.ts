/**
 * Issue #498 — `storefront/payment-config`: the store's Stripe PUBLISHABLE key,
 * read per request, for the checkout pages (review, place, pay).
 *
 * PUBLIC, like every storefront route: the key it answers is public by nature
 * (Stripe.js is initialised with it in the buyer's browser). It answers nothing
 * else — no secret, no account fact. `null` means card payment is not set up:
 * the pages then say so and create no order (ADR-0012, as amended).
 */
import { readStripePublishableKey } from "../payments/stripe-publishable-key.js";
import type { RouteHandler } from "../types.js";
import { renderGuard, type RenderGuardFailure } from "./pdp-route.js";

export const STOREFRONT_PAYMENT_CONFIG_ROUTE = "storefront/payment-config";

export type PaymentConfigRouteResult =
	| { ok: true; stripePublishableKey: string | null }
	| RenderGuardFailure;

export function createPaymentConfigRouteHandler(): RouteHandler<unknown> {
	return (_routeCtx, ctx): Promise<PaymentConfigRouteResult> =>
		renderGuard(STOREFRONT_PAYMENT_CONFIG_ROUTE, async () => ({
			ok: true as const,
			stripePublishableKey: (await readStripePublishableKey(ctx)) ?? null,
		}));
}
