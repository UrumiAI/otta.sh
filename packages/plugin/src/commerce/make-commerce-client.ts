/**
 * The commerce composition root (work order 02, D6).
 *
 * Every storefront route, sync hook and entitlement check obtains its
 * `CommerceClient` from here, and from nowhere else. Before INC-A6 six modules
 * hand-rolled the same four-line HTTP-client construction — four of them behind
 * a near-identical private helper, two inline — across NINETEEN call sites, so
 * the cut-over to in-process commerce would have been a six-file diff with six
 * chances to miss one. It was a one-line diff in this file instead, and
 * INC-D3a has now deleted the other arm outright.
 *
 * NOT ROUTED THROUGH HERE, deliberately: the four admin surfaces
 * (`admin-orders-surface`, `admin-products-surface`, `admin-rules-surface`,
 * `reporting-settings-surface`). They are their own ports rather than
 * implementations of this one, and `makeAdminClients` constructs them; INC-D3b
 * deleted the HTTP arm of each, leaving one in-process implementation apiece.
 */

import { makeLoginEmailSender } from "../email/ctx-http-email-sender.js";
import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import { resolvePaymentGateways } from "../payments/resolve-payment-gateways.js";
import type { CommerceClient } from "../product-commerce/commerce-client.js";
import type { PluginContext } from "../types.js";
import { InProcessCommerceClient } from "./in-process-commerce-client.js";

/**
 * One client per invocation, matching the request-scoped lifecycle the
 * storefront routes already had: a client is cheap, and its adapters are
 * request-scoped over `ctx`.
 *
 * Async because resolving the payment gateways reads kv; the signature stayed
 * `Promise`-shaped across the mode collapse so the nineteen call sites did not
 * have to change again.
 *
 * The client constructs every commerce adapter over `ctx.storage`, so a context
 * with no document store fails HERE, at construction, naming what is missing —
 * never several frames later inside a storefront route.
 */
export async function makeCommerceClient(ctx: PluginContext): Promise<CommerceClient> {
	// The payment gateways the service used to wire from env are resolved HERE,
	// because resolving them is asynchronous (kv) and the client's constructor is
	// not: x402 (INC-C5) and Stripe, the method storefront checkout actually uses
	// (`PAYMENT_METHOD` in `checkout-routes.ts`). An unconfigured one is omitted
	// from the map, which the domain refuses loudly rather than minting an
	// unpayable order. `resolvePaymentGateways` is shared with `makeAdminClients`,
	// so console refunds reach the same gateways checkout charged through.
	return new InProcessCommerceClient(ctx, {
		gateways: await resolvePaymentGateways(ctx),
		// Lazy: only the login request sends mail, and building the sender reads kv.
		// `undefined` on a bundle with no email API URL — the unconfigured arm. The
		// LOGIN sender, with its short ceiling: the send is awaited inline.
		resolveEmailSender: () =>
			makeLoginEmailSender(ctx, { apiUrl: IN_PROCESS_EGRESS_URLS.emailApiUrl }),
	});
}
