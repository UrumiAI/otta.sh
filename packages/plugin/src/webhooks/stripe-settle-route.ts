/**
 * `webhooks/stripe/settle` — the PUBLIC plugin route a Stripe webhook settles
 * through (work order 02, INC-C1b).
 *
 * WHY THE PLUGIN VERIFIES THE SIGNATURE ITSELF, and not the site. The original
 * fold-in plan had the calling site verify the HMAC and then dispatch into the
 * plugin through EmDash's PRIVATE route dispatcher
 * (`context.locals.emdash.handlePluginApiRoute`). That is structurally
 * impossible: a webhook request is always UNAUTHENTICATED, EmDash binds the
 * private dispatcher only on the authenticated path, and an anonymous request
 * therefore only ever reaches `handlePublicPluginApiRoute` — which dispatches to
 * routes registered `public: true`. So the route is public, and the real trust
 * anchor moves in here with it: `StripePaymentGateway.verifyConfirmation` does a
 * genuine `crypto.subtle.verify` HMAC check against
 * `settings:stripeWebhookSecret`, and a forged delivery without that signing
 * secret cannot pass it. `public: true` means "no session", never "no auth".
 *
 * THE TWO GATES, in order, and why the order is the security property:
 *
 *  1. The `X-Otta-Wh-Token` EDGE token — a shared secret the calling site
 *     attaches, compared in CONSTANT TIME against `settings:otta-wh-token`. It
 *     runs FIRST, before any other kv read, before the gateway exists and before
 *     the domain is touched, so an unattributed request costs one kv get and
 *     nothing else. It is deliberately PASS-THROUGH WHEN UNSET, mirroring the
 *     service's own `requireServiceToken` ("token unset ⇒ next()",
 *     `service/src/auth.ts`), so a deploy that never provisioned it degrades to
 *     "Stripe HMAC only" rather than to "every webhook 401s".
 *  2. The Stripe HMAC — UNCONDITIONAL. It does not consult the token gate's
 *     outcome and there is no branch that can skip it. That is what keeps gate 1's
 *     pass-through from ever becoming a disabled-verification path: with no edge
 *     token configured, a tampered body is still rejected.
 *
 * WHY THE BODY TRAVELS AS BASE64. EmDash's route framework JSON-parses the
 * request body before any handler runs and exposes no raw-body read, and a
 * Stripe HMAC is computed over the EXACT delivered bytes — a re-serialized JSON
 * object is a different byte string and would never verify. The caller therefore
 * base64-encodes the raw bytes; this handler decodes them and hands the
 * byte-identical buffer to the gateway.
 *
 * WHY THE STATUS IS IN THE BODY. The same framework wraps a handler's return in
 * `{success, data}` at HTTP 200, and Stripe's retry logic keys on the STATUS. So
 * this route returns the status it WANTS as a field, using exactly the mapping
 * `service/src/routes/webhooks.ts` used, and the calling site replays it onto the
 * real response. Keeping the table identical is what stops Stripe's retry
 * semantics from drifting when the transport changed underneath them.
 *
 * NO SECRET, of either kind, appears in any value this module returns: the
 * results below are a fixed set of `reason` strings, and neither the edge token
 * nor the webhook secret is ever interpolated into one.
 */

import { settleOrder, type SettleDeps, type SettleResult } from "@otta-sh/domain";
import { StripePaymentGateway } from "@otta-sh/payments-stripe";
import { createInProcessCommerceStores } from "../commerce/in-process-commerce-stores.js";
import {
	constantTimeEquals,
	stripeWebhookSecretFromKv,
	WEBHOOK_EDGE_TOKEN_HEADER,
	webhookEdgeTokenFromKv,
} from "../payment-secrets.js";
import type { PluginContext, RouteHandler, SandboxedRequest } from "../types.js";

/** The PUBLIC route path a forwarded Stripe webhook posts to. Named for what it
 *  does — settle a Stripe webhook — in the repo's `<area>/<thing>/<verb>` route
 *  convention (`storefront/checkout/place`, `entitlements/download`). */
export const STRIPE_WEBHOOK_SETTLE_ROUTE = "webhooks/stripe/settle";

export interface StripeWebhookSettleInput {
	/** The webhook's RAW bytes, base64-encoded — see the module doc. */
	rawBodyBase64?: unknown;
	/** The delivery's `Stripe-Signature` header, verbatim. */
	stripeSignature?: unknown;
	/** The caller's idempotency key for this delivery. Required by the wire
	 *  contract and validated here; it is NOT a second dedupe mechanism — see
	 *  {@link settleOnce}. */
	idempotencyKey?: unknown;
}

