/**
 * Issue #498 — the Stripe PUBLISHABLE key, a runtime setting (ADR-0012 as
 * amended). It used to be baked into the site at build time, so an operator with
 * only the admin could not turn card payments on. It now lives in plugin kv,
 * entered on the Store settings page (General tab) beside the two Stripe secrets.
 *
 * NOT A SECRET. It is sent to every buyer's browser, so it is stored and read
 * back in plain text (the Store settings form prefills it) and is not declared
 * `type: "secret"`.
 *
 * FAIL-CLOSED ON SHAPE. A stored value that is not a `pk_test_…` / `pk_live_…`
 * key (saved outside these settings, or before the check) reads as NO key: the
 * storefront then says card payment isn't set up and creates no order, rather
 * than hand Stripe.js a value it throws on.
 */
import { checkStripePublishableKey } from "../payment-secret-shapes.js";
import type { PluginContext } from "../types.js";

export const STRIPE_PUBLISHABLE_KEY_KEY = "settings:stripePublishableKey";

/** The usable stored key, or `undefined`. A kv failure propagates: the caller
 *  decides whether that is "busy" or "not set up". */
export async function readStripePublishableKey(ctx: PluginContext): Promise<string | undefined> {
	const stored = await ctx.kv.get<unknown>(STRIPE_PUBLISHABLE_KEY_KEY);
	if (typeof stored !== "string" || stored.trim() === "") return undefined;
	const checked = checkStripePublishableKey(stored);
	return checked.ok ? checked.value : undefined;
}
