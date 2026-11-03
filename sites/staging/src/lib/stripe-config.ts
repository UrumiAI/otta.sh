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
 *
 * ── Ready means all three values (#499) ───────────────────────────────────
 * A key on a store missing the Stripe secret key or webhook signing secret is
 * `unconfigured` too: the server cannot create or confirm the payment, so
 * offering the pay step would only fail later with a "try again" no retry can
 * fix. The plugin says so as `cardPaymentReady`; an answer without it fails
 * closed. Settings names what is missing.
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
	return result.stripePublishableKey === null || result.cardPaymentReady !== true
		? { state: "unconfigured" }
		: { state: "configured", key: result.stripePublishableKey };
}

/** A payment method checkout can offer (ADR-0044). */
export type CheckoutPaymentMethod = "stripe" | "cod";

/**
 * Which methods checkout offers, from the same one route read (ADR-0044): card
 * only when Stripe is fully set up (#499), cash on delivery only when the
 * merchant switched it on. Each is independent, so a store with only cash on
 * delivery checks out with no Stripe keys. `unavailable` is a failed read —
 * busy, never "nothing is set up".
 */
export type CheckoutPaymentConfig =
	| {
			state: "ok";
			/** The offered methods, card first. Empty ⇒ checkout cannot place. */
			methods: CheckoutPaymentMethod[];
			/** The merchant's cash-on-delivery instructions, or null. */
			codInstructions: string | null;
	  }
	| { state: "unavailable" };

export async function readCheckoutPaymentConfig(
	handler: PublicPluginApiRouteHandler | undefined,
	baseUrl: URL,
): Promise<CheckoutPaymentConfig> {
	const result = await dispatchOttaRoute<PaymentConfigRouteResult>(
		handler,
		STOREFRONT_PAYMENT_CONFIG_ROUTE,
		{},
		baseUrl,
	);
	if (result === null || !result.ok) return { state: "unavailable" };
	const card = result.stripePublishableKey !== null && result.cardPaymentReady === true;
	// A plugin older than ADR-0044 answers no `cashOnDelivery`: card only.
	const cod = result.cashOnDelivery?.enabled === true;
	return {
		state: "ok",
		methods: [...(card ? (["stripe"] as const) : []), ...(cod ? (["cod"] as const) : [])],
		codInstructions: cod ? (result.cashOnDelivery?.instructions ?? null) : null,
	};
}

/** The buyer-facing name of a method, as the checkout and order pages print it. */
export function paymentMethodName(method: string | null): string | null {
	if (method === "stripe") return "Card";
	if (method === "cod") return "Cash on delivery";
	return null;
}
