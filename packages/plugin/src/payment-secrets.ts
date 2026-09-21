/**
 * The payment/email SECRETS the folded-in commerce layer needs (work order 02,
 * INC-C3), held in WRITE-ONLY plugin kv.
 *
 * WHY THIS MODULE EXISTS. Until the fold-in these values were service
 * environment variables — `wrangler secret put …` entries on a separate Worker.
 * With the service gone there is no second deployable to hold them, so they move
 * to the one operator-provisionable store the plugin has: `ctx.kv`, under the
 * `settings:*` convention — persisted only on a non-empty submit, never rendered
 * back into a block, and read through a fail-closed reader.
 *
 * EVERY KEY IS AN EXISTING SERVICE ENV VAR, RENAMED — nothing here is invented:
 *
 * | kv key                             | service env var           | read at                    |
 * |------------------------------------|---------------------------|----------------------------|
 * | `settings:stripeSecretKey`         | `STRIPE_SECRET_KEY`       | `service/src/stripe-wiring.ts:7`  |
 * | `settings:stripeWebhookSecret`     | `STRIPE_WEBHOOK_SECRET`   | `service/src/stripe-wiring.ts:6`  |
 * | `settings:emailApiKey`             | `EMAIL_API_KEY`           | `service/src/index.ts:79`         |
 * | `settings:x402FacilitatorApiKey`   | `X402_FACILITATOR_SECRET` | `payments/x402-wiring.ts` (†)     |
 *
 * (†) INC-C5 CHANGED WHAT THAT LAST ROW MEANS, SO IT ALSO CHANGED THE KEY — see
 * its own doc below. It is no longer an offline HMAC secret; it is the bearer
 * credential the in-process facilitator call puts on the wire.
 *
 * WHAT IS DELIBERATELY NOT HERE. The service's non-secret companions —
 * `EMAIL_API_URL`, `EMAIL_FROM`, `X402_PAYTO`, `X402_ACCEPTS`,
 * `STOREFRONT_BASE_URL` — are configuration, not credentials. A write-only key
 * is the wrong home for a value an operator has to be able to read back and
 * check, and two of them (`EMAIL_API_URL`, and any future facilitator URL) also
 * have to be known at BUILD time to seed `allowedHosts`, which kv cannot do.
 * They stay outside this module.
 *
 * SANDBOX-CLEAN. No IO, no host import, no `node:` — `ctx.kv` only, which
 * em-dash provides ungated (no capability, no storage declaration).
 */

import type { PluginContext } from "./types.js";

/** `STRIPE_SECRET_KEY` — makes `createIntent` call Stripe's live
 *  `paymentIntents.create` and makes refunds possible. Absent ⇒ the offline,
 *  unpayable client secret (`service/src/stripe-wiring.ts:36-47`). */
export const STRIPE_SECRET_KEY_KEY = "settings:stripeSecretKey";

/** `STRIPE_WEBHOOK_SECRET` — the HMAC signing secret the Stripe webhook edge
 *  verifies a raw body against. **INC-C1b's settle route reads THIS key**; it is
 *  also what enables the Stripe gateway at all in the service today
 *  (`service/src/stripe-wiring.ts:33-35`). */
export const STRIPE_WEBHOOK_SECRET_KEY = "settings:stripeWebhookSecret";

/** `EMAIL_API_KEY` — the bearer credential `HttpEmailSender` attaches
 *  (`service/src/index.ts:79`, `service/src/worker.ts:235-239`). Absent ⇒ the
 *  sender still posts, unauthenticated, which the provider will reject — the
 *  honest failure. */
export const EMAIL_API_KEY_KEY = "settings:emailApiKey";

/**
 * The x402 facilitator CREDENTIAL — the bearer token
 * `createHttpFacilitator` attaches when it asks a real facilitator to verify a
 * receipt (`payments/x402-wiring.ts`).
 *
 * ⚠ ITS MEANING CHANGED AT INC-C5, SO THE KEY MOVED. Under INC-C3
 * `settings:x402FacilitatorSecret` was the in-process rename of the service's
 * `X402_FACILITATOR_SECRET`: the SHARED HMAC secret `createTestFacilitator`
 * signs and verifies with, a value that is never transmitted and whose leak is
 * forge-a-settlement severity. In-process there is no offline facilitator —
 * `createHttpFacilitator` asks a real one over `ctx.http` — so the configured
 * value now GOES ON THE WIRE as `Authorization: Bearer …` to the facilitator
 * host.
 *
 * WHY A NEW KEY AND NOT A RE-DOCUMENTED ONE (review round 2, A5). Re-documenting
 * would have left an operator who provisioned under the INC-C3 meaning holding a
 * forge-a-settlement HMAC secret that this increment would transmit to a third
 * party — a silent downgrade that no release note can undo, because nothing
 * forces the operator to act. A different key name IS the forcing function: the
 * old value is never read again, the field reads as unset, and the settle route
 * answers `NOT_CONFIGURED` until someone provisions a credential that was minted
 * to be sent. The legacy key is deleted opportunistically on the next save of
 * this field (`settings-form.ts`) so the orphaned secret does not linger in kv.
 *
 * The SERVICE's own offline facilitator keeps reading its own
 * `X402_FACILITATOR_SECRET` environment variable, which was never this key.
 */
