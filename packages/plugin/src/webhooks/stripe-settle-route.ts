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
import { isRetryableStorageBusy } from "@otta-sh/store-emdash";
import { createInProcessCommerceStores } from "../commerce/in-process-commerce-stores.js";
import { edgeTokenAccepted } from "../edge-token.js";
import {
	sendOrderEmailsNow,
	type SendOrderEmailsNowOptions,
} from "../email/send-order-emails-now.js";
import { stripeWebhookSecretFromKv } from "../payment-secrets.js";
import { boundedRefundStripeOptions } from "../payments/bounded-refund-options.js";
import { stripeGatewayFromCtx } from "../payments/stripe-wiring.js";
import { settleDeadline } from "../settle-deadline.js";
import type { RouteHandler } from "../types.js";

/** The PUBLIC route path a forwarded Stripe webhook posts to. Named for what it
 *  does — settle a Stripe webhook — in the repo's `<area>/<thing>/<verb>` route
 *  convention (`storefront/checkout/place`, `entitlements/download`). */
export const STRIPE_WEBHOOK_SETTLE_ROUTE = "webhooks/stripe/settle";

/** Bound on each Stripe call a settle makes. A late payment's refund is TWO calls
 *  (the pre-flight read, then the create), so 3 s each keeps the pair well inside
 *  Stripe's ~10 s webhook delivery timeout. See the handler. */
export const SETTLE_PROVIDER_TIMEOUT_MS = 3_000;

/** Room kept, after a refund create, for the storage writes that record it
 *  (finalize, resolve, notice): a create starts only while its whole bound plus
 *  this still fit in the request's deadline. It is an ESTIMATE of those writes, not
 *  a bound on them; an overrun is absorbed by the headroom the 8 s request budget
 *  leaves under Stripe's ~10 s delivery timeout (~2 s). */
export const SETTLE_REFUND_STORAGE_MS = 500;

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
	| {
			ok: false;
			status: 400 | 401 | 404 | 200 | 503;
			reason: Exclude<StripeWebhookSettleReason, "BUSY" | "LATE_PAYMENT_REFUND_RETRYABLE">;
	  }
	/** The refusals that say "the same delivery will work later": storage
	 *  contention, and a late payment's refund hitting a transient provider error.
	 *  `retryable` rides on every such shape Otta emits, and is what the site keys
	 *  its `Retry-After` on. */
	| { ok: false; status: 503; reason: "BUSY" | "LATE_PAYMENT_REFUND_RETRYABLE"; retryable: true };

/** Every refusal this route can express. A FIXED vocabulary: no message is built
 *  from a secret, a kv error, or a gateway diagnostic. */
