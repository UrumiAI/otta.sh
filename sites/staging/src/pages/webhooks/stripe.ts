/**
 * `POST /webhooks/stripe` — the public URL Stripe delivers to (work order 02,
 * revised INC-C2). Register THIS path in the Stripe dashboard.
 *
 * ── What this endpoint is ─────────────────────────────────────────────────
 * A transport shim, and deliberately nothing more. It reads the delivery's raw
 * bytes, base64-encodes them, attaches the edge token, dispatches the plugin's
 * PUBLIC `webhooks/stripe/settle` route in-process, and replays the status the
 * plugin asks for. It holds no Stripe secret and verifies no signature.
 *
 * ── Why the verification is NOT here ──────────────────────────────────────
 * The original plan had this endpoint verify the HMAC itself and then dispatch
 * through EmDash's PRIVATE route dispatcher. That is structurally impossible: a
 * webhook is always unauthenticated, EmDash binds the private dispatcher only
 * on the authenticated path, and an anonymous request therefore only ever
 * reaches `handlePublicPluginApiRoute`. Since the route had to be public
 * anyway, the trust anchor moved in with it — the plugin does a real
 * `crypto.subtle.verify` against `settings:stripeWebhookSecret`. Keeping a
 * second, independent verification out here would mean a second copy of the
 * webhook secret in a second place, and two implementations that can disagree.
 *
 * ── Why the body is never parsed ──────────────────────────────────────────
 * A Stripe HMAC covers the EXACT delivered bytes. `JSON.parse` followed by
 * `JSON.stringify` is a different byte string — different whitespace, possibly
 * different key order and number formatting — and would fail verification for
 * every genuine delivery. So the bytes are read with `arrayBuffer()` and
 * base64-encoded verbatim; this file contains no `JSON.parse` of the body, and
 * that absence is load-bearing. (Base64 is the transport because EmDash's route
 * framework JSON-parses a route's request body before any handler runs and
 * exposes no raw-body read.)
 *
 * ── Why there is no origin guard ──────────────────────────────────────────
 * Every other POST endpoint in this site starts with `rejectCrossOrigin()`.
 * This one omits it as a NO-OP, not as a hazard — the distinction matters, so
 * that nobody "restores" the guard believing it was dropped for safety.
 * `isForbiddenCrossOrigin` forbids only a PRESENT-and-mismatched `Origin` and
 * deliberately allows an absent one (server-to-server carries no ambient
 * cookie); Stripe sends no `Origin`, so the guard would pass every genuine
 * delivery and reject nothing. It buys nothing here because the CSRF question a
 * guard answers — "did a user's browser get tricked into sending this?" — does
 * not apply to a request whose authority is a cryptographic signature the
 * browser cannot forge. Auth here is the HMAC, plus the edge token in front of
 * it.
 *
 * ── Why the status matters more than the body ─────────────────────────────
 * Stripe retries on 5xx and on a timeout, and stops on 2xx. The plugin returns
 * the status it WANTS as a field (EmDash wraps every handler return at HTTP
 * 200), and this endpoint replays it. Collapsing that to a blanket 200 would
 * tell Stripe a rejected delivery had succeeded and lose the event; collapsing
 * it to a blanket 500 would make Stripe retry deliveries that will never
 * succeed. The body is a diagnostic for the Stripe dashboard only — it carries
 * a fixed `reason` vocabulary and never a secret.
 */
import {
	STRIPE_WEBHOOK_SETTLE_ROUTE,
	WEBHOOK_EDGE_TOKEN_HEADER,
	type StripeWebhookSettleResult,
} from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import { routeDispatcher } from "../../lib/cart-actions.js";
import { dispatchOttaRoute } from "../../lib/otta-api.js";
import { webhookEdgeToken } from "../../lib/webhook-env.js";

/** Stripe's own header, verbatim. Read case-insensitively by `Headers.get`. */
const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/** Encode bytes as base64 with `btoa` — an ambient global in workerd and in
 *  modern Node, mirroring the `atob` the plugin's route decodes with, so no
 *  `node:buffer` import appears on either side of this hop. Webhook payloads
 *  are a few kilobytes, so the per-byte loop is not worth chunking. */
function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function respond(result: StripeWebhookSettleResult): Response {
	return new Response(JSON.stringify(result), {
		status: result.status,
		headers: { "Content-Type": "application/json" },
	});
}

export const POST: APIRoute = async (context) => {
	// Not even shaped like a Stripe delivery. This is the ONE rejection this
	// endpoint makes on its own, and it is a shape check rather than a security
	// check: the plugin would answer the identical 400 MALFORMED a moment later,
	// but there is no reason to spend a dispatch, a kv read and a gateway on a
	// request that cannot possibly verify.
	const signature = context.request.headers.get(STRIPE_SIGNATURE_HEADER);
	if (signature === null || signature.length === 0) {
		return respond({ ok: false, status: 400, reason: "MALFORMED" });
	}

	// The bytes, untouched — see the module doc. `arrayBuffer()`, never `json()`.
	const rawBody = new Uint8Array(await context.request.arrayBuffer());

	// Absent ⇒ no header at all, NOT an empty one. The plugin's gate branches on
	// the header's presence when a token IS configured, so an empty string would
	// turn a graceful "this deploy has no edge token" into a hard 401.
	const token = webhookEdgeToken();
	const headers: Record<string, string> =
		token === undefined ? {} : { [WEBHOOK_EDGE_TOKEN_HEADER]: token };

	const result = await dispatchOttaRoute<StripeWebhookSettleResult>(
		routeDispatcher(context),
		STRIPE_WEBHOOK_SETTLE_ROUTE,
		{
			rawBodyBase64: toBase64(rawBody),
			stripeSignature: signature,
			// REQUIRED BY THE WIRE CONTRACT, AND INERT. The plugin validates that
			// this field is a non-empty string and then deliberately does not use
			// it: replay defence is the domain's own signature-derived `dedupeKey`
			// (the Stripe event id inside the already-verified body), claimed under
			// a UNIQUE constraint in `payment_events`. Deriving a key out here would
			// mean parsing the body — which this endpoint must not do — or hashing
			// the signature, either of which creates a second dedupe mechanism that
			// can disagree with the first. A fresh id per delivery is honest about
			// gating nothing.
			idempotencyKey: `stripe-webhook:${crypto.randomUUID()}`,
		},
		context.url,
		headers,
	);

	// `null` is "the dispatch itself failed" — no public dispatcher bound (this
	// site is misconfigured, or something tried to reach the route off the
	// EmDash middleware), a thrown handler, or a `{success: false}` envelope.
	// 500 so Stripe RETRIES: the delivery was never judged, and treating an
	// unjudged event as settled would silently drop a real payment.
	if (result === null) {
		return new Response(JSON.stringify({ ok: false, reason: "DISPATCH_FAILED" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}

	return respond(result);
};
