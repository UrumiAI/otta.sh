/**
 * Issue #499 — is card payment READY on this store? One answer, used by the
 * checkout pages (`storefront/payment-config`), the place route and Settings.
 *
 * Card checkout needs three Stripe values, and each must be present and usable:
 *
 *  - the PUBLISHABLE key (`pk_…`), which Stripe.js is initialised with;
 *  - the SECRET key (`sk_…`/`rk_…`), which creates the PaymentIntent;
 *  - the WEBHOOK SIGNING secret (`whsec_…`), which verifies the confirmation.
 *
 * Before this, `/checkout` decided from the publishable key alone, while the
 * server armed the gateway only with both secrets (`stripe-wiring.ts`). A store
 * with one secret missing looked ready to the buyer and failed at "Continue to
 * payment" with a generic retry message that no retry could fix.
 *
 * The secret-key half follows the gateway exactly, including its one dev-only
 * exception: with the offline e2e arm on (`devStripeOfflineEnabled`), the webhook
 * secret alone is a gateway, so it is ready here too. And a publishable key from
 * the other Stripe mode than the secret key (test vs live) is not ready: Stripe.js
 * cannot confirm an intent the other mode created.
 *
 * SECURITY: the answer names which values are missing, never any part of one.
 */
import { stripeKeyMode, stripePublishableKeyMode } from "../payment-secret-shapes.js";
import { stripeSecretKeyFromKv, stripeWebhookSecretFromKv } from "../payment-secrets.js";
import type { PluginContext } from "../types.js";
import { readStripePublishableKey } from "./stripe-publishable-key.js";
import { devStripeOfflineEnabled } from "./stripe-wiring.js";

/** The values card checkout needs, as the operator reads them in Settings. */
export type CardPaymentValue = "publishable key" | "secret key" | "webhook signing secret";

export type CardPaymentReadiness =
	| { ready: true }
	| {
			ready: false;
			/** In Settings order. Empty only when {@link mixedModes} is the reason. */
			missing: CardPaymentValue[];
			/** Both keys are there, but one is test and the other live. */
			mixedModes: boolean;
	  };

/** What is known about each value — facts about it, never the value. */
export interface CardPaymentFacts {
	/** The usable stored publishable key's mode, or `undefined` when there is none. */
	publishableMode: "test" | "live" | undefined;
	/** A usable secret key is stored. */
	secretKeySet: boolean;
	/** Its mode, when its prefix says (`undefined` for a restricted key). */
	secretKeyMode?: "test" | "live" | undefined;
	/** A usable webhook signing secret is stored. */
	webhookSecretSet: boolean;
}

/** The pure decision, shared so Settings and checkout cannot disagree. */
export function cardPaymentReadiness(facts: CardPaymentFacts): CardPaymentReadiness {
	return gatewayAndKey(facts, true);
}

/** The gateway half alone (both secrets, or the offline arm) — what the place
 *  route needs: the publishable key is the browser's, not the server's. */
export function stripeGatewayReadiness(
	facts: Omit<CardPaymentFacts, "publishableMode">,
): CardPaymentReadiness {
	return gatewayAndKey({ ...facts, publishableMode: undefined }, false);
}

function gatewayAndKey(facts: CardPaymentFacts, withPublishable: boolean): CardPaymentReadiness {
	const missing: CardPaymentValue[] = [];
	if (withPublishable && facts.publishableMode === undefined) missing.push("publishable key");
	if (!facts.secretKeySet && !devStripeOfflineEnabled()) missing.push("secret key");
	if (!facts.webhookSecretSet) missing.push("webhook signing secret");
	const mixedModes =
		withPublishable &&
		facts.publishableMode !== undefined &&
		facts.secretKeyMode !== undefined &&
		facts.publishableMode !== facts.secretKeyMode;
	return missing.length === 0 && !mixedModes
		? { ready: true }
		: { ready: false, missing, mixedModes };
}

async function readSecretFacts(
	ctx: PluginContext,
): Promise<Omit<CardPaymentFacts, "publishableMode">> {
	// The gateway's own fail-closed readers: unset, unreadable and malformed are
	// all "not there", exactly as `stripeGatewayFromCtx` sees them.
	const [secretKey, webhookSecret] = await Promise.all([
		stripeSecretKeyFromKv(ctx),
		stripeWebhookSecretFromKv(ctx),
	]);
	return {
		secretKeySet: secretKey !== undefined,
		secretKeyMode: secretKey !== undefined ? stripeKeyMode(secretKey) : undefined,
		webhookSecretSet: webhookSecret !== undefined,
	};
}

/**
 * Read the full readiness and the usable publishable key. A kv failure on the
 * publishable key PROPAGATES (the caller answers busy, never "not set up"); the
 * secrets fail closed, like the gateway.
 */
export async function readCardPaymentReadiness(
	ctx: PluginContext,
): Promise<{ readiness: CardPaymentReadiness; publishableKey: string | undefined }> {
	const [publishableKey, secrets] = await Promise.all([
		readStripePublishableKey(ctx),
		readSecretFacts(ctx),
	]);
	const publishableMode =
		publishableKey !== undefined ? stripePublishableKeyMode(publishableKey) : undefined;
	return { readiness: cardPaymentReadiness({ ...secrets, publishableMode }), publishableKey };
}

/** Read whether a Stripe gateway can be armed (the secrets, not the browser key). */
export async function readStripeGatewayReadiness(
	ctx: PluginContext,
): Promise<CardPaymentReadiness> {
	return stripeGatewayReadiness(await readSecretFacts(ctx));
}

/** The one Settings line. Within the nested-context budget (200). */
export function cardPaymentsLine(readiness: CardPaymentReadiness): string {
	if (readiness.ready) return "Card payments: ready.";
	if (readiness.missing.length > 0) {
		return `Card payments: not ready (missing: ${readiness.missing.join(", ")}).`;
	}
	return "Card payments: not ready (the publishable and secret keys are from different Stripe modes).";
}

/** The one operator-facing log line for a place refused for want of a gateway.
 *  Names what is missing and where to save it; never a value. */
export function cardPaymentsNotReadyLog(route: string, readiness: CardPaymentReadiness): string {
	const what = readiness.ready ? "" : ` (missing: ${readiness.missing.join(", ")})`;
	return `[otta] ${route}: card payment refused, Stripe is not set up${what}. Save it in Otta → Store settings → General.`;
}
