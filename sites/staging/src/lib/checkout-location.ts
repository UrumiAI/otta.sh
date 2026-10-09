/**
 * Issue #426: the review's "where" block. A cart that ships, in a store with
 * zones, asks where it goes (the delivery block, ADR-0021). A cart that ships
 * nothing, in a store taxing "based on the customer's billing address", asks
 * where the BUYER is — the same zero-JS block (country + region, Update
 * re-prices the review through the same `?country=&region=` GET), with no
 * delivery options. The place form then echoes the priced location as hidden
 * fields beside a `taxLocation=buyer` marker, and place.ts sends it on as the
 * order's `billingLocation`, so the review and the order are taxed at the same
 * place.
 */
import { shapedDestination } from "./checkout-selection.js";

/** The place form's marker field: this page priced the buyer's location. */
export const TAX_LOCATION_FIELD = "taxLocation";
export const TAX_LOCATION_BUYER = "buyer";

export type LocationBlock = "delivery" | "buyer" | null;

/** Which block the review shows; a locked review (an order exists) shows none. */
export function locationBlock(
	summary: {
		requiresShipping: boolean;
		shipping: { status: string };
		taxByBuyerLocation: boolean;
	},
	locked: boolean,
): LocationBlock {
	if (locked) return null;
	if (summary.requiresShipping) return summary.shipping.status !== "no_zones" ? "delivery" : null;
	return summary.taxByBuyerLocation ? "buyer" : null;
}

/**
 * The place form's echo → the order's `billingLocation`: only on a page that
 * priced the buyer's location (the marker), and only what passes the delivery
 * form's own SHAPE checks — a crafted hidden field is dropped, never sent.
 */
export function billingLocationFromForm(fields: {
	taxLocation?: string | undefined;
	country?: string | undefined;
	region?: string | undefined;
}): { country: string; region?: string } | undefined {
	if (fields.taxLocation !== TAX_LOCATION_BUYER) return undefined;
	const shaped = shapedDestination(fields.country, fields.region);
	if (shaped.country === undefined) return undefined;
	return {
		country: shaped.country,
		...(shaped.region !== undefined ? { region: shaped.region } : {}),
	};
}
