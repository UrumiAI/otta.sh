/**
 * Issue #498 — `storefront/payment-config`: the store's Stripe PUBLISHABLE key,
 * read per request, for the checkout pages (review, place, pay).
 *
 * PUBLIC, like every storefront route: the key it answers is public by nature
 * (Stripe.js is initialised with it in the buyer's browser). Beside it, one
 * boolean: `cardPaymentReady` (#499), true only when the secret key and the
 * webhook signing secret are usable too. No secret, and not WHICH value is
 * missing — that is the operator's to read, in Settings and the server log.
 *
 * The checkout pages offer card payment only when `cardPaymentReady`; otherwise
 * they say card payment is not set up and create no order (ADR-0012, as
 * amended). `stripePublishableKey` alone keeps its meaning ("is a key stored"),
 * which the e2e seed relies on before it saves a placeholder.
 */
import { readCardPaymentReadiness } from "../payments/card-payment-readiness.js";
import type { RouteHandler } from "../types.js";
import { renderGuard, type RenderGuardFailure } from "./pdp-route.js";

export const STOREFRONT_PAYMENT_CONFIG_ROUTE = "storefront/payment-config";

export type PaymentConfigRouteResult =
	| { ok: true; stripePublishableKey: string | null; cardPaymentReady: boolean }
	| RenderGuardFailure;

export function createPaymentConfigRouteHandler(): RouteHandler<unknown> {
	return (_routeCtx, ctx): Promise<PaymentConfigRouteResult> =>
		renderGuard(STOREFRONT_PAYMENT_CONFIG_ROUTE, async () => {
			const { readiness, publishableKey } = await readCardPaymentReadiness(ctx);
			return {
				ok: true as const,
				stripePublishableKey: publishableKey ?? null,
				cardPaymentReady: readiness.ready,
			};
		});
}
