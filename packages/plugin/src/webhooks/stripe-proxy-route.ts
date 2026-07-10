import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import type { RouteHandler } from "../types.js";

/** The PUBLIC route path Stripe (or a single-origin edge) posts the webhook to. */
export const STRIPE_WEBHOOK_PROXY_ROUTE = "webhooks/stripe";

/**
 * The posted payload. The host bridge delivers the webhook's **raw body**
 * base64-encoded (`bodyBase64`) so the bytes survive the JSON/marshalling bridge
 * intact (§9 Risk 1) — the plugin decodes it to the EXACT bytes and forwards
 * them, so the service-side HMAC over the raw body still verifies. The
 * `Stripe-Signature` travels in `request.headers`.
 */
export interface StripeWebhookProxyInput {
	bodyBase64?: unknown;
}

export interface StripeWebhookProxyResult {
	status: number;
	body: string;
}

/**
 * The Stripe webhook **proxy** (plan §9 decision 1, step 4.9). A DUMB PIPE: it
 * holds NO secret (it cannot verify — the signing secret is service-env only) and
 * simply forwards the base64-exact raw body + `Stripe-Signature` to the service's
 * `/webhooks/stripe` via `ctx.http`. Egress is `ctx.http` + `allowedHosts` only.
 * Direct-to-service is preferred; this proxy is the single-origin fallback.
 */
export function createStripeWebhookProxyHandler(): RouteHandler<StripeWebhookProxyInput> {
	return async (routeCtx, ctx): Promise<StripeWebhookProxyResult> => {
		const bodyBase64 = routeCtx.input.bodyBase64;
		if (typeof bodyBase64 !== "string") {
			return { status: 400, body: JSON.stringify({ ok: false, error: "missing bodyBase64" }) };
		}
		const signature = headerCaseInsensitive(routeCtx.request.headers, "stripe-signature");
		const bytes = base64ToBytes(bodyBase64);
		const res = await ctx.http.fetch(`${COMMERCE_SERVICE_BASE_URL}/webhooks/stripe`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(signature === undefined ? {} : { "stripe-signature": signature }),
			},
			body: bytes,
		});
		return { status: res.status, body: await res.text() };
	};
}

/** Decode base64 to bytes without Node `Buffer` (sandbox-safe: `atob` is a
 *  workerd/Node global). Preserves the raw body byte-for-byte. */
function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function headerCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return headers[key];
	}
	return undefined;
}