export const X402_FACILITATOR_API_KEY_KEY = "settings:x402FacilitatorApiKey";

/**
 * The INC-C3 key this replaced. Exported for exactly one purpose: the settings
 * form deletes it when the facilitator credential is next saved. Nothing reads
 * it as a credential, and nothing ever should — see
 * {@link X402_FACILITATOR_API_KEY_KEY}. It is deliberately NOT in
 * {@link PAYMENT_SECRET_KEYS}: that list drives the provisioning form and the
 * no-echo pins, and this key is neither provisioned nor rendered.
 */
export const X402_LEGACY_FACILITATOR_SECRET_KEY = "settings:x402FacilitatorSecret";

/**
 * The shared EDGE token the calling site attaches to a webhook it forwards
 * (`X-Otta-Wh-Token`), checked by `webhooks/stripe/settle` BEFORE it reads any
 * other secret (INC-C1b).
 *
 * THE ONE KEY HERE THAT IS NOT A RENAMED SERVICE ENV VAR, and it is worth being
 * precise about what it is and is not. It is NOT the trust anchor: a forged
 * webhook is stopped by the Stripe HMAC, which the route verifies
 * unconditionally and which no edge token can switch off. This is the cheap
 * outer gate — it lets the route refuse an unattributed request before doing any
 * expensive work, and it is deliberately PASS-THROUGH WHEN UNSET, mirroring
 * `service/src/auth.ts`'s `requireServiceToken` ("token unset ⇒ next()"), so an
 * un-provisioned deploy degrades to "HMAC only" rather than to "nothing works"
 * — and never to "nothing is checked".
 *
 * NAMING. The four keys above are camelCase because each is a service env var
 * transliterated. This one is spelled `settings:otta-wh-token` verbatim at the
 * operator's instruction; it names no env var, so there is nothing to
 * transliterate from. The header it is compared against is `X-Otta-Wh-Token`.
 */
export const WEBHOOK_EDGE_TOKEN_KEY = "settings:otta-wh-token";

/** The request header `webhooks/stripe/settle` compares against
 *  {@link WEBHOOK_EDGE_TOKEN_KEY}. A CUSTOM `X-…` header on purpose: the
 *  host's sandbox sanitizer (`sanitizeHeadersForSandbox`, em-dash
 *  `packages/core/src/plugins/request-meta.ts`) strips a FIXED set — `cookie`,
 *  `set-cookie`, `authorization`, `proxy-authorization`, the three `cf-access-*`
 *  headers and `x-emdash-request` — and a custom `X-…` name is in none of those
 *  families, so it survives into the handler. The settle route's sandbox suite
 *  proves the surviving half end to end on the workerd tier; the host's own
 *  sanitizer is upstream code and is not exercised from this repo. */
export const WEBHOOK_EDGE_TOKEN_HEADER = "X-Otta-Wh-Token";

/**
 * The complete set, in one place, so the Settings provisioning forms and the
 * no-echo test pins are driven from the same list rather than five hand-kept
 * copies. Adding a sixth secret means editing this and nothing else.
 */
export const PAYMENT_SECRET_KEYS = [
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	EMAIL_API_KEY_KEY,
	X402_FACILITATOR_API_KEY_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
] as const;

export type PaymentSecretKey = (typeof PAYMENT_SECRET_KEYS)[number];

/**
 * Read one write-only secret from plugin kv — FAIL-CLOSED, three ways.
 *
 * This is `serviceTokenFromKv`'s shape (`manifest.ts`), generalized over the
 * key, and it fails closed on every path that is not an unambiguous "here is a
 * configured credential":
 *
 *  1. **A rejected read is swallowed to `undefined`.** A kv outage inside a
 *     fire-and-forget hook or a storefront route would otherwise escape as an
 *     uncaught rejection. `undefined` means "not configured", which every
 *     consumer already handles by not wiring that gateway / not sending / not
 *     accepting the signature — a refusal, never an acceptance.
 *  2. **An empty string folds to `undefined`.** `""` is the value a
 *     half-finished provisioning leaves behind, and a downstream
 *     `secret !== undefined` check would read it as configured and then sign or
 *     authenticate with nothing.
 *  3. **A non-string folds to `undefined`.** kv is untyped at runtime; handing a
 *     number or an object on as a credential is worse than absence.
 *
 * NOTHING about the value — not its length, not a prefix — is ever logged or put
 * in an error. The caught error is dropped entirely rather than re-thrown or
 * wrapped, so no message built from a kv driver's own diagnostics (which can
 * echo a value) can escape.
 */
