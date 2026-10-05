/**
 * The SECOND FACTOR for resuming an order's payment (QA U-2).
 *
 * The order id is a bearer link that sits in mailboxes and browser histories,
 * and the PaymentIntent's client secret a resume hands out can read the order's
 * ship-to back from Stripe. So the id alone is not enough: the caller must also
 * hold the cart the order was made from, a session whose customer owns the
 * order, or the order's email.
 *
 * The email is compared here, server-side: trimmed and case-folded on both sides
 * (the address a buyer types back is the one they typed, give or take case), as
 * SHA-256 digests compared byte by byte without an early exit — so the time the
 * comparison takes says nothing about how much of a guess was right. Guesses are
 * throttled by the sign-in throttle's own slot window (`EmdashAttemptThrottle`),
 * twice (issue #364, ADR-0012 amended 2026-10-05):
 *  - per DEVICE of an order — `RESUME_EMAIL_MAX_ATTEMPTS` per
 *    `RESUME_EMAIL_WINDOW_MS`, keyed by the site's per-browser resume cookie
 *    (`clientKey`), so a stranger's five wrong guesses no longer lock the real
 *    buyer out; requests naming no device share one window per order;
 *  - per ORDER — `RESUME_EMAIL_ORDER_MAX_ATTEMPTS` per window from any devices,
 *    so guessing from many browsers (or with cookies cleared) is still stopped.
 */
export type { ResumeProof } from "../product-commerce/commerce-client.js";

/** Email guesses one device may make on one order per window. */
export const RESUME_EMAIL_MAX_ATTEMPTS = 5;
/** Email guesses one order takes per window, from every device together. */
export const RESUME_EMAIL_ORDER_MAX_ATTEMPTS = 20;
export const RESUME_EMAIL_WINDOW_MS = 15 * 60 * 1000;

/** The throttle key for one order's email guesses, from every device. (The same
 *  key the per-order window has always used, so live windows carry over.) */
export function resumeThrottleKey(orderId: string): string {
	return `resume:${orderId}`;
}

/** The throttle key for one device's email guesses on one order. A request that
 *  names no device shares the order's `-` window. */
export function resumeDeviceThrottleKey(orderId: string, clientKey: string | undefined): string {
	return `resume-device:${orderId}:${clientKey ?? "-"}`;
}

function fold(value: string): string {
	return value.trim().toLowerCase();
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Is `typed` the order's `buyerRef`? Never true for a blank `typed`. */
export async function emailMatchesBuyer(typed: string, buyerRef: string): Promise<boolean> {
	const a = fold(typed);
	if (a.length === 0) return false;
	const [x, y] = await Promise.all([digest(a), digest(fold(buyerRef))]);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}
