/**
 * `entitlements/x402/settle` — the PUBLIC plugin route an x402 page-gate proof
 * settles through. The in-process replacement for the commerce service's
 * `POST /entitlements/grant` (INC-C5 revision, review A1/B5).
 *
 * WHY IT HAD TO LAND IN THIS INCREMENT. INC-C5 folded the x402 GATEWAY in, but
 * the only thing in the repo that ever called
 * `settleOrder(gateway, {kind: "page_gate"})` was a route on the service that
 * INC-D3b deletes. Wiring a gateway nothing can drive is not a fold-in; it is a
 * functional regression scheduled for the day staging flips to in-process. The
 * gap closes here, and it closes entirely inside this package: a route file plus
 * one registration, no `CommerceClient` change and nothing new in
 * `@otta-sh/domain`.
 *
 * WHY THE ROUTE IS PUBLIC, and what stands in for the service's token gate. The
 * service guarded `/grant` with `X-Internal-Token` because it was a
 * server-to-server POST from the page layer. In the plugin there is no such
 * channel: EmDash binds its PRIVATE route dispatcher only on the authenticated
 * admin path, so a storefront request reaches `handlePublicPluginApiRoute` or it
 * reaches nothing. The trust anchor moves in here with the route, exactly as it
 * did for `webhooks/stripe/settle`: the proof is verified by the configured
 * FACILITATOR over `ctx.http`, unconditionally, with no branch that can skip it.
 * `public: true` means "no session", never "no auth" — a forged receipt for an
 * on-chain settlement that never happened is refused by the facilitator, which is
 * the only party that can actually know.
 *
 * WHAT THE RECEIPT DELIBERATELY DOES NOT CARRY. The service returned the FULL
 * serialized order on success, which it could afford behind its token gate. This
 * route is public, so it states the OUTCOME and nothing about the buyer — no
 * email, no lines, no totals (ADR-0010 §2's redaction rule applied at the surface
 * that needs it). The caller already holds the order's unguessable capability URL
 * and re-reads through it.
 *
 * THE THREE-WAY OUTCOME, and why the middle one exists. A facilitator that
 * REJECTS the proof is a terminal 400. A facilitator that could not be ASKED —
 * outage, timeout, garbage body — is a 503, because the buyer's money has
 * already moved on-chain and a transient blip must not become a permanent
 * refusal no retry can undo. `@otta-sh/payments-x402` carries that distinction
 * out of the adapter as `X402FacilitatorUnavailableError` (a throw, mirroring
 * `payments-stripe`'s `PaymentIntentError({retryable})`, because
 * `ConfirmationResult`'s failure union is closed and all three of its reasons
 * are terminal); this is the surface that turns it into a status.
 *
 * NO CREDENTIAL, of any kind, appears in a value this module returns: every
 * refusal is one of a fixed vocabulary of `reason` strings, and the caught
 * facilitator error is dropped rather than interpolated.
 */
import {
	cents,
	currency as toCurrency,
	orderId as toOrderId,
	settleOrder,
	type SettleDeps,
	type SettleResult,
	type X402Proof,
} from "@otta-sh/domain";
import { X402FacilitatorUnavailableError } from "@otta-sh/payments-x402";
import { createInProcessCommerceStores } from "../commerce/in-process-commerce-stores.js";
import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import type { PluginContext, RouteHandler } from "../types.js";
import { x402GatewayFromCtx, type X402Egress } from "./x402-wiring.js";

/** The PUBLIC route path an x402 page-gate proof posts to. Named in the repo's
 *  `<area>/<thing>/<verb>` convention, alongside `webhooks/stripe/settle`. */
export const X402_SETTLE_ROUTE = "entitlements/x402/settle";

/** The facilitator `SettleResponse` the page layer forwards, verbatim on the
 *  wire — the same seven fields the service's `x402ProofBody` accepted. */
export interface X402SettleInput {
	orderId?: unknown;
	transaction?: unknown;
	network?: unknown;
	payer?: unknown;
	/** Integer MINOR units. Never a float, and never a formatted string. */
	amount?: unknown;
	currency?: unknown;
	signature?: unknown;
}

/** Every refusal this route can express. A FIXED vocabulary: no message is built
 *  from a credential, a kv error or a facilitator diagnostic. */
export type X402SettleReason =
	| "NOT_CONFIGURED"
	| "FACILITATOR_UNAVAILABLE"
	| "MALFORMED"
	| "INVALID_SIGNATURE"
	| "UNKNOWN_EVENT"
	| "ORDER_NOT_FOUND"
	| "AMOUNT_MISMATCH";

/**
 * What the caller reconstructs an HTTP response from — the same in-body-status
 * shape `webhooks/stripe/settle` uses, and for the same reason: EmDash's route
 * framework wraps every handler return in `{success, data}` at HTTP 200, so a
 * route that needs to express a status has to say it as a field.
 */
