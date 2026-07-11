import { type Cents, cents } from "../money/cents.js";
import type { ShippingMethodSnapshot } from "./types.js";

/**
 * Resolve the shipping fee for the selected method (Phase 6 §4), pure.
 *
 * - `flat_rate`: the configured `amountCents`, unconditionally.
 * - `free_shipping`: `0` once `discountedSubtotal` meets `minSubtotalCents`
 *   (or when there is no threshold); otherwise the below-threshold fallback
 *   `amountCents` (0 for a strictly-free method).
 *
 * The free-shipping threshold is evaluated against the **discounted** subtotal
 * (post-coupon) — a genuine judgment call flagged in §8 risk #5: the customer's
 * free-shipping benefit reflects what they actually spend.
 */
export function resolveShippingRate(
	method: ShippingMethodSnapshot,
	discountedSubtotalCents: Cents,
): Cents {
	if (method.type === "flat_rate") {
		return method.amountCents;
	}
	// free_shipping
	const meetsThreshold =
		method.minSubtotalCents === null || discountedSubtotalCents >= method.minSubtotalCents;
	return meetsThreshold ? cents(0) : method.amountCents;
}
