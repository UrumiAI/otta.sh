import type { Clock } from "@urumi/domain";
import { StripePaymentGateway } from "@urumi/payments-stripe";

/** The Stripe slice of the service env (mirrors `X402Env`). */
export interface StripeEnv {
	STRIPE_WEBHOOK_SECRET?: string | undefined;
	STRIPE_SECRET_KEY?: string | undefined;
}

/**
 * Wire the Stripe gateway from env — and WARN, never throw.
 *
 * `STRIPE_WEBHOOK_SECRET` is what enables Stripe at all (unset ⇒ no gateway,
 * `POST /webhooks/stripe` answers 503). `STRIPE_SECRET_KEY` is now
 * **behaviour-changing, not decorative**: with it, `createIntent` performs a real
 * `paymentIntents.create` (and refunds are possible — `refundable:true`); without
 * it, `createIntent` mints the OFFLINE deterministic handle whose client secret
 * is a fake string no Stripe.js/Elements can ever pay.
 *
 * A deployment with the webhook secret but NO secret key therefore hands buyers
 * unpayable client secrets — the exact inverse hazard of the live path, and worth
 * a loud boot warning. It is **only** a warning: staging and every e2e
 * environment run without a secret key, and must keep booting. (Contrast
 * `wireX402Gateway`, which DOES fail closed — there the hazard is a forgeable
 * settlement, not a checkout that simply cannot be completed.)
 *
 * @returns the gateway, or `undefined` when Stripe is simply not configured.
 */
export function wireStripeGateway(
	env: StripeEnv,
	options: { clock?: Clock } = {},
): StripePaymentGateway | undefined {
	const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
	if (webhookSecret === undefined || webhookSecret.length === 0) {
		return undefined; // Stripe not configured — nothing to wire.
	}
	const secretKey =
		env.STRIPE_SECRET_KEY !== undefined && env.STRIPE_SECRET_KEY.length > 0
			? env.STRIPE_SECRET_KEY
			: undefined;
	if (secretKey === undefined) {
		console.warn(
			"[service] ⚠ STRIPE_WEBHOOK_SECRET is set but STRIPE_SECRET_KEY is NOT: createIntent " +
				"mints OFFLINE, UNPAYABLE client secrets (and refunds are unavailable). Dev/test/e2e " +
				"only — set STRIPE_SECRET_KEY to create real PaymentIntents.",
		);
	}
	return new StripePaymentGateway({
		webhookSecret,
		...(secretKey !== undefined ? { secretKey } : {}),
		...(options.clock !== undefined ? { clock: options.clock } : {}),
	});
}
