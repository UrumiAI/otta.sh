/**
 * ADR-0047: the idempotency keys agentic carts are created under.
 *
 * A keyed cart create answers the EXISTING cart to anyone who presents the same
 * key, and a cart id is the bearer credential for every storefront cart route.
 * So a key must be something only this server can compute: an HMAC-SHA-256 under
 * the agentic server key (the same secret the session's `order_secret` and
 * hand-off tokens are derived under), over a fixed purpose label and the write's
 * scope. Never a plain digest of inputs an agent knows (its session id, its own
 * `Idempotency-Key`, its own request body) — that let an agent recompute the key,
 * call the public `cart/create` with it and get the cart id back (#712 review).
 *
 * The public storefront `cart/create` also refuses every `agentic:` key outright
 * ({@link AGENTIC_CART_KEY_PREFIX}), so even a leaked key names nothing there.
 *
 * Retries stay stable (same server key, same inputs, same key). Rotating the
 * server key orphans in-flight keyed carts; their holds expire.
 */
import { base64UrlEncode } from "@urumi.ai/otta-store-emdash";

/** Every agentic cart key starts with this; the storefront refuses it. */
export const AGENTIC_CART_KEY_PREFIX = "agentic:";

/** What a key is for: an agent's create or replace, or the shopper's redeem cart. */
export type AgenticCartKeyKind = "create" | "replace" | "shopper";

const encoder = new TextEncoder();

/**
 * `agentic:<kind>:<base64url HMAC-SHA-256(serverKey, label, kind, parts...)>`.
 * Parts are joined with NUL, so no two part lists collide.
 */
export async function agenticCartKey(
	serverKey: Uint8Array,
	kind: AgenticCartKeyKind,
	parts: readonly string[],
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new Uint8Array(serverKey),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const message = ["otta-agentic-cart-key/v1", kind, ...parts].join("\u0000");
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
	return `${AGENTIC_CART_KEY_PREFIX}${kind}:${base64UrlEncode(new Uint8Array(mac))}`;
}

/** Whether a caller-supplied cart key is in the agentic namespace (refused publicly). */
export function isAgenticCartKey(key: string): boolean {
	return key.startsWith(AGENTIC_CART_KEY_PREFIX);
}
