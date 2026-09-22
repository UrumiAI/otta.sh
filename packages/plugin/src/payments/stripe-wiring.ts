/**
 * Stripe payment gateway, in-process (work order 02 follow-up).
 *
 * WHAT WAS MISSING. `make-commerce-client.ts` wired `x402` into
 * `InProcessCommerceClient`'s `gateways` map (INC-C5) but never wired
 * `stripe` — `@otta-sh/payments-stripe` ships a complete `PaymentGateway`
 * adapter (`StripePaymentGateway`) and `webhooks/stripe-settle-route.ts`
 * already constructs one to VERIFY inbound webhooks, but nothing ever
 * constructed one for `createOrder` to CREATE a PaymentIntent with. Every
 * `paymentMethod: "stripe"` checkout (`checkout-routes.ts`'s `PAYMENT_METHOD`
 * constant — the only method the storefront checkout ever requests) resolved
 * `deps.gateways.stripe` to `undefined` and threw before `createOrderFromCart`
 * could return a typed reason, surfacing as an opaque `RENDER_FAILED`. This
 * module is the missing half.
 *
 * FAIL-CLOSED ON BOTH SECRETS, not just `secretKey`. `StripePaymentGateway`'s
 * `webhookSecret` is a MANDATORY constructor field (it throws on an empty
 * one), so a gateway cannot exist without it regardless — but this module
 * requires `secretKey` too, deliberately, even though `createIntent` would
 * happily fall back to the OFFLINE deterministic handle without one. Wiring a
 * gateway that can take a buyer's live PaymentIntent (secretKey present) but
 * whose confirmation can never be verified (webhookSecret absent) — or the
 * mirror, a webhook verifier with no way to have created what it is
 * confirming — is a half-armed state worse than off: an order stuck holding
 * stock against a payment nothing can ever settle. Both configured, or no
 * gateway at all, exactly like `x402GatewayFromCtx` (`payments/x402-wiring.ts`)
 * refuses to arm on a partial config.
 *
 * `api.stripe.com` needs no `allowedHosts` wiring here — it is the one
 * constant entry `resolveAllowedHosts` always grants (`manifest.ts`,
 * `STRIPE_API_HOST`), unlike x402's deployment-supplied facilitator URL.
 */

import { StripePaymentGateway } from "@otta-sh/payments-stripe";
import { stripeSecretKeyFromKv, stripeWebhookSecretFromKv } from "../payment-secrets.js";
import type { PluginContext } from "../types.js";

/**
 * `ctx.http.fetch` takes a `string` url; the global `fetch` type the gateway's
 * transport is declared against accepts `RequestInfo | URL` (Stripe's own
 * transport, `createStripeHttpTransport`, only ever calls it with a plain
 * string it built itself — see that function's body). `String(...)` on a
 * `string` or a `URL` yields the same url either way; a `Request` object is
 * never passed in practice, so this adapter exists purely to satisfy the
 * wider declared type, not to handle a shape that occurs.
 */
function toGlobalFetch(fetchImpl: PluginContext["http"]["fetch"]): typeof fetch {
	return (input, init) => fetchImpl(String(input), init);
}

/**
 * Resolve the Stripe gateway for a context, or report `undefined` for
 * "Stripe is not configured on this deployment" — the same fail-closed shape
 * `x402GatewayFromCtx` uses. `createOrderFromCart` (`@otta-sh/domain`) refuses
 * a `paymentMethod` with no gateway before touching the cart, so an
 * unconfigured deployment gets a typed, loud refusal rather than a thrown
 * error.
 */
export async function stripeGatewayFromCtx(
	ctx: PluginContext,
): Promise<StripePaymentGateway | undefined> {
	const [secretKey, webhookSecret] = await Promise.all([
		stripeSecretKeyFromKv(ctx),
		stripeWebhookSecretFromKv(ctx),
	]);
	if (secretKey === undefined || webhookSecret === undefined) return undefined;
	return new StripePaymentGateway({
		secretKey,
		webhookSecret,
		fetch: toGlobalFetch(ctx.http.fetch),
	});
}