/**
 * What the caller reconstructs an HTTP response from. `status` is the status
 * `service/src/routes/webhooks.ts` would have returned for the same outcome, so
 * Stripe sees the retry semantics it has always seen.
 */
export type StripeWebhookSettleResult =
	| { ok: true; status: 200 }
	| { ok: false; status: 400 | 401 | 404 | 200 | 503; reason: StripeWebhookSettleReason };

/** Every refusal this route can express. A FIXED vocabulary: no message is built
 *  from a secret, a kv error, or a gateway diagnostic. */
export type StripeWebhookSettleReason =
	| "UNAUTHORIZED"
	| "NOT_CONFIGURED"
	| "MALFORMED"
	| "INVALID_SIGNATURE"
	| "UNKNOWN_EVENT"
	| "ORDER_NOT_FOUND"
	| "AMOUNT_MISMATCH";

/**
 * Case-insensitive header read, tolerant of BOTH container shapes.
 *
 * HTTP header names are case-insensitive, so matching `X-Otta-Wh-Token`
 * literally would fail the gate for a caller who sent `x-otta-wh-token`. That
 * half is load-bearing today. The CONTAINER sniffing below is DEFENSIVE: it
 * guards a dispatch path that does not currently exist, and no delivery has ever
 * been rejected for want of it.
 *
 * What actually arrives, in either registration mode, is the plain lowercase
 * `Record<string, string>` that `SandboxedRequest` already declares. Otta
 * registers as `format: "standard"` and its default export (`plugin.ts`) has NO
 * top-level `id`, so EmDash's integration wraps the handler in
 * `adaptSandboxEntry` — and with no `id` on the definition that adapter takes
 * its non-pass-through branch and flattens `ctx.request.headers` into a record
 * before this handler is ever called. It does so for the in-process
 * registration (`plugins: []`, how `sites/staging` registers this plugin) just
 * as for the sandboxed one, so `PluginRouteHandler.invoke`'s genuine `Request`
 * never reaches here. The enumeration branch is the branch that runs.
 *
 * Why sniff anyway: a real `Headers` keeps its entries behind an iterator rather
 * than on the object, so `Object.entries()` on one returns `[]` and this gate
 * would silently read no header at all — degrading to "token set, header absent"
 * and a 401 on every genuine delivery. That failure mode is expensive enough,
 * and one `typeof …get === "function"` check cheap enough, that the annotation
 * is deliberately not trusted to be the last word on what arrives. `Headers` is
 * identified by its `.get`, which already does the case-insensitive match.
 */
function header(request: SandboxedRequest, name: string): string | undefined {
	const headers = request.headers as unknown as
		| Record<string, string>
		| { get(name: string): string | null };
	if (typeof (headers as { get?: unknown }).get === "function") {
		const value = (headers as { get(name: string): string | null }).get(name);
		return value === null ? undefined : value;
	}
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers as Record<string, string>)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

/**
 * GATE 1. `true` when the request may proceed.
 *
 * Three outcomes, and the middle one is the subtle one:
 *  - token UNSET (never provisioned, empty, or kv unreadable — `readWriteOnlySecret`
 *    folds all three to `undefined`) ⇒ PASS THROUGH. The HMAC still applies.
 *  - token SET, header absent ⇒ reject. No comparison is attempted; the absence
 *    of a header is not a secret and leaks nothing by short-circuiting.
 *  - token SET, header present ⇒ CONSTANT-TIME compare (`constantTimeEquals`),
 *    never `===`, which returns at the first differing byte and would leak the
 *    token one character at a time through response latency.
 */
async function edgeTokenAccepted(ctx: PluginContext, request: SandboxedRequest): Promise<boolean> {
	const expected = await webhookEdgeTokenFromKv(ctx);
	if (expected === undefined) return true;
	const provided = header(request, WEBHOOK_EDGE_TOKEN_HEADER);
	if (provided === undefined) return false;
	return constantTimeEquals(provided, expected);
}

/** Decode base64 to bytes with `atob` — an ambient global in workerd AND in
 *  modern Node, so no `node:buffer` import crosses the sandbox perimeter.
 *  `undefined` on anything that is not valid base64: a malformed body is a
 *  client error, never a throw out of the handler. */
