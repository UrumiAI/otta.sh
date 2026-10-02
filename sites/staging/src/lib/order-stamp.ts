/**
 * The confirmation page's state stamp — the order's own state → what we are
 * willing to say about it (ADR-0012 decision 5: the page claims only the order's
 * state, never what Stripe's redirect reported).
 *
 * These are the page's OWN sentences, moved here from `orders/[orderId].astro` so
 * the honesty rules are unit-tested rather than eyeballed (`.astro` has no render
 * harness, issue #40). One of them had become a lie: an expired order always said
 * "Nothing was charged", including when a payment arrived after the hold lapsed
 * and Stripe captured it. That sentence now follows `latePayment` — derived by the
 * plugin from the order's payments and refunds ledgers, never from the URL.
 */
import type { PublicOrderView } from "@otta-sh/plugin";

export interface StateCopy {
	/** The stamp's headline — the largest type on the page. */
	headline: string;
	/** What it means and what happens next. */
	body: string | null;
}

export interface OrderStampInput {
	/** The order's state, or `null` when there is no order to describe. */
	state: string | null;
	latePayment: PublicOrderView["latePayment"];
	/** Did the buyer arrive via Stripe's redirect? Picks the pending copy only. */
	returnedFromStripe: boolean;
	/** A `pending` order whose hold deadline has passed (`isOrderPayable` false) —
	 *  the sweep will expire it on its next tick; the pay page already refuses it. */
	holdLapsed: boolean;
	/** Is the page's bounded poll still running? Only then may it say it
	 *  refreshes itself (QA U-13). */
	polling: boolean;
}

const EXPIRED_LEAD = "Payment didn't complete in time, so the items went back on sale.";

/** The two sentences a late payment earns, by the state that refused it. */
function latePaymentSentence(
	verb: "expired" | "was cancelled" | "failed",
	latePayment: PublicOrderView["latePayment"],
): string | null {
	if (latePayment === "refunded") {
		return `A payment arrived after this order ${verb}, so we've refunded it — it can take 5–10 days to appear.`;
	}
	if (latePayment === "refund_pending") {
		// Captured and not (yet) back: never "nothing was charged", and never
		// "refunded" before the ledger says so. Nor "automatically": the refund may be
		// a person's job (a gateway that cannot refund, a refusal the provider gave),
		// and the wire deliberately does not say which — so the page promises only
		// THAT it will be refunded.
		return `A payment arrived after this order ${verb}. It will be refunded — once it is, it can take 5–10 days to appear.`;
	}
	return null;
}

const FAILED: StateCopy = {
	headline: "The payment did not go through.",
	body: "No charge was made.",
};
const EXPIRED: StateCopy = {
	headline: "This order expired.",
	body: `${EXPIRED_LEAD} Nothing was charged.`,
};

const COPY: Record<string, StateCopy> = {
	paid: { headline: "Order confirmed.", body: "Thank you — we've received your payment." },
	failed: FAILED,
	expired: EXPIRED,
	cancelled: { headline: "This order was cancelled.", body: null },
	refunded: { headline: "This order has been refunded.", body: null },
};

export function orderStamp(input: OrderStampInput): StateCopy | null {
	const { state, latePayment } = input;
	if (state === null) return null;

	if (state === "pending") {
		if (input.returnedFromStripe) {
			// Even past the hold: the buyer just paid, and a pending order still
			// settles. The page polls; the state decides.
			return {
				headline: "Payment submitted.",
				body: input.polling
					? "We're confirming it with our payment provider — this usually takes a few seconds. This page refreshes automatically."
					: "We're confirming it with our payment provider — this is taking longer than usual. Check again in a minute.",
			};
		}
		if (input.holdLapsed) {
			// The pay page refuses this order, so "awaiting payment" with a resume link
			// would walk the buyer round a loop. But the order is STILL pending — its
			// stock has not gone back on sale yet, and a payment made a moment ago may
			// still settle it — so this says only what is certain, and what happens if
			// money does arrive: that it is refunded, never "automatically" (on some
			// paths a person does it). No poll runs in this state (a buyer who just
			// paid arrives from Stripe, and gets the copy above), so the page offers
			// "Check again" rather than promising to update itself.
			return {
				headline: "The time to pay has run out.",
				body: "If you already paid, check again in a minute — if the order has expired by then, your payment will be refunded.",
			};
		}
		return { headline: "This order is awaiting payment.", body: null };
	}

	if (state === "expired") {
		const late = latePaymentSentence("expired", latePayment);
		return late === null
			? EXPIRED
			: { headline: EXPIRED.headline, body: `${EXPIRED_LEAD} ${late}` };
	}
	if (state === "cancelled") {
		return {
			headline: "This order was cancelled.",
			body: latePaymentSentence("was cancelled", latePayment),
		};
	}
	if (state === "failed") {
		const late = latePaymentSentence("failed", latePayment);
		return late === null ? FAILED : { headline: FAILED.headline, body: late };
	}
	return COPY[state] ?? { headline: `Order status: ${state}.`, body: null };
}
