/**
 * What the account's order pages offer beyond the receipt (QA round 2).
 *
 * X1 — the account's order page offers what the PUBLIC order page offers for the
 * same order: "Complete payment" for a pending order that can still be paid (the
 * same page-owned resume path, `/checkout/resume`, which the owning session
 * proves), the tracking once it shipped, the delivery address (this page is
 * private; the public one never shows it), and a link to the order's own page.
 *
 * A2 — two orders of the same thing on the same day read alike in the list, so a
 * row also carries the time it was placed, to the minute, beside its item summary.
 * No part of the order id is ever shown to a shopper (the store owner's rule).
 *
 * Kept here rather than in the pages because `.astro` files have no render harness
 * in this package (issue #40).
 */
import type { AccountOrderWire } from "@otta-sh/plugin";
import { resumeHref } from "./checkout-resume.js";
import { countryOptions } from "./countries.js";
import { isOrderPayable } from "./pay-guard.js";
import { SITE_LOCALE } from "./site-locale.js";

export interface AccountOrderExtras {
	/** The resume path, for a pending order that can still be paid; else `null`. */
	payHref: string | null;
	/** The order's own (public) page. */
	orderPageHref: string;
	tracking: { carrier: string; trackingNumber: string; trackingUrl: string | null } | null;
	/** The ship-to as display lines, or `null` when the order has none. */
	addressLines: string[] | null;
	/** What the address is called: "Billing address" on an order that ships
	 *  nothing (an India-based Stripe account takes one for every order — issue
	 *  #382), "Delivery address" otherwise. */
	addressLabel: "Delivery address" | "Billing address";
}

/** Only an http(s) address is ever a link: a tracking URL is typed by an
 *  operator, and a `javascript:` one must not become a clickable script. */
export function trackingHref(raw: string | null): string | null {
	if (raw === null) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
}

let countryNames: Map<string, string> | null = null;
function countryName(code: string): string {
	countryNames ??= new Map(countryOptions(SITE_LOCALE).map((c) => [c.code, c.label]));
	return countryNames.get(code) ?? code;
}

export function accountOrderExtras(
	order: Pick<
		AccountOrderWire,
		"id" | "state" | "holdExpiresAt" | "fulfillment" | "shippingAddress" | "lines"
	>,
	now: Date,
): AccountOrderExtras {
	const address = order.shippingAddress;
	return {
		payHref: isOrderPayable(order, now) ? resumeHref(order.id) : null,
		orderPageHref: `/orders/${encodeURIComponent(order.id)}`,
		tracking:
			order.fulfillment === null
				? null
				: {
						carrier: order.fulfillment.carrier,
						trackingNumber: order.fulfillment.trackingNumber,
						trackingUrl: trackingHref(order.fulfillment.trackingUrl),
					},
		addressLabel:
			order.lines.length > 0 && order.lines.every((line) => line.fulfillmentKind === "digital")
				? "Billing address"
				: "Delivery address",
		addressLines:
			address === null
				? null
				: [
						address.name,
						address.line1,
						...(address.line2 !== null ? [address.line2] : []),
						[address.city, address.region, address.postalCode]
							.filter((part): part is string => part !== null && part.length > 0)
							.join(" "),
						countryName(address.country),
					],
	};
}

const PLACED_AT = new Intl.DateTimeFormat(SITE_LOCALE, {
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
});

/** When an order was placed, to the minute and in UTC (like every other time
 *  this server renders), with the instant for `<time datetime>`; `null` for an
 *  unreadable date. */
export function orderPlacedAt(iso: string): { text: string; iso: string } | null {
	const instant = Date.parse(iso);
	if (!Number.isFinite(instant)) return null;
	return { text: `${PLACED_AT.format(instant)} UTC`, iso };
}
