/**
 * The commerce composition root (work order 02, D6).
 *
 * Every storefront route, sync hook and entitlement check obtains its
 * `CommerceClient` from here, and from nowhere else. Before INC-A6 six modules
 * hand-rolled the same four-line `new HttpCommerceClient({ fetch:
 * ctx.http.fetch, baseUrl: COMMERCE_SERVICE_BASE_URL, …serviceToken })` — four
 * of them behind a near-identical private helper, two inline — across NINETEEN
 * call sites, so the cut-over to in-process commerce would have been a six-file
 * diff with six chances to miss one. It is now a one-line diff in this file.
 *
 * NOT ROUTED THROUGH HERE, deliberately: the four admin HTTP clients
 * (`admin-orders-client`, `admin-products-client`, `admin-rules-client`,
 * `reporting-client`). They are function-export modules over a bare
 * `{ fetch, baseUrl }` transport rather than implementations of this port, so
 * folding them in is its own change — INC-B10b/c own them, and INC-D3b deletes
 * them.
 *
 * ⚠ THE MODE BRANCH BELOW IS TRANSITIONAL AND IS DELETED AT INC-D3b, together
 * with `__OTTA_COMMERCE_MODE__`, `resolveCommerceMode`,
 * `COMMERCE_SERVICE_BASE_URL`, the derivation of `ALLOWED_HOSTS` from it,
 * `HttpCommerceClient` and the four admin HTTP clients (`admin-orders-client`,
 * `admin-products-client`, `admin-rules-client`, `reporting-client`). The flag
 * buys exactly one thing: the ability to run the extracted
 * `commerceClientContract` against BOTH implementations and prove them
 * behaviourally identical before the HTTP one is removed. After that this
 * function unconditionally returns the in-process client. **It is
 * not permanent architecture and nothing may be designed around it.**
 *
 * ZERO BEHAVIOURAL CHANGE IN THIS INCREMENT. In `"http"` mode the client is
 * constructed exactly as those nineteen sites constructed it, including the
 * ADR-0007 write-gate token read from write-only kv and the "undefined ⇒ attach
 * no header" rule that keeps the wire byte-identical to the pre-gate one.
 */

import { COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import type { CommerceClient } from "../product-commerce/commerce-client.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import type { PluginContext } from "../types.js";
import { type CommerceMode, resolveCommerceMode } from "./commerce-mode.js";
import { InProcessCommerceClient } from "./in-process-commerce-client.js";

/**
 * Pure in the mode (unit-tested without a bundler in the loop, the same seam
 * `resolveCommerceServiceBaseUrl` already uses).
 *
 * Async because the http branch awaits the write-gate token from write-only kv.
 * The in-process branch reads NO token — there is no service to authenticate
 * to, so there is nothing to authenticate WITH — and the signature stays
 * `Promise`-shaped so the nineteen call sites do not have to change again when
 * the branch is deleted.
 *
 * The in-process client constructs every commerce adapter over `ctx.storage`, so
 * a context with no document store fails HERE, at construction, naming what is
 * missing — never several frames later inside a storefront route.
 */
export async function makeCommerceClientFor(
	ctx: PluginContext,
	mode: CommerceMode,
): Promise<CommerceClient> {
	if (mode === "in-process") return new InProcessCommerceClient(ctx);

	const serviceToken = await serviceTokenFromKv(ctx);
	return new HttpCommerceClient({
		fetch: ctx.http.fetch,
		baseUrl: COMMERCE_SERVICE_BASE_URL,
		...(serviceToken !== undefined ? { serviceToken } : {}),
	});
}

/** One client per invocation, matching the request-scoped lifecycle the
 *  storefront routes already had: the token can be re-provisioned between
 *  requests, and a client is cheap. */
export function makeCommerceClient(ctx: PluginContext): Promise<CommerceClient> {
	return makeCommerceClientFor(ctx, resolveCommerceMode());
}
