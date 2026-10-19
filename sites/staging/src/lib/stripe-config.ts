/**
 * The Stripe publishable key, read PER REQUEST from the plugin (ADR-0012
 * decision 4, as amended by issue #498).
 *
 * It used to be baked into the bundle at build time (`STRIPE_PUBLIC_KEY`), so a
 * store operator with only the admin could not turn card payments on. It is now
 * a Settings value beside the two Stripe secrets, and the checkout pages ask the
 * plugin for it (`storefront/payment-config`).
 *
 * ── Three answers, not two ────────────────────────────────────────────────
 * "No key" is a real, supported state — a store that has not connected Stripe:
 * the pages say "Card payment isn't set up on this store yet." and create NO
 * order. A read that FAILED (storage busy, a render fault) is not that state, and
 * must not be shown as it: telling a buyer of a working store that it takes no
 * cards is the silent degrade the old build check existed to prevent. So a failed
 * read is `unavailable`, and each page answers it as busy.
 *
 * A stored value that is not a `pk_…` key reads as no key (the plugin refuses it
 * on save, and fails closed on read), and Settings says why.
 */
import {
	STOREFRONT_PAYMENT_CONFIG_ROUTE,
	type PaymentConfigRouteResult,
} from "@urumi.ai/otta-plugin";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { dispatchOttaRoute } from "./otta-api.js";

export type StripeKeyRead =
	| { state: "configured"; key: string }
	| { state: "unconfigured" }
	| { state: "unavailable" };

/** Ask the plugin for the store's publishable key. Never throws. */
export async function readStripePublishableKey(
	handler: PublicPluginApiRouteHandler | undefined,
	baseUrl: URL,
): Promise<StripeKeyRead> {
	const result = await dispatchOttaRoute<PaymentConfigRouteResult>(
		handler,
		STOREFRONT_PAYMENT_CONFIG_ROUTE,
		{},
		baseUrl,
	);
	if (result === null || !result.ok) return { state: "unavailable" };
	return result.stripePublishableKey === null
		? { state: "unconfigured" }
		: { state: "configured", key: result.stripePublishableKey };
}