export async function readWriteOnlySecret(
	ctx: PluginContext,
	key: string,
): Promise<string | undefined> {
	try {
		const value = await ctx.kv.get<unknown>(key);
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Every payment/email secret, read together. Each field is `undefined` when
 *  that secret is unset, empty, or unreadable — the three cases a consumer must
 *  treat identically. */
export interface PaymentSecrets {
	stripeSecretKey: string | undefined;
	stripeWebhookSecret: string | undefined;
	emailApiKey: string | undefined;
	x402FacilitatorSecret: string | undefined;
	/** The `X-Otta-Wh-Token` edge token. `undefined` is MEANINGFUL here and only
	 *  here: it means the token gate is off (pass-through), not that the route is
	 *  disabled — see {@link WEBHOOK_EDGE_TOKEN_KEY}. */
	webhookEdgeToken: string | undefined;
}

/**
 * Read all five in one round trip.
 *
 * `Promise.all` over five INDEPENDENTLY fail-closed reads, deliberately: each
 * `readWriteOnlySecret` already absorbs its own rejection, so a Stripe kv blip
 * degrades Stripe and nothing else. Wrapping raw `ctx.kv.get` calls in a single
 * `Promise.all` would instead reject the whole batch and disarm email and x402
 * along with it.
 *
 * NOT used by the settle route, on purpose: that route reads the edge token
 * FIRST and ALONE, and only reads the webhook secret after the token gate has
 * passed (INC-C1b test iii). Batching them here would read both every time.
 */
export async function readPaymentSecrets(ctx: PluginContext): Promise<PaymentSecrets> {
	const [
		stripeSecretKey,
		stripeWebhookSecret,
		emailApiKey,
		x402FacilitatorSecret,
		webhookEdgeToken,
	] = await Promise.all([
		readWriteOnlySecret(ctx, STRIPE_SECRET_KEY_KEY),
		readWriteOnlySecret(ctx, STRIPE_WEBHOOK_SECRET_KEY),
		readWriteOnlySecret(ctx, EMAIL_API_KEY_KEY),
		readWriteOnlySecret(ctx, X402_FACILITATOR_API_KEY_KEY),
		readWriteOnlySecret(ctx, WEBHOOK_EDGE_TOKEN_KEY),
	]);
	return {
		stripeSecretKey,
		stripeWebhookSecret,
		emailApiKey,
		x402FacilitatorSecret,
		webhookEdgeToken,
	};
}

/** The Stripe webhook signing secret, by name — INC-C1b's settle route reads
 *  this rather than reaching for the key constant, so the fail-closed reader is
 *  the only way in. */
export async function stripeWebhookSecretFromKv(ctx: PluginContext): Promise<string | undefined> {
	return readWriteOnlySecret(ctx, STRIPE_WEBHOOK_SECRET_KEY);
}

/** The Stripe API secret key, by name. */
export async function stripeSecretKeyFromKv(ctx: PluginContext): Promise<string | undefined> {
	return readWriteOnlySecret(ctx, STRIPE_SECRET_KEY_KEY);
}

/** The email provider's API key, by name. */
export async function emailApiKeyFromKv(ctx: PluginContext): Promise<string | undefined> {
	return readWriteOnlySecret(ctx, EMAIL_API_KEY_KEY);
}

/** The x402 facilitator's bearer credential, by name (INC-C5 — see
 *  {@link X402_FACILITATOR_API_KEY_KEY} for what this key does and does not mean). */
export async function x402FacilitatorSecretFromKv(ctx: PluginContext): Promise<string | undefined> {
	return readWriteOnlySecret(ctx, X402_FACILITATOR_API_KEY_KEY);
}

/** The `X-Otta-Wh-Token` edge token, by name — the settle route's FIRST read and,
 *  on a rejection, its only one. */
export async function webhookEdgeTokenFromKv(ctx: PluginContext): Promise<string | undefined> {
	return readWriteOnlySecret(ctx, WEBHOOK_EDGE_TOKEN_KEY);
}

/**
 * CONSTANT-TIME string equality, in pure JS.
 *
 * `node:crypto`'s `timingSafeEqual` is unavailable here — the plugin runs inside
 * workerd and `node:*` is banned by the sandbox-clean perimeter — and a plain
 * `===` on a secret is a timing oracle: V8 compares byte by byte and returns at
 * the first difference, so an attacker can recover the token one character at a
 * time from response latency.
 *
 * What this does instead: UTF-8 encode both sides, return early ONLY on a length
 * mismatch (the length is not the secret — an attacker who learns it learns
 * nothing about the bytes, and padding to a common length would compare a
 * fabricated value), then XOR every byte pair into an accumulator across the FULL
 * length with no branch and no early exit. The result is one comparison against
 * zero, so the running time depends on the length alone and never on WHERE the
 * first difference is.
 */
export function constantTimeEquals(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i += 1) {
		// `noUncheckedIndexedAccess` makes these `number | undefined`; the loop
		// bound and the equal-length check above make them always present, and the
		// `?? 0` fallback is branch-free.
		diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return diff === 0;
}
