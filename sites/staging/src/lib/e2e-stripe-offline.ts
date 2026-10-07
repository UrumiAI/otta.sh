/**
 * The SITE half of the dev-only offline Stripe gateway (issue #378).
 *
 * WHY IT EXISTS. The e2e suite's admin Orders specs need PAID orders, and a
 * local or CI stack has no Stripe account. The plugin refuses, correctly, to
 * create an order without a secret key (`packages/plugin/src/payments/
 * stripe-wiring.ts`), so it has one narrow exception: with the build-time define
 * `__OTTA_DEV_STRIPE_OFFLINE__` baked as `true` in a Vite DEV build, a webhook
 * secret alone wires the adapter's existing offline path. That path mints an
 * unpayable handle and makes no network call. The e2e order seed then marks the
 * order paid the way Stripe would, with a signed `payment_intent.succeeded`
 * checked by the production HMAC.
 *
 * THIS MODULE DECIDES THE DEFINE, and it decides it from two things:
 *
 *  - the Astro COMMAND, which only an integration hook can see. The define is
 *    `true` under `astro dev` and nowhere else. `astro build` with the variable
 *    set is REFUSED, not quietly baked `false`: whoever exported it for a build
 *    meant something, and should be told it cannot happen;
 *  - `OTTA_E2E_STRIPE_OFFLINE` set to exactly "1" in the ENVIRONMENT. It is not
 *    read from `.env`, so a line left in a local file cannot arm it. A plain
 *    `astro dev` keeps the fail-closed gateway, so a developer whose store has
 *    no secret key still sees the honest "card payment isn't set up" path.
 *
 * The plugin checks `import.meta.env.DEV` as well, independently, so even a
 * hand-edited config could not arm it in a production bundle.
 */
import type { AstroIntegration } from "astro";

/** The environment variable that asks for the offline gateway under `astro dev`. */
export const E2E_STRIPE_OFFLINE_VAR = "OTTA_E2E_STRIPE_OFFLINE";

/** The define the plugin reads (`stripe-wiring.ts`). Spelled once, here. */
export const DEV_STRIPE_OFFLINE_DEFINE = "__OTTA_DEV_STRIPE_OFFLINE__";

/**
 * Whether to bake the define `true`. Exactly "1" asks; anything else does not.
 * A BUILD that asks throws.
 */
export function resolveDevStripeOffline(command: string, value: string | undefined): boolean {
	const asked = value === "1";
	if (asked && command === "build") {
		throw new Error(
			`${E2E_STRIPE_OFFLINE_VAR}=1 is set for \`astro build\`. The offline Stripe gateway ` +
				`is for \`astro dev\` e2e runs only and can never be part of a built site. Unset ` +
				`it and build again.`,
		);
	}
	return asked && command === "dev";
}

/**
 * The integration that bakes the define. It ALWAYS bakes it, as a JSON
 * boolean: an absent define would leave the identifier undeclared, which the
 * plugin's `typeof` guard tolerates, but the other `__OTTA_*__` defines are
 * always present too and this one follows them.
 *
 * `env` is injectable for the test. The config passes `process.env`.
 */
export function devStripeOfflineIntegration(
	env: Record<string, string | undefined> = process.env,
): AstroIntegration {
	return {
		name: "otta-dev-stripe-offline",
		hooks: {
			"astro:config:setup": ({ command, updateConfig, logger }) => {
				const on = resolveDevStripeOffline(command, env[E2E_STRIPE_OFFLINE_VAR]);
				updateConfig({ vite: { define: { [DEV_STRIPE_OFFLINE_DEFINE]: JSON.stringify(on) } } });
				if (on) {
					logger.warn(
						`${E2E_STRIPE_OFFLINE_VAR}=1: the OFFLINE Stripe gateway is armed. Orders are ` +
							`created without contacting Stripe and can only be paid by a signed test ` +
							`webhook. This is for e2e runs only.`,
					);
				}
			},
		},
	};
}
