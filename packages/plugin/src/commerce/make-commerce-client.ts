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

import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import { x402GatewayFromCtx } from "../payments/x402-wiring.js";
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
	// The payment gateways the service used to wire from env are wired HERE,
	// because resolving them is asynchronous (kv) and the client's constructor is
	// not. INC-C5 wires x402, whose facilitator call goes over `ctx.http` to the
	// host `allowedHosts` already grants; an unconfigured deployment gets
	// `undefined` and therefore an EMPTY map, which the domain refuses loudly
	// rather than minting an unpayable order.
	const x402 = await x402GatewayFromCtx(ctx, {
		facilitatorUrl: IN_PROCESS_EGRESS_URLS.facilitatorUrl,
	});
	return new InProcessCommerceClient(ctx, {
		gateways: x402 === undefined ? {} : { x402 },
	});
}
