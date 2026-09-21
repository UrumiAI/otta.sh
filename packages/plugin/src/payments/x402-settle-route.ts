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
 * reaches nothing. `public: true` means "no session", never "no auth".
 *
 * THE FOUR CHECKS, in order, and why the order is the security property. Review
 * round 2 (re-reviewers A1/B1/B2) found the first cut of this route standing on
 * the facilitator alone, which is one layer where its Stripe sibling has two and,
 * worse, which left the receipt→order binding to an amount equality:
 *
 *  1. The `X-Otta-Wh-Token` EDGE token (shared with `webhooks/stripe/settle`,
 *     `edge-token.ts`), compared in CONSTANT TIME, PASS-THROUGH WHEN UNSET. It
 *     runs FIRST so an unattributed request costs one kv get and, critically, no
 *     METERED facilitator call — this route's expensive work is a third-party API
 *     request and a Worker subrequest, which is precisely what a cheap outer gate
 *     exists to stop a stranger from spending.
 *  2. The ORDER, loaded before any egress: it must exist (404) and its
 *     `paymentMethod` must be `"x402"` (400). The service's `/grant` could skip
 *     this because `requireInternalToken` meant only the page layer could reach
 *     it; anonymous, it cannot. Without it an x402 receipt settles a STRIPE order
 *     of equal total — and every order a storefront deployment holds is a Stripe
 *     order today, so that was the route's entire reachable effect set.
 *  3. The FACILITATOR, unconditionally, with no branch that can skip it. A forged
 *     receipt for an on-chain settlement that never happened is refused by the
 *     only party that can actually know.
 *  4. The TX-HASH BINDING, inside `settleOrder`: a receipt whose `transaction` is
 *     already recorded against a different order is a terminal `RECEIPT_REBOUND`
 *     (§ step 2b there). One settlement consumes one on-chain payment — the claim
 *     `@otta-sh/payments-x402`'s header makes, now enforced rather than assumed.
 *
 * Checks 1 and 2 REDUCE what the facilitator is asked about; they never substitute
 * for check 3 or 4, and there is no configuration under which either is skipped.
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
import { edgeTokenAccepted } from "../edge-token.js";
import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import type { RouteHandler } from "../types.js";
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
	| "UNAUTHORIZED"
	| "NOT_CONFIGURED"
	| "FACILITATOR_UNAVAILABLE"
	| "MALFORMED"
	| "INVALID_SIGNATURE"
	| "UNKNOWN_EVENT"
	| "ORDER_NOT_FOUND"
	/** The named order exists but was not created to be paid with x402. Named
	 *  rather than folded into `ORDER_NOT_FOUND` because the two are different
	 *  facts for the page layer; neither discloses anything about the order. */
	| "WRONG_PAYMENT_METHOD"
	| "AMOUNT_MISMATCH"
	/** The receipt's `transaction` is already recorded against a DIFFERENT order
	 *  (`settleOrder` step 2b). One settlement, one on-chain payment. */
	| "RECEIPT_REBOUND";

/**
 * What the caller reconstructs an HTTP response from — the same in-body-status
 * shape `webhooks/stripe/settle` uses, and for the same reason: EmDash's route
 * framework wraps every handler return in `{success, data}` at HTTP 200, so a
 * route that needs to express a status has to say it as a field.
 */
export type X402SettleResult =
	| { ok: true; status: 200 }
	| { ok: false; status: 400 | 401 | 404 | 503; reason: X402SettleReason };

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
		: // `RECEIPT_REBOUND` lands here too, and 400 is right for it on this route
			// for the same reason `AMOUNT_MISMATCH` is: nothing retries this call, the
			// anomaly is already recorded, and the caller deserves to hear that the
			// receipt it presented belongs to another order.
			{ ok: false, status: 400, reason: res.reason };
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
		// VALIDATE BEFORE ANYTHING: a garbage body must cost no kv read and no
		// network call. It is also the arm a scanner finds first.
		const proof = parseProof(routeCtx.input);
		if (proof === undefined) return { ok: false, status: 400, reason: "MALFORMED" };

		// ── CHECK 1: the edge token, before any other kv read and before egress ──
		// Pass-through when unset (see `edge-token.ts`). The facilitator call below
		// is a METERED third-party request; this is what keeps an anonymous stranger
		// from spending it.
		if (!(await edgeTokenAccepted(ctx, routeCtx.request))) {
			return { ok: false, status: 401, reason: "UNAUTHORIZED" };
		}

		// FAIL-CLOSED, and 503 rather than a rejection: "this deployment never
		// configured x402" is not the same statement as "your proof is bad", and
		// telling a buyer whose money moved that their receipt was invalid would be
		// a lie with no recovery.
		const gateway = await x402GatewayFromCtx(ctx, egress);
		if (gateway === undefined) return { ok: false, status: 503, reason: "NOT_CONFIGURED" };

		// ── CHECK 2: THIS ORDER IS AN x402 ORDER — before the facilitator call ────
		// `settleOrder` is gateway-agnostic by design and never consults
		// `paymentMethod`; behind `requireInternalToken` the service could rely on
		// that. Anonymous it cannot: without this, a facilitator-valid receipt of
		// the right amount settles a STRIPE order of the same total, and storefront
		// checkout originates nothing else today. Route-local on purpose — it is a
		// statement about THIS surface, not a new rule for every gateway.
		const stores = createInProcessCommerceStores(ctx);
		const order = await stores.orderStore.getById(proof.orderId);
		if (order === null) return { ok: false, status: 404, reason: "ORDER_NOT_FOUND" };
		if (order.paymentMethod !== "x402") {
			return { ok: false, status: 400, reason: "WRONG_PAYMENT_METHOD" };
		}

		try {
			return x402SettleResultToResponse(
				await settleOrder(settleDeps(stores), gateway, {
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
 *  route uses — so both settlement surfaces see one set of stores and one clock.
 *  Takes the ALREADY-BUILT stores, so the pre-flight order read and the settle
 *  see one set rather than two. */
function settleDeps(stores: ReturnType<typeof createInProcessCommerceStores>): SettleDeps {
	return {
		orderStore: stores.orderStore,
		entitlementStore: stores.entitlementStore,
		paymentEventStore: stores.paymentEventStore,
		inventoryStore: stores.inventory,
		couponStore: stores.couponStore,
		clock: stores.clock,
	};
}