function decodeBase64(value: string): Uint8Array | undefined {
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return undefined;
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * The `SettleResult` → status/reason table, mirrored EXACTLY from
 * `packages/service/src/routes/webhooks.ts`:
 *
 *  - settled (or an idempotent no-op) ⇒ 200, so Stripe stops retrying;
 *  - INVALID_SIGNATURE / MALFORMED / UNKNOWN_EVENT ⇒ 400;
 *  - ORDER_NOT_FOUND ⇒ 404;
 *  - AMOUNT_MISMATCH ⇒ 200, because it is a recorded anomaly that retrying will
 *    never fix.
 */
export function settleResultToResponse(res: SettleResult): StripeWebhookSettleResult {
	if (res.ok) return { ok: true, status: 200 };
	switch (res.reason) {
		case "INVALID_SIGNATURE":
		case "MALFORMED":
		case "UNKNOWN_EVENT":
			return { ok: false, status: 400, reason: res.reason };
		case "ORDER_NOT_FOUND":
			return { ok: false, status: 404, reason: res.reason };
		case "AMOUNT_MISMATCH":
			return { ok: false, status: 200, reason: res.reason };
	}
}

/**
 * The settle call, as a named seam.
 *
 * REPLAY IS THE DOMAIN'S JOB, NOT THIS ROUTE'S. `settleOrder` claims the
 * delivery's `dedupeKey` (the Stripe event id) in `payment_events` under a UNIQUE
 * constraint and re-drives only state-guarded, idempotent steps, so the same
 * signed delivery submitted twice leaves ONE dedupe row and one payment. Adding a
 * second dedupe keyed on the request's `idempotencyKey` here would be a parallel
 * mechanism that can disagree with the first — which is why the request's key is
 * validated for contract conformance and then deliberately not used to gate
 * anything.
 */
export type SettleFn = (
	deps: SettleDeps,
	gateway: StripePaymentGateway,
	raw: { kind: "webhook"; body: Uint8Array; headers: Record<string, string> },
) => Promise<SettleResult>;

async function settleOnce(
	deps: SettleDeps,
	gateway: StripePaymentGateway,
	body: Uint8Array,
	signature: string,
	settle: SettleFn,
): Promise<SettleResult> {
	return settle(deps, gateway, {
		kind: "webhook",
		body,
		headers: { "stripe-signature": signature },
	});
}

/** Test-facing overrides. A deploy passes none of them. */
export interface StripeWebhookSettleOptions {
	/** The settle use-case, injectable so a suite can COUNT calls (and prove the
	 *  token gate short-circuits before any). Default: the real `settleOrder`. */
	settle?: SettleFn;
}

export function createStripeWebhookSettleHandler(
	options: StripeWebhookSettleOptions = {},
): RouteHandler<StripeWebhookSettleInput> {
	const settle = options.settle ?? (settleOrder as SettleFn);
	return async (routeCtx, ctx): Promise<StripeWebhookSettleResult> => {
		// ── GATE 1: the edge token, BEFORE anything else reads kv or allocates ──
		// Nothing above this line touches `settings:stripeWebhookSecret`, builds a
		// gateway, or constructs a store. A rejection here costs exactly one kv get.
		if (!(await edgeTokenAccepted(ctx, routeCtx.request))) {
			return { ok: false, status: 401, reason: "UNAUTHORIZED" };
		}

		const { rawBodyBase64, stripeSignature, idempotencyKey } = routeCtx.input;
		if (
			!isNonEmptyString(rawBodyBase64) ||
			!isNonEmptyString(stripeSignature) ||
			!isNonEmptyString(idempotencyKey)
		) {
			return { ok: false, status: 400, reason: "MALFORMED" };
		}
		const body = decodeBase64(rawBodyBase64);
		if (body === undefined) return { ok: false, status: 400, reason: "MALFORMED" };

		// ── GATE 2: the Stripe HMAC — read the signing secret, then verify. ──────
		// Unconfigured is FAIL-CLOSED and says so with a 503 rather than pretending
		// the signature failed: a 400 would tell Stripe the delivery was bad, when
		// the truth is that this deployment has not been provisioned.
		const webhookSecret = await stripeWebhookSecretFromKv(ctx);
		if (webhookSecret === undefined) {
			return { ok: false, status: 503, reason: "NOT_CONFIGURED" };
		}

		const gateway = new StripePaymentGateway({ webhookSecret });
		const stores = createInProcessCommerceStores(ctx);
		const deps: SettleDeps = {
			orderStore: stores.orderStore,
			entitlementStore: stores.entitlementStore,
			paymentEventStore: stores.paymentEventStore,
			inventoryStore: stores.inventory,
			couponStore: stores.couponStore,
			clock: stores.clock,
		};
		return settleResultToResponse(await settleOnce(deps, gateway, body, stripeSignature, settle));
	};
}
