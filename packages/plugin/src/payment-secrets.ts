/**
 * The payment/email SECRETS the folded-in commerce layer needs (work order 02,
 * INC-C3), held in WRITE-ONLY plugin kv.
 *
 * WHY THIS MODULE EXISTS. Until the fold-in these values were service
 * environment variables — `wrangler secret put …` entries on a separate Worker
 * (`packages/service/wrangler.jsonc`). With the service gone there is no second
 * deployable to hold them, so they move to the one operator-provisionable store
 * the plugin has: `ctx.kv`, under the `settings:*` convention, using exactly the
 * discipline `settings:serviceToken` (ADR-0007) already established — persisted
 * only on a non-empty submit, never rendered back into a block, and read through
 * a fail-closed reader.
 *
 * EVERY KEY IS AN EXISTING SERVICE ENV VAR, RENAMED — nothing here is invented:
 *
 * | kv key                             | service env var           | read at                    |
 * |------------------------------------|---------------------------|----------------------------|
 * | `settings:stripeSecretKey`         | `STRIPE_SECRET_KEY`       | `service/src/stripe-wiring.ts:7`  |
 * | `settings:stripeWebhookSecret`     | `STRIPE_WEBHOOK_SECRET`   | `service/src/stripe-wiring.ts:6`  |
 * | `settings:emailApiKey`             | `EMAIL_API_KEY`           | `service/src/index.ts:79`         |
 * | `settings:x402FacilitatorSecret`   | `X402_FACILITATOR_SECRET` | `service/src/x402-wiring.ts:6`    |
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

/** `X402_FACILITATOR_SECRET` — the shared HMAC secret the x402 facilitator
 *  verification uses (`service/src/x402-wiring.ts:6,31`). The service treats a
 *  leak of this as forge-a-settlement severity and fail-closes around it; the
 *  same value therefore gets the same write-only treatment here. */
export const X402_FACILITATOR_SECRET_KEY = "settings:x402FacilitatorSecret";

/**
 * The complete set, in one place, so the Settings provisioning forms and the
 * no-echo test pins are driven from the same list rather than three hand-kept
 * copies. Adding a fifth secret means editing this and nothing else.
 */
export const PAYMENT_SECRET_KEYS = [
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	EMAIL_API_KEY_KEY,
	X402_FACILITATOR_SECRET_KEY,
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
}

/**
 * Read all four in one round trip.
 *
 * `Promise.all` over four INDEPENDENTLY fail-closed reads, deliberately: each
 * `readWriteOnlySecret` already absorbs its own rejection, so a Stripe kv blip
 * degrades Stripe and nothing else. Wrapping raw `ctx.kv.get` calls in a single
 * `Promise.all` would instead reject the whole batch and disarm email and x402
 * along with it.
 */
export async function readPaymentSecrets(ctx: PluginContext): Promise<PaymentSecrets> {
	const [stripeSecretKey, stripeWebhookSecret, emailApiKey, x402FacilitatorSecret] =
		await Promise.all([
			readWriteOnlySecret(ctx, STRIPE_SECRET_KEY_KEY),
			readWriteOnlySecret(ctx, STRIPE_WEBHOOK_SECRET_KEY),
			readWriteOnlySecret(ctx, EMAIL_API_KEY_KEY),
			readWriteOnlySecret(ctx, X402_FACILITATOR_SECRET_KEY),
		]);
	return { stripeSecretKey, stripeWebhookSecret, emailApiKey, x402FacilitatorSecret };
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

/** The x402 facilitator's shared secret, by name. */
export async function x402FacilitatorSecretFromKv(ctx: PluginContext): Promise<string | undefined> {
	return readWriteOnlySecret(ctx, X402_FACILITATOR_SECRET_KEY);
}
