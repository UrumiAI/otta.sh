/**
 * Resuming a pending order's payment from its order page (QA U-2) — the
 * page-owned path the order page hands its theme, and what the resume endpoint
 * does with the plugin's answer.
 *
 * WHY NOT `/checkout`. "Complete payment" used to link to the review page, which
 * rebuilds the payment step from the CART cookie: on another device, or once the
 * cookie had rotated, it was a dead end; and where it worked, the locked review
 * showed an empty, editable email the replayed order silently ignored.
 *
 * WHAT AUTHORISES A RESUME: the order id PLUS a second factor. The id is a
 * bearer link that sits in mailboxes and histories, and the client secret a
 * resume hands out can read the order's ship-to back from Stripe, so the plugin
 * also wants one of: the cart the order was made from (this browser's cart
 * cookie), a session whose customer owns the order (the session cookie), or the
 * order's email, typed again on `/checkout/resume/email` (compared server-side,
 * guesses throttled per order). The plugin's `storefront/order/resume` answers
 * only for a `pending` order before its hold deadline, with that order's OWN
 * PaymentIntent (the original checkout replayed on its own key): no second
 * order, no second intent. The email is shown on the pay page only as a hint
 * (`j•••@g•••.com`).
 *
 * Like `pay-guard.ts`, the logic lives here because `.astro` and endpoint files
 * have no render harness in this package.
 */
import type { OrderResumeRouteResult, OrderRouteResult } from "@otta-sh/plugin";
import {
	checkoutStashTotal,
	type CheckoutStash,
	type CookieReader,
	type CookieWriter,
} from "./checkout-cookie.js";
import { isOrderPayable } from "./pay-guard.js";

export const RESUME_PATH = "/checkout/resume";

/** The order page's "Complete payment" target. */
export function resumeHref(orderId: string): string {
	return `${RESUME_PATH}?order=${encodeURIComponent(orderId)}`;
}

/** The small private page that asks for the order's email (the second factor
 *  on a device with neither the order's cart nor its owner's session). */
export const RESUME_EMAIL_PATH = "/checkout/resume/email";

/** The tokens that page explains — one generic sentence each, no more. */
export const RESUME_EMAIL_ERRORS: ReadonlySet<string> = new Set(["EMAIL_MISMATCH", "THROTTLED"]);

/**
 * This browser's RESUME KEY (issue #364): an opaque random id the email page gives
 * a browser once, sent with each email attempt as `clientKey`. Not a proof — the
 * plugin uses it only to throttle email guesses per DEVICE of an order (5 per 15
 * minutes) as well as per order (20), so a stranger holding the order link who
 * spends five wrong guesses no longer locks the real buyer out. A browser without
 * one (cookies blocked or cleared) shares the order's no-device window.
 * httpOnly, `SameSite=Strict` (the POST comes from our own page), `/checkout` only.
 */
export const RESUME_CLIENT_COOKIE_NAME = "otta_resume_client";
const RESUME_CLIENT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const RESUME_CLIENT_PATTERN = /^[0-9a-f-]{36}$/;

/** The resume key this site wrote, or undefined (absent, or not one of ours). */
export function readResumeClientKey(cookies: CookieReader): string | undefined {
	const value = cookies.get(RESUME_CLIENT_COOKIE_NAME)?.value;
	return value !== undefined && RESUME_CLIENT_PATTERN.test(value) ? value : undefined;
}

/** This browser's resume key, minting and setting one the first time. */
export function ensureResumeClientKey(cookies: CookieReader & CookieWriter): string {
	const existing = readResumeClientKey(cookies);
	if (existing !== undefined) return existing;
	const minted = crypto.randomUUID();
	cookies.set(RESUME_CLIENT_COOKIE_NAME, minted, {
		httpOnly: true,
		secure: true,
		sameSite: "strict",
		path: "/checkout",
		maxAge: RESUME_CLIENT_MAX_AGE_SECONDS,
	});
	return minted;
}