export type X402SettleResult =
	| { ok: true; status: 200 }
	| { ok: false; status: 400 | 404 | 503; reason: X402SettleReason };

/** UUID v4, the shape every order id in this system has — the same bound the
 *  service's `idParam` enforced, restated because there is no zod in the
 *  isolate. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_4217 = /^[A-Z]{3}$/;

function boundedString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/**
 * The wire body → `X402Proof`, or `undefined` for anything that is not one.
 *
 * MONEY IS AN INTEGER MINOR UNIT, checked as one: `Number.isSafeInteger` plus a
 * non-negative bound, so a float that "looks like" a price (10.5) is refused
 * rather than silently truncated into a different amount. The bounds mirror the
 * service's `x402ProofBody` field for field — this is a transport swap, not a
 * revalidation of the contract.
 */
function parseProof(input: X402SettleInput): X402Proof | undefined {
	const orderId = boundedString(input.orderId, 200);
	const transaction = boundedString(input.transaction, 200);
	const network = boundedString(input.network, 64);
	const payer = boundedString(input.payer, 200);
	const currency = boundedString(input.currency, 3);
	const signature = boundedString(input.signature, 4096);
	const amount = input.amount;
	if (
		orderId === undefined ||
		!UUID.test(orderId) ||
		transaction === undefined ||
		network === undefined ||
		payer === undefined ||
		currency === undefined ||
		!ISO_4217.test(currency) ||
		signature === undefined ||
		typeof amount !== "number" ||
		!Number.isSafeInteger(amount) ||
		amount < 0
	) {
		return undefined;
	}
	return {
		orderId: toOrderId(orderId),
		transaction,
		network,
		payer,
		amount: cents(amount),
		currency: toCurrency(currency),
		signature,
	};
}

/**
 * The `SettleResult` → status/reason table, mirrored from the service's
 * `POST /entitlements/grant`: a missing order is 404, every other refusal is a
 * terminal 400.
 *
 * `AMOUNT_MISMATCH` is 400 here and 200 on the Stripe webhook route, and the
 * difference is not drift: Stripe RETRIES on a non-2xx, so a recorded anomaly
 * there has to be acknowledged. Nothing retries this route on the caller's
 * behalf, and the page layer asking to settle for the wrong amount deserves to
 * hear so — which is exactly what the service said too.
 */
export function x402SettleResultToResponse(res: SettleResult): X402SettleResult {
	if (res.ok) return { ok: true, status: 200 };
	return res.reason === "ORDER_NOT_FOUND"
		? { ok: false, status: 404, reason: "ORDER_NOT_FOUND" }
		: { ok: false, status: 400, reason: res.reason };
}

/** Test-facing overrides. A deploy passes none of them. */
export interface X402SettleOptions {
	/** The deployment-supplied facilitator URL. Defaults to the build-time define
	 *  the allowlist is derived from — injected only so a suite can drive both the
	 *  configured and unconfigured arms without a bundler. */
	egress?: X402Egress;
}

export function createX402SettleHandler(
	options: X402SettleOptions = {},
): RouteHandler<X402SettleInput> {
	const egress = options.egress ?? IN_PROCESS_EGRESS_URLS;
	return async (routeCtx, ctx): Promise<X402SettleResult> => {
		// VALIDATE BEFORE EGRESS: a garbage body must cost no network call and no
		// kv read. It is also the arm a scanner finds first.
		const proof = parseProof(routeCtx.input);
		if (proof === undefined) return { ok: false, status: 400, reason: "MALFORMED" };

		// FAIL-CLOSED, and 503 rather than a rejection: "this deployment never
		// configured x402" is not the same statement as "your proof is bad", and
		// telling a buyer whose money moved that their receipt was invalid would be
		// a lie with no recovery.
		const gateway = await x402GatewayFromCtx(ctx, egress);
		if (gateway === undefined) return { ok: false, status: 503, reason: "NOT_CONFIGURED" };

		try {
			return x402SettleResultToResponse(
				await settleOrder(settleDeps(ctx), gateway, {
					kind: "page_gate",
					proof,
				}),
			);
		} catch (err) {
			// The one throw this path can produce on purpose. Anything else is a real
			// fault and must keep propagating rather than be flattened into a 503
			// that hides it.
			if (err instanceof X402FacilitatorUnavailableError) {
				return { ok: false, status: 503, reason: "FACILITATOR_UNAVAILABLE" };
			}
			throw err;
		}
	};
}

/** Every `SettleDeps` field, from the same composition root the Stripe settle
 *  route uses — so both settlement surfaces see one set of stores and one clock. */
function settleDeps(ctx: PluginContext): SettleDeps {
	const stores = createInProcessCommerceStores(ctx);
	return {
		orderStore: stores.orderStore,
		entitlementStore: stores.entitlementStore,
		paymentEventStore: stores.paymentEventStore,
		inventoryStore: stores.inventory,
		couponStore: stores.couponStore,
		clock: stores.clock,
	};
}
