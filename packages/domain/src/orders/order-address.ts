/**
 * Checkout shipping-address capture (ADR-0009). The command-side input shape a
 * checkout submits, plus the domain validator that turns it into the frozen
 * {@link OrderAddress} snapshot written onto the order.
 *
 * The snapshotted value is **whatever checkout submitted** (the Shopify model) —
 * a logged-in checkout MAY prefill the form from a saved profile `Address`, but
 * that is a client convenience; the order copies the *submitted* value, never a
 * live pointer to the profile row. Validation here is shape-only (required fields
 * present + non-empty, bounded lengths). It deliberately does NOT enforce
 * required-for-physical — per ADR-0009's sequencing that enforcement flips only
 * once the storefront UI collects the address, so this slice ships
 * capture-optional.
 */

import type { OrderAddress } from "./model.js";

/**
 * The optional shipping address a checkout submits. Required fields
 * (`name`/`line1`/`city`/`postalCode`/`country`) must be present and non-empty;
 * `line2`/`region`/`email`/`phone` are optional (absent or `null` ⇒ stored
 * `null`). The domain trims every value and enforces the bounds in
 * {@link ORDER_ADDRESS_MAX_LENGTHS}.
 */
export interface OrderAddressInput {
	name: string;
	line1: string;
	line2?: string | null;
	city: string;
	region?: string | null;
	postalCode: string;
	country: string;
	email?: string | null;
	phone?: string | null;
}

/** Per-field max lengths (post-trim), enforced by {@link normalizeOrderAddress}.
 *  Generous but bounded — the address is record data at rest, not a pricing input,
 *  so the bounds only exist to keep garbage out of the store (mirrors the service
 *  zod bounds; the domain is the authoritative guard). */
export const ORDER_ADDRESS_MAX_LENGTHS = {
	name: 200,
	line1: 200,
	line2: 200,
	city: 120,
	region: 120,
	postalCode: 32,
	country: 100,
	email: 320,
	phone: 64,
} as const;

/** A required field (post-trim) that came back empty, or any field that exceeded
 *  its bound, fails normalization. */
export type NormalizeOrderAddressResult = { ok: true; value: OrderAddress } | { ok: false };

/** Trim + null a value; empty-after-trim becomes `null`. */
function trimToNull(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/**
 * Validate + normalize a submitted {@link OrderAddressInput} into the frozen
 * {@link OrderAddress} snapshot. Trims every field; a required field empty after
 * trimming, or any field longer than its {@link ORDER_ADDRESS_MAX_LENGTHS} bound,
 * is rejected (`ok:false`). Optional fields normalize to `null` when absent/empty.
 * Pure — no IO — so the use-case can validate before minting anything.
 */
export function normalizeOrderAddress(input: OrderAddressInput): NormalizeOrderAddressResult {
	const name = trimToNull(input.name);
	const line1 = trimToNull(input.line1);
	const city = trimToNull(input.city);
	const postalCode = trimToNull(input.postalCode);
	const country = trimToNull(input.country);
	// Required fields must survive trimming.
	if (name === null || line1 === null || city === null || postalCode === null || country === null) {
		return { ok: false };
	}
	const line2 = trimToNull(input.line2);
	const region = trimToNull(input.region);
	const email = trimToNull(input.email);
	const phone = trimToNull(input.phone);
	const value: OrderAddress = {
		name,
		line1,
		line2,
		city,
		region,
		postalCode,
		country,
		email,
		phone,
	};
	// Bounds — every present field within its cap (a null optional is unbounded).
	const overLength =
		name.length > ORDER_ADDRESS_MAX_LENGTHS.name ||
		line1.length > ORDER_ADDRESS_MAX_LENGTHS.line1 ||
		(line2 !== null && line2.length > ORDER_ADDRESS_MAX_LENGTHS.line2) ||
		city.length > ORDER_ADDRESS_MAX_LENGTHS.city ||
		(region !== null && region.length > ORDER_ADDRESS_MAX_LENGTHS.region) ||
		postalCode.length > ORDER_ADDRESS_MAX_LENGTHS.postalCode ||
		country.length > ORDER_ADDRESS_MAX_LENGTHS.country ||
		(email !== null && email.length > ORDER_ADDRESS_MAX_LENGTHS.email) ||
		(phone !== null && phone.length > ORDER_ADDRESS_MAX_LENGTHS.phone);
	if (overLength) return { ok: false };
	return { ok: true, value };
}