export type StripeWebhookSettleReason =
	| "UNAUTHORIZED"
	| "NOT_CONFIGURED"
	| "MALFORMED"
	| "INVALID_SIGNATURE"
	| "UNKNOWN_EVENT"
	| "ORDER_NOT_FOUND"
	| "AMOUNT_MISMATCH"
	| "RECEIPT_REBOUND"
	/** A success landed on an expired/cancelled order and its AUTOMATIC refund
	 *  hit a transient Stripe failure. 503, so Stripe redelivers; the redelivery
	 *  resumes the SAME reserved refund under the SAME key (never a second one). */
	| "LATE_PAYMENT_REFUND_RETRYABLE"
	/** The store was too busy to commit (compare-and-set budget exhausted, or a
	 *  retryable serialization abort). Always 503: Stripe retries it. */
	| "BUSY";

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
 * The `SettleResult` → status/reason table. It began as a mirror of the
 * standalone `@otta-sh/service`'s webhook route; the one deliberate departure is
 * UNKNOWN_EVENT (#300):
 *
 *  - settled (or an idempotent no-op) ⇒ 200, so Stripe stops retrying;
 *  - INVALID_SIGNATURE / MALFORMED ⇒ 400;
 *  - UNKNOWN_EVENT ⇒ 200 — acknowledged, nothing done, no order touched. The
 *    gateway only reports it AFTER the signature verified (the type check sits
 *    past the HMAC in `StripePaymentGateway.verifyConfirmation`), so this is a
 *    genuine Stripe delivery of a type Otta does not act on (`charge.refunded`,
 *    `charge.dispute.created`, … on an endpoint subscribed to more than the two
 *    settle events). A 4xx would make Stripe retry it and, after enough
 *    failures, disable the endpoint — `payment_intent.succeeded` included — and
 *    a 200 to a verified body tells a forger nothing;
 *  - ORDER_NOT_FOUND ⇒ 404;
 *  - AMOUNT_MISMATCH ⇒ 200, because it is a recorded anomaly that retrying will
 *    never fix.
 */
export function settleResultToResponse(res: SettleResult): StripeWebhookSettleResult {
	if (res.ok) return { ok: true, status: 200 };
	switch (res.reason) {
		case "INVALID_SIGNATURE":
		case "MALFORMED":
			return { ok: false, status: 400, reason: res.reason };
		case "UNKNOWN_EVENT":
			return { ok: false, status: 200, reason: res.reason };
		case "ORDER_NOT_FOUND":
			return { ok: false, status: 404, reason: res.reason };
		case "AMOUNT_MISMATCH":
			return { ok: false, status: 200, reason: res.reason };
		case "RECEIPT_REBOUND":
			// A signed Stripe event whose id is already recorded against ANOTHER
			// order. 200, for the same reason AMOUNT_MISMATCH is: the anomaly is
			// recorded and no redelivery can ever fix it, so Stripe should stop.
			return { ok: false, status: 200, reason: res.reason };
		case "LATE_PAYMENT_REFUND_RETRYABLE":
			// The opposite of the two above: a redelivery is EXACTLY what fixes it.
			// The late payment is recorded, its refund reserved and the order flagged;
			// Stripe's retry re-drives settle, which resumes that refund. 503 is the
			// status Stripe retries on.
			return { ok: false, status: 503, reason: res.reason, retryable: true };
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
	/** The inline order-email dispatch's overrides — chiefly an injected sender, so a
	 *  suite proves the confirmation goes out without any egress. Default: the sender
	 *  built from this bundle's email API URL (none ⇒ no inline send). */
	orderEmails?: SendOrderEmailsNowOptions;
	/** The wall clock the request's deadline is measured on. Default: `Date.now`. */
	now?: () => number;
}

export function createStripeWebhookSettleHandler(
	options: StripeWebhookSettleOptions = {},
): RouteHandler<StripeWebhookSettleInput> {
	const settle = options.settle ?? (settleOrder as SettleFn);
	return async (routeCtx, ctx): Promise<StripeWebhookSettleResult> => {
		// The request's ONE deadline, fixed FIRST (`settle-deadline.ts`): a late
		// payment's Stripe refund calls and the inline order-email attempt both draw on
		// it, so their SUM — not each alone — stays under Stripe's ~10 s delivery
		// timeout. The settle's own storage work is charged to it by running first.
		const deadline = settleDeadline(options.now);
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

		// REFUND-CAPABLE when the deployment has a secret key. A late payment — a
		// success landing on an order that already expired — is refunded inside
		// `settleOrder`, through THIS gateway; a verify-only gateway is honestly
		// `refundable: false`, and settle then falls back to flagging the order for
		// a manual refund. The webhook secret above stays the gate either way: the
		// fallback is constructed from it, and `stripeGatewayFromCtx` re-reads the
		// same kv key, so verification is identical on both arms.
		//
		// BOUNDED: the refund runs inside Stripe's own delivery, which Stripe treats
		// as failed after ~10 s and sends again. A refund pinned to the transport's
		// 30 s default could still be in flight when the redelivery arrives; each call
		// is bounded by SETTLE_PROVIDER_TIMEOUT_MS AND by what is left of the request's
		// deadline when it starts (asked per call), so a stalled call classifies
		// (retryable read, or an unverified create after its full bound) well inside
		// the delivery, and the next attempt resumes the same reservation under the
		// same key.
		//
		// The CREATE is the exception to "bounded by what is left": a create that
		// times out is AMBIGUOUS (it may have reached Stripe) and lands as "verify in
		// Stripe", blocking the automatic retry. So, exactly as the sweep's
		// late-refunds leg does (`boundedRefundStripeOptions`, one shared rule), the
		// pre-flight READ takes min(SETTLE_PROVIDER_TIMEOUT_MS, left) and the create
		// gets its FULL bound or is not started — NOT_STARTED leaves the refund
		// reserved, uncounted, for the redelivery or the sweep. Worst case the request
		// spends: storage, then a read ≤ 3 s, then a create of 3 s only if 3 s plus the
		// writes after it still fit — all inside the 8 s deadline, and the inline email
		// takes only what is left after that.
		const gateway =
			(await stripeGatewayFromCtx(
				ctx,
				boundedRefundStripeOptions(deadline, {
					createMs: SETTLE_PROVIDER_TIMEOUT_MS,
					storageMs: SETTLE_REFUND_STORAGE_MS,
				}),
			)) ?? new StripePaymentGateway({ webhookSecret });
		const stores = createInProcessCommerceStores(ctx);
		const deps: SettleDeps = {
			orderStore: stores.orderStore,
			entitlementStore: stores.entitlementStore,
			paymentEventStore: stores.paymentEventStore,
			inventoryStore: stores.inventory,
			clock: stores.clock,
		};
		let settled: SettleResult;
		try {
			settled = await settleOnce(deps, gateway, body, stripeSignature, settle);
		} catch (err) {
			// STORAGE PRESSURE IS A 503, AND A 503 IS WHAT MAKES STRIPE RETRY. Before
			// this, the throw escaped as the host's 500 — which Stripe also retries,
			// but indistinguishably from a real fault. Retrying is safe because
			// replay is the DOMAIN's job (see `settleOnce`): the redelivery re-claims
			// the same event id and re-drives only state-guarded steps, so a delivery
			// that made progress before the store gave up still settles exactly once
			// (`stripe-settle-route.test.ts` (iv) and (ix)). Anything else keeps
			// propagating — flattening a real fault into a 503 would hide it.
			if (isRetryableStorageBusy(err)) {
				console.warn(`[otta] ${STRIPE_WEBHOOK_SETTLE_ROUTE} busy (retryable):`, err);
				return { ok: false, status: 503, reason: "BUSY", retryable: true };
			}
			throw err;
		}

		// ── The order's emails, NOW — best-effort, after the settle is decided ───
		// The confirmation used to wait for the next sweep tick, behind the rest of the
		// queue; the settle has just made it due, so send it with the settlement
		// (ADR-0005's 2026-10-02 amendment). Four properties, each load-bearing:
		//
		//  - OUTSIDE the BUSY→503 mapping above, and the response is computed from
		//    `settled` alone. `sendOrderEmailsNow` never throws, but even if it could,
		//    nothing it does may change what Stripe hears: the payment is recorded, and
		//    a non-200 would ask Stripe to redeliver a settlement that already happened.
		//  - On ANY ok result, `noop` included. A no-op is a redelivery, and the case
		//    that matters is the delivery that committed the paid flip and THEN hit
		//    storage pressure: it answered 503 and never reached this line, so its row
		//    was never attempted and the redelivery — a no-op settle — is the first
		//    chance to send. When nothing is due (the usual replay) the cost is one read
		//    of the order document: the sender is built only once a row is claimed.
		//  - FIRST ATTEMPTS ONLY. The inline claim skips any row a dispatcher has
		//    already tried — at most one COUNTED inline attempt per row, the total
		//    budget (`maxAttempts`) unchanged — so redeliveries during a provider outage
		//    cannot spend it and park the confirmation `failed`. (A cut-short inline
		//    attempt is uncounted and may recur on a later delivery; the
		//    Idempotency-Key dedupes it.)
		//  - Scoped to THIS order (`claimNextEmailForOrder`), never the global drain,
		//    and bounded by what the refund calls left of the request's ONE deadline;
		//    the cron leg stays the at-least-once backstop.
		if (settled.ok && settled.order !== null) {
			await sendOrderEmailsNow(ctx, stores, settled.order.id, {
				...options.orderEmails,
				deadline,
			});
		}
		return settleResultToResponse(settled);
	};
}
