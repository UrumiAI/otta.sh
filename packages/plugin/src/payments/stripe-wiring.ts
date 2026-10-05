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
 * ONE DEV-ONLY EXCEPTION (issue #378), and it is not a relaxation of the rule
 * above. A local or CI e2e stack has no Stripe account, so with the rule as
 * written it can never create an order, and the admin Orders specs had nothing
 * to look at. {@link devStripeOfflineEnabled} arms the adapter's OWN offline
 * path — `createIntent` without a `secretKey` mints the deterministic,
 * unpayable `pi_<orderId>` handle and makes no network call — when, and only
 * when, BOTH of these hold:
 *
 *  - the site baked `__OTTA_DEV_STRIPE_OFFLINE__` as the literal `true`. The
 *    staging site bakes it only under `astro dev` with
 *    `OTTA_E2E_STRIPE_OFFLINE=1`, and REFUSES to build with that variable set
 *    (`sites/staging/src/lib/e2e-stripe-offline.ts`);
 *  - the bundle is a Vite DEV build (`import.meta.env.DEV`). Vite folds that to
 *    `false` in a production build, and a non-Vite bundle (the published
 *    `dist`, the workerd sandbox) has no `import.meta.env` at all — both read
 *    as off. So no deployed build can arm it, whatever its defines say.
 *
 * The webhook secret is still required: the order is marked paid only by a
 * signed `payment_intent.succeeded`, verified by the same HMAC as production.
 * A configured secret key always wins — the live gateway, never this one.
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

/** Per-caller tuning of the live gateway. */
export interface StripeGatewayOptions {
	/**
	 * Bound on each live Stripe call. Unset ⇒ the transport's 30 s default, right
	 * for a checkout or an admin refund. A caller running inside someone else's
	 * deadline passes less: the settle webhook (Stripe stops waiting on a delivery
	 * after ~10 s) and the cron sweep (a provider stall must not hold the tick) —
	 * the sweep as a FUNCTION, asked at each call, of what its leg has left.
	 */
	requestTimeoutMs?: number | (() => number);
	/** A FIXED bound for the refund create alone (see `StripePaymentGateway`). */
	refundCreateTimeoutMs?: number;
	/** Asked between the refund pre-flight and the create; `false` skips the create
	 *  and answers RETRYABLE (nothing issued). */
	beforeRefundCreate?: () => boolean;
}

/** Baked by the SITE's Vite config, never by this package — see
 *  {@link devStripeOfflineEnabled}. Undeclared in any other build. */
declare const __OTTA_DEV_STRIPE_OFFLINE__: unknown;

/**
 * Is the dev-only offline Stripe gateway armed in THIS bundle? Both guards,
 * independently, as the module doc explains: the site's define is the literal
 * `true`, AND this is a Vite dev build. Exported so a test pins each guard.
 *
 * `import.meta.env` is SPELLED LITERALLY, with no cast around `import.meta`:
 * Vite and vitest find it by its text, and `(import.meta as …).env` is not
 * rewritten — measured under vitest, where the cast form read the unstubbed
 * `true` after `vi.stubEnv("DEV", false)`. The `?.` is for every bundle outside
 * Vite, where `import.meta.env` does not exist and must read as "not dev"
 * rather than throw.
 */
export function devStripeOfflineEnabled(): boolean {
	const baked =
		typeof __OTTA_DEV_STRIPE_OFFLINE__ === "boolean" && __OTTA_DEV_STRIPE_OFFLINE__ === true;
	// `@ts-ignore`, not `@ts-expect-error`: this package's own program has no
	// `vite/client` types (so `env` is unknown to it), but a Vite site that
	// type-checks this source DOES have them, and an expect-error would then fail
	// that site's check as unused.
	// @ts-ignore -- `import.meta.env` is Vite's; see the comment above.
	const devBuild = import.meta.env?.DEV === true;
	return baked && devBuild;
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
	options: StripeGatewayOptions = {},
): Promise<StripePaymentGateway | undefined> {
	const [secretKey, webhookSecret] = await Promise.all([
		stripeSecretKeyFromKv(ctx),
		stripeWebhookSecretFromKv(ctx),
	]);
	if (webhookSecret === undefined) return undefined;
	if (secretKey === undefined) {
		// The dev-only offline arm (module doc). Everywhere else: no gateway.
		return devStripeOfflineEnabled() ? new StripePaymentGateway({ webhookSecret }) : undefined;
	}
	return new StripePaymentGateway({
		secretKey,
		webhookSecret,
		fetch: toGlobalFetch(ctx.http.fetch),
		...(options.requestTimeoutMs !== undefined
			? { requestTimeoutMs: options.requestTimeoutMs }
			: {}),
		...(options.refundCreateTimeoutMs !== undefined
			? { refundCreateTimeoutMs: options.refundCreateTimeoutMs }
			: {}),
		...(options.beforeRefundCreate !== undefined
			? { beforeRefundCreate: options.beforeRefundCreate }
			: {}),
	});
}