export function resumeEmailPath(orderId: string, error?: string): string {
	const query = new URLSearchParams({ order: orderId });
	if (error !== undefined && RESUME_EMAIL_ERRORS.has(error)) query.set("error", error);
	return `${RESUME_EMAIL_PATH}?${query.toString()}`;
}

export function orderPathFor(orderId: string): string {
	return `/orders/${encodeURIComponent(orderId)}`;
}

/** Failures the ORDER page explains beside the order (its own `?error=`). Every
 *  other refusal is the order's state, which that page already states. */
export const ORDER_PAGE_RESUME_ERRORS: ReadonlySet<string> = new Set([
	"PAYMENT_INTENT_FAILED",
	"SERVICE_UNAVAILABLE",
]);

export type ResumeOutcome =
	/** Stash this and go to the pay page. */
	| { kind: "pay"; stash: CheckoutStash }
	/** Go to the order page (which says why there is nothing to pay here), or to
	 *  the email page when the plugin wants the second factor. */
	| { kind: "order"; path: string };

/**
 * The plugin's answer → where the buyer goes. BUSY is the caller's (a 503 with
 * Retry-After), never mapped here.
 */
export function resumeOutcome(
	orderId: string,
	result: OrderResumeRouteResult | null,
): ResumeOutcome {
	const orderPath = orderPathFor(orderId);
	if (result === null) return { kind: "order", path: `${orderPath}?error=SERVICE_UNAVAILABLE` };
	if (!result.ok) {
		const reason = "reason" in result ? result.reason : undefined;
		if (reason === "PROOF_REQUIRED") return { kind: "order", path: resumeEmailPath(orderId) };
		if (reason !== undefined && RESUME_EMAIL_ERRORS.has(reason)) {
			return { kind: "order", path: resumeEmailPath(orderId, reason) };
		}
		return reason !== undefined && ORDER_PAGE_RESUME_ERRORS.has(reason)
			? { kind: "order", path: `${orderPath}?error=${reason}` }
			: { kind: "order", path: orderPath };
	}
	if (
		result.clientAction.kind !== "stripe_client_secret" ||
		result.clientAction.clientSecret.length === 0 ||
		result.orderId.length === 0
	) {
		return { kind: "order", path: orderPath };
	}
	const stash: CheckoutStash = {
		orderId: result.orderId,
		clientSecret: result.clientAction.clientSecret,
	};
	const total = checkoutStashTotal(result.total);
	if (total !== undefined) stash.total = total;
	if (typeof result.buyerRefHint === "string" && result.buyerRefHint.length > 0) {
		stash.emailHint = result.buyerRefHint;
	}
	return { kind: "pay", stash };
}

/**
 * A navigation another SITE started (a link or a form on someone else's page)
 * — `Sec-Fetch-Site: cross-site`. The resume endpoint answers it with the order
 * page rather than a pay page: a GET that writes the checkout stash must not be
 * something another site can make a browser do. Absent (older browsers, curl)
 * is not refused: the stash it writes is for an order the requester already
 * names by its capability.
 */
export function isCrossSiteNavigation(request: Request): boolean {
	return request.headers.get("sec-fetch-site") === "cross-site";
}

/**
 * What `/checkout/resume/email` shows for the order in its URL (QA2 N7), from the
 * same public order read the order page makes:
 *  - `not_found` — a DEFINITIVE "no such order": the order page's 404 and its
 *    sentence, and no email form (asking for an email for an order that does not
 *    exist is a dead end, and the order page already answers this id with a 404);
 *  - `order_page` — the order exists but cannot be paid now (not pending, or past
 *    its hold): its own page says why;
 *  - `form` — a payable order, OR an unanswered read (busy, unreachable): the
 *    resume itself re-checks everything, so a hiccup here costs nothing.
 */
export function resumeEmailGate(
	result: OrderRouteResult | null,
	now: Date,
): "not_found" | "order_page" | "form" {
	if (result === null) return "form";
	if (!result.ok)
		return "reason" in result && result.reason === "ORDER_NOT_FOUND" ? "not_found" : "form";
	return isOrderPayable(result.order, now) ? "form" : "order_page";
}
